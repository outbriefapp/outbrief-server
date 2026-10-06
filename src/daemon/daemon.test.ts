import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { migrate } from "../db/migrate.ts";
import { openPool } from "../db/pool.ts";
import { resetTables, testDatabaseUrl } from "../db/testDatabase.ts";
import type { EventStore } from "../eventStore.ts";
import type { AgentEvent, DaemonReply, Device, DeviceSession } from "../protocol.ts";
import { sealed } from "../testing/sealed.ts";
import { buildServer, join, signup } from "../testing/server.ts";
import type { DaemonGateway } from "./gateway.ts";

/** The app device of the account every test runs in. */
let TOKEN: string;

let pool: Pool;
let store: EventStore;
let gateway: DaemonGateway;
let server: ServerType;
let baseUrl: string;
beforeAll(async () => {
  const url = testDatabaseUrl();
  await migrate(url);
  pool = openPool(url);
});
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetTables(pool);
  let app: ReturnType<typeof buildServer>["app"];
  ({ app, store, gateway } = buildServer(pool));
  server = serve({
    fetch: app.fetch,
    port: 0,
    websocket: { server: new WebSocketServer({ noServer: true }) },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  TOKEN = (await signup(fetchPath)).token;
});

function fetchPath(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}
afterEach(async () => {
  gateway.closeAll();
  server.close();
  store.close();
});

function api(path: string, init: RequestInit = {}, bearer: string = TOKEN): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  });
}

/** A daemon joins the test account with a pairing code (`outbrief-daemon login <code>`). */
function pair(name = "mac-mini", bearer: string = TOKEN): Promise<DeviceSession> {
  return join(fetchPath, bearer, { name, kind: "daemon" });
}

async function relay(machineToken: string): Promise<AgentEvent> {
  const resp = await api(
    "/v1/daemon/events",
    {
      method: "POST",
      body: JSON.stringify({ source: "claude-code", sealed: sealed("report") }),
    },
    machineToken,
  );
  expect(resp.status).toBe(201);
  return (await resp.json()) as AgentEvent;
}

async function reply(eventId: string, text = sealed("继续")): Promise<Response> {
  return api(`/v1/events/${eventId}/reply`, {
    method: "POST",
    body: JSON.stringify({ sealed: text }),
  });
}

async function event(id: string): Promise<AgentEvent> {
  const [found] = (
    (await (await api("/v1/events")).json()) as { events: AgentEvent[] }
  ).events.filter((e) => e.id === id);
  if (!found) throw new Error(`event ${id} not pending`);
  return found;
}
/** A fake outbrief-daemon connection that records every frame the server sends. */
class FakeDaemon {
  readonly frames: { type: string; reply?: DaemonReply }[] = [];
  readonly ws: WebSocket;
  #waiters: (() => void)[] = [];

  constructor(token: string) {
    this.ws = new WebSocket(`${baseUrl.replace("http", "ws")}/v1/daemon`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.ws.onmessage = (msg) => {
      this.frames.push(JSON.parse(String(msg.data)));
      for (const wake of this.#waiters.splice(0)) wake();
    };
  }

  replies(): DaemonReply[] {
    return this.frames.flatMap((f) => (f.type === "reply" && f.reply ? [f.reply] : []));
  }

  /** Resolves once `predicate` holds, re-checking after every frame. */
  async until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for daemon frames");
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.onclose = () => resolve();
      this.ws.close();
    });
  }
}

