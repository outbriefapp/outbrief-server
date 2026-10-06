import type { Pool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.ts";
import { openPool } from "../db/pool.ts";
import { resetTables, testDatabaseUrl } from "../db/testDatabase.ts";
import type { AgentEvent, Device, DeviceSession, PairingCodeStatus } from "../protocol.ts";
import { sealed } from "../testing/sealed.ts";
import { buildServer, join, signup } from "../testing/server.ts";
import { RateLimiter } from "./rateLimit.ts";

let pool: Pool;
let server: ReturnType<typeof buildServer>;

beforeAll(async () => {
  const url = testDatabaseUrl();
  await migrate(url);
  pool = openPool(url);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await resetTables(pool);
  server = buildServer(pool);
});
afterEach(() => {
  server.gateway.closeAll();
  server.store.close();
});

const request = (path: string, init?: RequestInit) => server.app.request(path, init);

function call(bearer: string, path: string, method = "GET", body?: unknown): Promise<Response> {
  return Promise.resolve(
    server.app.request(path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function relay(daemon: DeviceSession, label: string, taskId?: string): Promise<AgentEvent> {
  const res = taskId
    ? await call(daemon.token, "/v1/daemon/multica-reports", "POST", {
        taskId,
        sealed: sealed(label),
      })
    : await call(daemon.token, "/v1/daemon/events", "POST", {
        source: "claude-code",
        sealed: sealed(label),
      });
  expect(res.status).toBe(201);
  return (await res.json()) as AgentEvent;
}

async function pendingIds(bearer: string): Promise<string[]> {
  const res = await call(bearer, "/v1/events");
  return ((await res.json()) as { events: AgentEvent[] }).events.map((e) => e.id);
}

async function deviceNames(bearer: string): Promise<string[]> {
  const res = await call(bearer, "/v1/devices");
  return ((await res.json()) as { devices: Device[] }).devices.map((d) => d.name);
}

describe("anonymous accounts", () => {
  it("creates an account with its first device: no name, no password", async () => {
    const session = await signup(request, { name: "iPhone", kind: "app" });
    expect(session.token).toMatch(/^oba_/);
    expect(session.device).toMatchObject({ name: "iPhone", kind: "app", current: true });
    const me = await call(session.token, "/v1/me");
    expect(await me.json()).toMatchObject({
      accountId: session.accountId,
      device: { id: session.device.id },
    });
  });

  it("lists the account's devices and removes one, whose token then stops working", async () => {
    const mac = await signup(request, { name: "Mac", kind: "app" });
    const phone = await join(request, mac.token, { name: "iPhone", kind: "app" });
    const daemon = await join(request, phone.token, { name: "mac-mini", kind: "daemon" });
    expect(daemon.accountId).toBe(mac.accountId);
    expect(await deviceNames(mac.token)).toEqual(["Mac", "iPhone", "mac-mini"]);

    expect((await call(mac.token, `/v1/devices/${phone.device.id}`, "DELETE")).status).toBe(204);
    expect((await call(phone.token, "/v1/me")).status).toBe(401);
    expect(await deviceNames(mac.token)).toEqual(["Mac", "mac-mini"]);
  });

  it("closes the event stream of a removed device", async () => {
    const mac = await signup(request);
    const phone = await join(request, mac.token, { name: "iPhone", kind: "app" });
    const stream = await call(phone.token, "/v1/stream");
    const listed = (await (await call(mac.token, "/v1/devices")).json()) as { devices: Device[] };
    expect(listed.devices.find((d) => d.id === phone.device.id)?.online).toBe(true);

    await call(mac.token, `/v1/devices/${phone.device.id}`, "DELETE");
    const reader = stream.body?.getReader();
    for (;;) {
      const { done } = (await reader?.read()) ?? { done: true };
      if (done) break;
    }
  });
});

describe("account isolation", () => {
  let a: { app: DeviceSession; daemon: DeviceSession };
  let b: { app: DeviceSession; daemon: DeviceSession };

  beforeEach(async () => {
    const aApp = await signup(request, { name: "A's Mac", kind: "app" });
    const bApp = await signup(request, { name: "B's Mac", kind: "app" });
    a = { app: aApp, daemon: await join(request, aApp.token, { name: "a-box", kind: "daemon" }) };
    b = { app: bApp, daemon: await join(request, bApp.token, { name: "b-box", kind: "daemon" }) };
  });

  it("shows each account only its own calls", async () => {
    const aCall = await relay(a.daemon, "A's report");
    const bCall = await relay(b.daemon, "B's report");
    expect(await pendingIds(a.app.token)).toEqual([aCall.id]);
    expect(await pendingIds(b.app.token)).toEqual([bCall.id]);
  });

  it("streams a call only to devices of its account", async () => {
    const aStream = await call(a.app.token, "/v1/stream");
    const bStream = await call(b.app.token, "/v1/stream");
    const bCall = await relay(b.daemon, "B's report");
    const aCall = await relay(a.daemon, "A's report");

    expect(await firstEventId(aStream)).toBe(aCall.id);
    expect(await firstEventId(bStream)).toBe(bCall.id);
  });

  it("refuses to end, answer or reply to another account's call", async () => {
    const aCall = await relay(a.daemon, "A's report");
    const status = await call(b.app.token, `/v1/events/${aCall.id}/status`, "POST", {
      status: "dismissed",
    });
    expect(status.status).toBe(404);
    const reply = await call(b.app.token, `/v1/events/${aCall.id}/reply`, "POST", {
      sealed: sealed("hijack"),
    });
    expect(reply.status).toBe(404);
    expect(await pendingIds(a.app.token)).toEqual([aCall.id]);
  });

  it("hides another account's devices and refuses to remove them", async () => {
    expect(await deviceNames(b.app.token)).toEqual(["B's Mac", "b-box"]);
    for (const victim of [a.app, a.daemon]) {
      const res = await call(b.app.token, `/v1/devices/${victim.device.id}`, "DELETE");
      expect(res.status).toBe(404);
    }
    expect((await call(a.daemon.token, "/v1/me")).status).toBe(200);
    const relayed = await call(b.app.token, `/v1/devices/${a.daemon.device.id}/settings`, "POST", {
      requestId: crypto.randomUUID(),
      sealed: sealed("settings"),
    });
    expect(relayed.status).toBe(404);
  });

  it("does not let one account's Multica call suppress another's for the same task", async () => {
    await relay(a.daemon, "A's task", "task-1");
    await relay(b.daemon, "B's task", "task-1");
    const again = await call(a.daemon.token, "/v1/daemon/multica-reports", "POST", {
      taskId: "task-1",
      sealed: sealed("again"),
    });
    expect(again.status).toBe(409);
  });

  it("keeps pairing codes to their account", async () => {
    const created = await call(a.app.token, "/v1/pairing", "POST");
    const { code } = (await created.json()) as { code: string };
    expect((await call(b.app.token, `/v1/pairing/${code}`)).status).toBe(404);
  });
});

describe("pairing codes", () => {
  it("work once, and the device that showed the code sees who joined", async () => {
    const mac = await signup(request);
    const created = await call(mac.token, "/v1/pairing", "POST");
    const { code, expiresAt } = (await created.json()) as { code: string; expiresAt: string };
    expect(code).toMatch(/^\d{6}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);

    const redeem = () =>
      request("/v1/pairing/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, device: { name: "iPhone", kind: "app" } }),
      });
    const joined = await redeem();
    expect(joined.status).toBe(201);
    const phone = (await joined.json()) as DeviceSession;
    expect(phone.accountId).toBe(mac.accountId);
    expect((await redeem()).status).toBe(404);

    const status = (await (
      await call(mac.token, `/v1/pairing/${code}`)
    ).json()) as PairingCodeStatus;
    expect(status).toMatchObject({ usedBy: { id: phone.device.id, name: "iPhone", kind: "app" } });
  });

  it("expire after 10 minutes", async () => {
    const mac = await signup(request);
    const { code } = (await (await call(mac.token, "/v1/pairing", "POST")).json()) as {
      code: string;
    };
    await pool.query(
      "UPDATE pairing_codes SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE code = ?",
      [code],
    );
    const res = await request("/v1/pairing/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device: { name: "iPhone", kind: "app" } }),
    });
    expect(res.status).toBe(404);
  });

  it("cannot be guessed: too many misses are refused", async () => {
    server = buildServer(pool, {
      limits: { guesses: new RateLimiter({ limit: 3, globalLimit: 100, windowMs: 60_000 }) },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await server.app.request("/v1/pairing/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: `00000${i}`, device: { name: "x", kind: "app" } }),
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([404, 404, 404, 429]);
  });
});

describe("private server (signup closed)", () => {
  beforeEach(() => {
    server = buildServer(pool, { openSignup: false });
  });

  async function create(claimCode?: string): Promise<Response> {
    return server.app.request("/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: { name: "Mac", kind: "app" }, claimCode }),
    });
  }

  async function signupMode(): Promise<string> {
    return ((await (await server.app.request("/v1/server")).json()) as { signup: string }).signup;
  }

  it("needs the claim code from its log for the first account, then takes no new ones", async () => {
    expect(await signupMode()).toBe("claim");
    const claim = await server.accounts.claimCode();
    expect(claim).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    expect(await (await create()).json()).toEqual({ error: "invalid_claim_code" });
    expect((await create("0000-0000-0000")).status).toBe(403);
    // Typed back in lower case without dashes still counts.
    const owner = await create(claim?.toLowerCase().replaceAll("-", ""));
    expect(owner.status).toBe(201);

    expect(await signupMode()).toBe("closed");
    expect(await server.accounts.claimCode()).toBeNull();
    expect(await (await create(claim ?? undefined)).json()).toEqual({ error: "signup_closed" });

    // Other devices still join the owner's account with a pairing code.
    const { token } = (await owner.json()) as DeviceSession;
    const phone = await join(server.app.request, token, { name: "iPhone", kind: "app" });
    expect(phone.token).toMatch(/^oba_/);
  });

  it("stays claimed by the data an upgrade moved into the default account", async () => {
    await pool.query(
      "INSERT INTO accounts (id, created_via, created_at) VALUES (UUID(), 'migration', UTC_TIMESTAMP(3))",
    );
    expect(await signupMode()).toBe("closed");
    expect(await server.accounts.claimCode()).toBeNull();
  });
});

/** Reads SSE frames until the first agent event, then cancels the stream. */
async function firstEventId(res: Response): Promise<string> {
  if (!res.body) throw new Error("stream response has no body");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += value;
    const match = buf.match(/event: agent-event\ndata: (.+)\n/);
    if (match?.[1]) {
      await reader.cancel();
      return (JSON.parse(match[1]) as AgentEvent).id;
    }
  }
}
