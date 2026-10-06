import type { WSContext } from "hono/ws";
import type { EventStore, PendingReply, Presence } from "../eventStore.ts";
import {
  DaemonFrame,
  type DaemonReply,
  HookSource,
  SETTINGS_RELAY_TIMEOUT_MS,
  type Sealed,
  type ServerFrame,
} from "../protocol.ts";

/** A relayed settings request could not reach the machine's daemon, or it did not answer in time. */
export class SettingsRelayError extends Error {
  override name = "SettingsRelayError";
  readonly code: "machine_offline" | "machine_timeout" | "duplicate_request";

  constructor(code: SettingsRelayError["code"]) {
    super(code);
    this.code = code;
  }
}

interface PendingSettings {
  machineId: string;
  resolve: (sealed: Sealed) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  ws: WSContext;
  /** Replies already handed to this connection; a reconnect gets every open one again. */
  sent: Set<string>;
}

/**
 * The server side of `/v1/daemon`: one WebSocket per machine, opened by its outbrief-daemon (the
 * machine never accepts inbound connections). Hands the machine its open replies on connect and
 * new ones as they are queued, and records the results the daemon reports back.
 *
 * Presence is per process, like the event stream fan-out: run one server instance.
 */
export class DaemonGateway implements Presence {
  readonly #store: EventStore;
  readonly #connections = new Map<string, Connection>();
  readonly #settings = new Map<string, PendingSettings>();

  constructor(store: EventStore) {
    this.#store = store;
  }

  isOnline(machineId: string): boolean {
    return this.#connections.has(machineId);
  }

  /** A daemon connected. A newer connection of the same machine replaces the older one. */
  async open(machine: { id: string; name: string }, ws: WSContext): Promise<void> {
    const previous = this.#connections.get(machine.id);
    const conn: Connection = { ws, sent: new Set() };
    this.#connections.set(machine.id, conn);
    previous?.ws.close(4000, "replaced by a newer connection");
    send(ws, { type: "hello", machineId: machine.id, machineName: machine.name });
    await this.#store.announceMachine(machine.id);
    await this.flush(machine.id);
  }

  /** The connection closed; only drops presence if it is still the machine's current one. */
  async close(machineId: string, ws: WSContext): Promise<void> {
    if (this.#connections.get(machineId)?.ws !== ws) return;
    this.#connections.delete(machineId);
    this.#failSettings(machineId);
    await this.#store.announceMachine(machineId);
  }

  /** Handles one frame from the machine's daemon. Malformed frames are ignored. */
  async message(machineId: string, ws: WSContext, data: unknown): Promise<void> {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (frame.type === "settings-result") {
      const pending = this.#settings.get(frame.requestId);
      // Only the machine that was asked may answer.
      if (!pending || pending.machineId !== machineId) return;
      this.#settings.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.resolve(frame.sealed);
      return;
    }
    await this.#store.settleReply(
      frame.replyId,
      machineId,
      frame.status,
      frame.error ?? null,
      new Date(),
      frame.commentId ?? null,
    );
  }

  /**
   * Hands the machine every open reply it has not been sent on its current connection, and marks
   * each `dispatched`. No-op while the machine is offline: the replies stay `queued`.
   */
  async flush(machineId: string): Promise<void> {
    const conn = this.#connections.get(machineId);
    if (!conn) return;
    for (const reply of await this.#store.listOpenReplies(machineId)) {
      if (conn.sent.has(reply.id)) continue;
      const frame = toDaemonReply(reply);
      if (!frame) {
        await this.#store.settleReply(
          reply.id,
          machineId,
          "failed",
          `不支持回复 ${reply.source} 会话`,
        );
        continue;
      }
      // The connection may have been replaced or closed while the list was read.
      if (this.#connections.get(machineId) !== conn) return;
      conn.sent.add(reply.id);
      send(conn.ws, { type: "reply", reply: frame });
      await this.#store.markDispatched(reply.id);
    }
  }

  /**
   * Hands a sealed settings request from an app to the machine's daemon and resolves with its
   * sealed answer. The server can read neither; it only matches them up by request id.
   */
  requestSettings(
    machineId: string,
    requestId: string,
    sealed: Sealed,
    timeoutMs = SETTINGS_RELAY_TIMEOUT_MS,
  ): Promise<Sealed> {
    const conn = this.#connections.get(machineId);
    if (!conn) return Promise.reject(new SettingsRelayError("machine_offline"));
    if (this.#settings.has(requestId))
      return Promise.reject(new SettingsRelayError("duplicate_request"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settings.delete(requestId);
        reject(new SettingsRelayError("machine_timeout"));
      }, timeoutMs);
      this.#settings.set(requestId, {
        machineId,
        resolve,
        reject,
        timer,
      });
      send(conn.ws, { type: "settings", requestId, sealed });
    });
  }

  /** Drops the machine's connection (its token was revoked). */
  disconnect(machineId: string): void {
    const conn = this.#connections.get(machineId);
    if (!conn) return;
    this.#connections.delete(machineId);
    this.#failSettings(machineId);
    conn.ws.close(4001, "machine token revoked");
  }

  /** Closes every daemon connection (server shutdown). */
  closeAll(): void {
    for (const conn of this.#connections.values()) conn.ws.close(1001, "server shutting down");
    for (const machineId of this.#connections.keys()) this.#failSettings(machineId);
    this.#connections.clear();
  }

  /** The machine went away: its unanswered settings requests fail now instead of timing out. */
  #failSettings(machineId: string): void {
    for (const [requestId, pending] of this.#settings) {
      if (pending.machineId !== machineId) continue;
      this.#settings.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new SettingsRelayError("machine_offline"));
    }
  }
}

/**
 * A Multica reply is posted as a comment; any other reply resumes a hook-reported session. The
 * daemon opens the sealed reply to learn which session or comment.
 */
function toDaemonReply(reply: PendingReply): DaemonReply | null {
  if (reply.source !== "multica" && !HookSource.safeParse(reply.source).success) return null;
  return { id: reply.id, eventId: reply.eventId, source: reply.source, sealed: reply.sealed };
}

function parseFrame(data: unknown): DaemonFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = DaemonFrame.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function send(ws: WSContext, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}
