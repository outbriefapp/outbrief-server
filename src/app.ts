import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { UpgradeWebSocket } from "hono/ws";
import { type AccountStore, SignupError } from "./accounts/accounts.ts";
import type { AuthDevice, DevicePresence, DeviceStore } from "./accounts/devices.ts";
import type { PairingStore } from "./accounts/pairing.ts";
import { RateLimiter } from "./accounts/rateLimit.ts";
import { type DaemonGateway, SettingsRelayError } from "./daemon/gateway.ts";
import type { EventStore } from "./eventStore.ts";
import {
  type AgentEvent,
  CreateAccountInput,
  DELIVERY_EVENT_NAME,
  MulticaReportInput,
  PairingCodeText,
  RedeemPairingInput,
  ReportSubmission,
  SendReplyInput,
  SettingsRelayInput,
  STREAM_EVENT_NAME,
  UpdateEventStatusInput,
} from "./protocol.ts";

export interface AppDeps {
  store: EventStore;
  /** Anonymous accounts, their devices and pairing codes (YOUT-217). */
  accounts: AccountDeps;
  heartbeatMs?: number;
  /** outbrief-daemon support: live daemon connections and the WebSocket adapter. */
  daemon: DaemonDeps;
  /** Overrides for tests; the defaults suit a server on the internet. */
  limits?: Partial<Limits>;
}

export interface AccountDeps {
  accounts: AccountStore;
  devices: DeviceStore;
  pairing: PairingStore;
}

export interface DaemonDeps {
  gateway: DaemonGateway;
  /** `@hono/node-server`'s `upgradeWebSocket` in production. */
  upgradeWebSocket: UpgradeWebSocket;
}

export interface Limits {
  /** New accounts when signup is open (public cloud). */
  signup: RateLimiter;
  /** Wrong pairing / claim codes: 6 digits must not be guessable. */
  guesses: RateLimiter;
}

function defaultLimits(): Limits {
  return {
    signup: new RateLimiter({ limit: 20, globalLimit: 500, windowMs: 60 * 60_000 }),
    guesses: new RateLimiter({ limit: 10, globalLimit: 200, windowMs: 10 * 60_000 }),
  };
}

type Env = { Variables: { device: AuthDevice } };

/** Paths under `/v1` that need no bearer: creating an account and joining one. */
const PUBLIC_PATHS = new Set(["/v1/server", "/v1/accounts", "/v1/pairing/redeem"]);