/** Polls until the event's delivery reaches `status` (settling runs after the frame arrives). */
async function waitForDelivery(id: string, status: string): Promise<AgentEvent> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const current = await event(id);
    if (current.delivery?.status === status) return current;
    if (Date.now() > deadline) throw new Error(`delivery stuck at ${current.delivery?.status}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
describe("machine tokens", () => {
  it("authenticates the daemon API with the machine token only, and revokes it", async () => {
    const machine = await pair();
    expect(machine.token).toMatch(/^obm_/);
    // An app token is not a machine token.
    expect((await api("/v1/daemon/events", { method: "POST", body: "{}" })).status).toBe(401);
    const relayed = await relay(machine.token);
    expect(relayed.machine).toMatchObject({ id: machine.device.id, name: "mac-mini" });

    expect((await api(`/v1/devices/${machine.device.id}`, { method: "DELETE" })).status).toBe(204);
    const after = await api("/v1/daemon/events", { method: "POST", body: "{}" }, machine.token);
    expect(after.status).toBe(401);
    const list = (await (await api("/v1/devices")).json()) as { devices: Device[] };
    expect(list.devices.map((d) => d.kind)).toEqual(["app"]);
  });

  it("refuses a WebSocket without a valid machine token", async () => {
    const daemon = new FakeDaemon("obm_nope");
    const closed = await new Promise<boolean>((resolve) => {
      daemon.ws.onerror = () => resolve(true);
      daemon.ws.onopen = () => resolve(false);
    });
    expect(closed).toBe(true);
  });
});
describe("reply delivery", () => {
  it("dispatches to an online daemon and records its result", async () => {
    const machine = await pair();
    const relayed = await relay(machine.token);
    const daemon = new FakeDaemon(machine.token);
    await daemon.until(() => daemon.frames.some((f) => f.type === "hello"));
    expect((await event(relayed.id)).machine?.online).toBe(true);

    const resp = await reply(relayed.id, sealed("把测试也补上"));
    expect(resp.status).toBe(200);
    await daemon.until(() => daemon.replies().length === 1);
    expect(daemon.replies()[0]).toEqual({
      id: expect.any(String),
      eventId: relayed.id,
      source: "claude-code",
      sealed: sealed("把测试也补上"),
    });
    const replyId = daemon.replies()[0]?.id;
    expect((await waitForDelivery(relayed.id, "dispatched")).delivery?.id).toBe(replyId);

    daemon.send({ type: "result", replyId, status: "delivered" });
    const settled = await waitForDelivery(relayed.id, "delivered");
    expect(settled.delivery?.settledAt).not.toBeNull();
    // The server does not keep the sealed reply once it settled; the app has its own copy.
    expect(settled.delivery).not.toHaveProperty("content");
    expect(await sealedReplies()).toEqual([""]);
    // A second reply to the same event is refused: one reply per call.
    expect((await reply(relayed.id)).status).toBe(409);
    await daemon.close();
  });

  it("queues while the machine is offline and sends once it connects", async () => {
    const machine = await pair();
    const relayed = await relay(machine.token);
    const resp = await reply(relayed.id);
    const queued = (await resp.json()) as AgentEvent;
    expect(queued.delivery?.status).toBe("queued");
    expect(queued.machine?.online).toBe(false);

    const daemon = new FakeDaemon(machine.token);
    await daemon.until(() => daemon.replies().length === 1);
    await waitForDelivery(relayed.id, "dispatched");
    await daemon.close();
  });
  it("re-sends a dispatched reply after a reconnect until a result arrives, then settles once", async () => {
    const machine = await pair();
    const relayed = await relay(machine.token);
    const first = new FakeDaemon(machine.token);
    await first.until(() => first.frames.some((f) => f.type === "hello"));
    await reply(relayed.id);
    await first.until(() => first.replies().length === 1);
    await first.close();

    const second = new FakeDaemon(machine.token);
    await second.until(() => second.replies().length === 1);
    const replyId = second.replies()[0]?.id;
    expect(replyId).toBe(first.replies()[0]?.id);
    // The daemon seals its reason; the server stores it as it came.
    second.send({ type: "result", replyId, status: "failed", error: sealed("session not found") });
    const failed = await waitForDelivery(relayed.id, "failed");
    expect(failed.delivery?.error).toBe(sealed("session not found"));
    // A late duplicate result does not overwrite the settled one.
    second.send({ type: "result", replyId, status: "delivered" });
    await new Promise((r) => setTimeout(r, 100));
    expect((await event(relayed.id)).delivery?.status).toBe("failed");
    await second.close();
  });

  it("still routes a reply after the call ended and its report was erased", async () => {
    const machine = await pair();
    const relayed = await relay(machine.token);
    const ended = await api(`/v1/events/${relayed.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "completed" }),
    });
    expect(await ended.json()).toMatchObject({ status: "completed", sealed: null });

    const daemon = new FakeDaemon(machine.token);
    expect((await reply(relayed.id, sealed("再跑一遍测试"))).status).toBe(200);
    await daemon.until(() => daemon.replies().length === 1);
    expect(daemon.replies()[0]).toMatchObject({ sealed: sealed("再跑一遍测试") });
    await daemon.close();
  });

  it("fails replies still queued past their expiry", async () => {
    const machine = await pair();
    const relayed = await relay(machine.token);
    await reply(relayed.id);
    expect(await store.expireReplies(new Date(Date.now() + 25 * 60 * 60 * 1000))).toBe(1);
    const expired = await event(relayed.id);
    expect(expired.delivery).toMatchObject({ status: "failed" });
    expect(expired.delivery?.error).toMatch(/过期/);
    expect(await sealedReplies()).toEqual([""]);
  });

  it("refuses events with no return path", async () => {
    const plain = await (
      await api("/v1/events", {
        method: "POST",
        body: JSON.stringify({ source: "codex", sealed: sealed("report") }),
      })
    ).json();
    const resp = await reply((plain as AgentEvent).id);
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: "no_return_path" });
  });
});

describe("Multica reports", () => {
  const REPORT = { taskId: "task-1", sealed: sealed("YOUT-7 修复登录跳转") };

  async function report(machineToken: string, body: unknown = REPORT): Promise<Response> {
    return api(
      "/v1/daemon/multica-reports",
      { method: "POST", body: JSON.stringify(body) },
      machineToken,
    );
  }

  it("makes one call per task, tied to the machine that read it", async () => {
    const machine = await pair();
    const other = await pair("laptop");
    const first = await report(machine.token);
    expect(first.status).toBe(201);
    const created = (await first.json()) as AgentEvent;
    expect(created).toMatchObject({
      source: "multica",
      sealed: REPORT.sealed,
      machine: { id: machine.device.id },
      multica: { taskId: "task-1", reply: null },
    });
    // The same task seen by another machine in the workspace: no second call.
    const again = await report(other.token);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "duplicate_task" });
    expect((await report(machine.token, { ...REPORT, sealed: "plain text" })).status).toBe(400);
    expect((await report(TOKEN)).status).toBe(401);
  });

  it("hands the sealed reply to the reporting daemon, which posts it and reports the comment id", async () => {
    const machine = await pair();
    const created = (await (await report(machine.token)).json()) as AgentEvent;
    const daemon = new FakeDaemon(machine.token);
    await daemon.until(() => daemon.frames.some((f) => f.type === "hello"));

    expect((await reply(created.id, sealed("删掉旧接口"))).status).toBe(200);
    await daemon.until(() => daemon.replies().length === 1);
    const sent = daemon.replies()[0];
    expect(sent).toMatchObject({
      eventId: created.id,
      source: "multica",
      sealed: sealed("删掉旧接口"),
    });

    daemon.send({ type: "result", replyId: sent?.id, status: "delivered", commentId: "reply-1" });
    const settled = await waitForDelivery(created.id, "delivered");
    expect(settled.multica?.reply).toEqual({ commentId: "reply-1", sentAt: expect.any(String) });
    expect((await reply(created.id)).status).toBe(409);
    await daemon.close();
  });

  it("keeps a failed Multica post unrecorded", async () => {
    const machine = await pair();
    const created = (await (await report(machine.token)).json()) as AgentEvent;
    const daemon = new FakeDaemon(machine.token);
    await reply(created.id);
    await daemon.until(() => daemon.replies().length === 1);
    const replyId = daemon.replies()[0]?.id;
    daemon.send({ type: "result", replyId, status: "failed", error: sealed("HTTP 403 forbidden") });
    const failed = await waitForDelivery(created.id, "failed");
    expect(failed.delivery?.error).toBe(sealed("HTTP 403 forbidden"));
    expect(failed.multica?.reply).toBeNull();
    await daemon.close();
  });
});

/** Every stored sealed reply (emptied once settled). */
async function sealedReplies(): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT sealed FROM daemon_replies");
  return rows.map((r) => r.sealed as string);
}

describe("settings relay", () => {
  function ask(machineId: string, requestId = crypto.randomUUID()): Promise<Response> {
    return api(`/v1/devices/${machineId}/settings`, {
      method: "POST",
      body: JSON.stringify({ requestId, sealed: sealed(`settings ${requestId}`) }),
    });
  }

  it("hands a sealed request to the daemon and returns its sealed answer", async () => {
    const machine = await pair();
    const daemon = new FakeDaemon(machine.token);
    await daemon.until(() => daemon.frames.some((f) => f.type === "hello"));

    const requestId = crypto.randomUUID();
    const answered = ask(machine.device.id, requestId);
    await daemon.until(() => daemon.frames.some((f) => f.type === "settings"));
    expect(daemon.frames.find((f) => f.type === "settings")).toEqual({
      type: "settings",
      requestId,
      sealed: sealed(`settings ${requestId}`),
    });
    // Another machine cannot answer for it.
    const other = await pair("other-box");
    const impostor = new FakeDaemon(other.token);
    await impostor.until(() => impostor.frames.some((f) => f.type === "hello"));
    impostor.send({ type: "settings-result", requestId, sealed: sealed("forged") });

    daemon.send({ type: "settings-result", requestId, sealed: sealed("answer") });
    const res = await answered;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sealed: sealed("answer") });
    await Promise.all([daemon.close(), impostor.close()]);
  });

  it("fails at once when the machine is offline or goes away", async () => {
    const machine = await pair();
    const offline = await ask(machine.device.id);
    expect(offline.status).toBe(409);
    expect(await offline.json()).toEqual({ error: "machine_offline" });

    const daemon = new FakeDaemon(machine.token);
    await daemon.until(() => daemon.frames.some((f) => f.type === "hello"));
    const pending = ask(machine.device.id);
    await daemon.until(() => daemon.frames.some((f) => f.type === "settings"));
    await daemon.close();
    expect((await pending).status).toBe(409);
  });

  it("only relays to daemons: an app device has no settings", async () => {
    const devices = (await (await api("/v1/devices")).json()) as { devices: Device[] };
    const app = devices.devices.find((d) => d.kind === "app");
    expect((await ask(app?.id ?? "")).status).toBe(404);
  });
});