function parseSeq(raw: string | undefined): number {
  const n = Number(raw ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function bearerFrom(c: Context): string | undefined {
  return c.req
    .header("Authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
}

/**
 * Who is asking, for rate limits: the address the nearest proxy saw (the last `X-Forwarded-For`
 * hop), else the socket's peer.
 */
function clientKey(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // `app.request()` in tests has no socket.
    return "unknown";
  }
}

/** Open event streams per device: an app is online while it holds one; revoking closes them. */
class StreamRegistry {
  readonly #streams = new Map<string, Set<() => void>>();

  add(deviceId: string, close: () => void): () => void {
    let set = this.#streams.get(deviceId);
    if (!set) {
      set = new Set();
      this.#streams.set(deviceId, set);
    }
    set.add(close);
    return () => {
      set.delete(close);
      if (!set.size && this.#streams.get(deviceId) === set) this.#streams.delete(deviceId);
    };
  }

  has(deviceId: string): boolean {
    return this.#streams.has(deviceId);
  }

  closeAll(deviceId: string): void {
    for (const close of this.#streams.get(deviceId) ?? []) close();
  }
}

export function createApp({
  store,
  accounts: { accounts, devices, pairing },
  heartbeatMs = 25_000,
  daemon,
  limits: limitOverrides,
}: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const limits = { ...defaultLimits(), ...limitOverrides };
  const streams = new StreamRegistry();
  const presence: DevicePresence = {
    isOnline: (id) => daemon.gateway.isOnline(id) || streams.has(id),
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Bearer tokens (no cookies) → any origin is safe; Tauri webviews use custom origins per platform.
  app.use(
    "/v1/*",
    cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Last-Event-ID"] }),
  );

  // --- No bearer: creating an account, joining one ---------------------------------------------

  /** Whether this server takes new accounts, needs its claim code, or only pairing codes. */
  app.get("/v1/server", async (c) => c.json({ signup: await accounts.signupMode() }));

  /**
   * Creates an anonymous account and its first device. Open signup is rate limited per address;
   * an unclaimed private server needs the claim code from its log, and wrong ones count as guesses.
   */
  app.post("/v1/accounts", async (c) => {
    const parsed = CreateAccountInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_account", issues: parsed.error.issues }, 400);
    }
    const who = clientKey(c);
    const mode = await accounts.signupMode();
    const limiter = mode === "open" ? limits.signup : limits.guesses;
    if (!limiter.allows(who)) return c.json({ error: "rate_limited" }, 429);
    try {
      const session = await accounts.create(parsed.data.device, parsed.data.claimCode);
      if (mode === "open") limits.signup.hit(who);
      return c.json(session, 201);
    } catch (err) {
      if (!(err instanceof SignupError)) throw err;
      if (err.code === "invalid_claim_code") limits.guesses.hit(who);
      return c.json({ error: err.code }, 403);
    }
  });

  /** Joins the account of a pairing code as a new device. Misses count as guesses. */
  app.post("/v1/pairing/redeem", async (c) => {
    const parsed = RedeemPairingInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_pairing", issues: parsed.error.issues }, 400);
    }
    const who = clientKey(c);
    if (!limits.guesses.allows(who)) return c.json({ error: "rate_limited" }, 429);
    const session = await pairing.redeem(parsed.data.code, parsed.data.device);
    if (!session) {
      limits.guesses.hit(who);
      return c.json({ error: "invalid_pairing_code" }, 404);
    }
    return c.json(session, 201);
  });

  // --- outbrief-daemon's own API: a daemon device's token -------------------------------------

  const daemonApi = new Hono<Env>();
  daemonApi.use("*", async (c, next) => {
    const bearer = bearerFrom(c);
    const device = bearer ? await devices.authenticate(bearer) : undefined;
    if (device?.kind !== "daemon") return c.json({ error: "invalid_machine_token" }, 401);
    c.set("device", device);
    await next();
  });

  /** The daemon relays a local agent's sealed report (with its brief); tied to this machine. */
  daemonApi.post("/events", async (c) => {
    const parsed = ReportSubmission.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_event", issues: parsed.error.issues }, 400);
    }
    const machine = c.get("device");
    return c.json(await store.append(machine.accountId, parsed.data, new Date(), machine.id), 201);
  });

  /**
   * A finished Multica task, read by the daemon with the user's own Multica token and sealed with
   * its brief. The reply goes back to this machine, whose daemon posts it; 409 when the task already
   * has a call in this account.
   */
  daemonApi.post("/multica-reports", async (c) => {
    const parsed = MulticaReportInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_multica_report", issues: parsed.error.issues }, 400);
    }
    const { taskId, ...report } = parsed.data;
    const machine = c.get("device");
    const event = await store.appendMulticaReport(machine.accountId, taskId, report, machine.id);
    if (!event) return c.json({ error: "duplicate_task" }, 409);
    return c.json(event, 201);
  });

  daemonApi.get(
    "/",
    daemon.upgradeWebSocket((c) => {
      const { id, name } = c.get("device");
      const machine = { id, name };
      return {
        onOpen: (_evt, ws) => void daemon.gateway.open(machine, ws).catch(logDaemonError),
        onMessage: (evt, ws) =>
          void daemon.gateway.message(machine.id, ws, evt.data).catch(logDaemonError),
        onClose: (_evt, ws) => void daemon.gateway.close(machine.id, ws).catch(logDaemonError),
      };
    }),
  );
  app.route("/v1/daemon", daemonApi);

  // --- Everything else: any device's token, scoped to its account ------------------------------

  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/daemon") || PUBLIC_PATHS.has(c.req.path)) return next();
    const bearer = bearerFrom(c);
    const device = bearer ? await devices.authenticate(bearer) : undefined;
    if (!device) return c.json({ error: "unauthorized" }, 401);
    c.set("device", device);
    return next();
  });

  /** The account and device the bearer belongs to (also: "is my token still valid?"). */
  app.get("/v1/me", async (c) => {
    const me = c.get("device");
    const device = await devices.get(me.accountId, me.id, presence, me.id);
    if (!device) return c.json({ error: "unauthorized" }, 401);
    return c.json({ accountId: me.accountId, device });
  });

  /** A one-time code (10 minutes) that lets another device join this account. */
  app.post("/v1/pairing", async (c) => {
    const me = c.get("device");
    return c.json(await pairing.create(me.accountId, me.id), 201);
  });

  /** Whether the code was used yet; the device showing it waits for this. */
  app.get("/v1/pairing/:code", async (c) => {
    const code = c.req.param("code");
    const status = PairingCodeText.safeParse(code).success
      ? await pairing.status(c.get("device").accountId, code)
      : undefined;
    return status ? c.json(status) : c.json({ error: "not_found" }, 404);
  });

  app.get("/v1/devices", async (c) => {
    const me = c.get("device");
    return c.json({ devices: await devices.list(me.accountId, presence, me.id) });
  });

  /** Removes a device of this account: its token stops working and its connections close. */
  app.delete("/v1/devices/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await devices.revoke(c.get("device").accountId, id))) {
      return c.json({ error: "not_found" }, 404);
    }
    daemon.gateway.disconnect(id);
    streams.closeAll(id);
    return c.body(null, 204);
  });

  /**
   * A sealed settings request for one of this account's daemons (a phone has no local daemon to
   * ask). Relayed over the daemon's WebSocket; its sealed answer comes back as the response.
   */
  app.post("/v1/devices/:id/settings", async (c) => {
    const parsed = SettingsRelayInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_settings_request", issues: parsed.error.issues }, 400);
    }
    const me = c.get("device");
    const target = await devices.get(me.accountId, c.req.param("id"), presence, me.id);
    if (target?.kind !== "daemon") return c.json({ error: "not_found" }, 404);
    try {
      const sealed = await daemon.gateway.requestSettings(
        target.id,
        parsed.data.requestId,
        parsed.data.sealed,
      );
      return c.json({ sealed });
    } catch (err) {
      if (!(err instanceof SettingsRelayError)) throw err;
      return c.json({ error: err.code }, err.code === "machine_timeout" ? 504 : 409);
    }
  });

  /** A sealed report (with its brief) from a device of the account; delivered at once. */
  app.post("/v1/events", async (c) => {
    const parsed = ReportSubmission.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_event", issues: parsed.error.issues }, 400);
    }
    return c.json(await store.append(c.get("device").accountId, parsed.data), 201);
  });

  /** Polling fallback: the account's pending events after `?after=<seq>`. */
  app.get("/v1/events", async (c) =>
    c.json({
      events: await store.listPending(c.get("device").accountId, parseSeq(c.req.query("after"))),
    }),
  );

  app.post("/v1/events/:id/status", async (c) => {
    const parsed = UpdateEventStatusInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_status", issues: parsed.error.issues }, 400);
    }
    const event = await store.setOutcome(
      c.get("device").accountId,
      c.req.param("id"),
      parsed.data.status,
    );
    return event ? c.json(event) : c.json({ error: "not_found" }, 404);
  });

  /**
   * Queues the user's sealed reply for the machine whose daemon reported the call. That daemon opens
   * it and resumes the agent session, or for a Multica report posts it as a comment with its own
   * Multica token (the server never holds one). One reply per call.
   */
  app.post("/v1/events/:id/reply", async (c) => {
    const parsed = SendReplyInput.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_reply", issues: parsed.error.issues }, 400);
    }
    const accountId = c.get("device").accountId;
    const event = await store.get(c.req.param("id"), accountId);
    if (!event) return c.json({ error: "not_found" }, 404);
    if (!event.machine) return c.json({ error: "no_return_path" }, 409);
    if (event.multica?.reply) return c.json({ error: "already_replied" }, 409);
    const queued = await store.enqueueReply(event, parsed.data.sealed);
    if (!queued) return c.json({ error: "already_replied" }, 409);
    await daemon.gateway.flush(event.machine.id);
    return c.json((await store.get(event.id, accountId)) ?? queued);
  });

  /**
   * Live stream of the account's deliverable events. Replays pending events after `Last-Event-ID` /
   * `?after`, then pushes new ones. Subscribes before replaying and holds live events back until the
   * replay is queued, so nothing stored in between is lost or reordered. Removing the device closes
   * its streams.
   */
  app.get("/v1/stream", (c) => {
    const after = parseSeq(c.req.header("Last-Event-ID") ?? c.req.query("after"));
    const me = c.get("device");
    return streamSSE(c, async (stream) => {
      const unregister = streams.add(me.id, () => stream.abort());
      stream.onAbort(unregister);
      let lastSent = after;
      let chain = Promise.resolve();
      const send = (event: AgentEvent) => {
        chain = chain.then(async () => {
          if (event.seq <= lastSent || stream.aborted) return;
          lastSent = event.seq;
          await stream.writeSSE({
            event: STREAM_EVENT_NAME,
            id: String(event.seq),
            data: JSON.stringify(event),
          });
        });
      };
      let heldBack: AgentEvent[] | undefined = [];
      const unsubscribe = store.subscribe(me.accountId, (event) =>
        heldBack ? heldBack.push(event) : send(event),
      );
      stream.onAbort(unsubscribe);
      // Delivery changes are live-only (no replay): clients refetch history when they reconnect.
      const unsubscribeDeliveries = store.subscribeDeliveries(me.accountId, (event) => {
        chain = chain.then(async () => {
          if (stream.aborted) return;
          await stream.writeSSE({ event: DELIVERY_EVENT_NAME, data: JSON.stringify(event) });
        });
      });
      stream.onAbort(unsubscribeDeliveries);
      for (const event of await store.listPending(me.accountId, after)) send(event);
      for (const event of heldBack) send(event);
      heldBack = undefined;
      while (!stream.aborted) {
        await stream.sleep(heartbeatMs);
        if (stream.aborted) break;
        chain = chain.then(() => stream.writeSSE({ event: "ping", data: "" }));
        await chain;
      }
      unsubscribe();
      unsubscribeDeliveries();
      unregister();
    });
  });

  return app;
}

function logDaemonError(err: unknown): void {
  console.error("[daemon-gateway]", err);
}
