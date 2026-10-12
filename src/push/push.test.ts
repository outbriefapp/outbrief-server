import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "../app.ts";
import { migrate } from "../db/migrate.ts";
import { openPool } from "../db/pool.ts";
import { resetTables, testDatabaseUrl } from "../db/testDatabase.ts";
import type { EventStore } from "../eventStore.ts";
import { type AgentEvent, type CallPushData, RING_WINDOW_MS } from "../protocol.ts";
import { sealed } from "../testing/sealed.ts";
import { buildServer, join, signup } from "../testing/server.ts";
import { MAX_PUSH_ATTEMPTS, PUSH_RETRY_MS, type PushResult, type PushService } from "./push.ts";

/** Records every push; answers each with `next` (or throws it). */
class FakeSender {
  readonly provider = "fcm" as const;
  readonly sent: { token: string; data: CallPushData; ttlMs: number }[] = [];
  next: PushResult | Error = "sent";

  async send(token: string, data: CallPushData, ttlMs: number): Promise<PushResult> {
    this.sent.push({ token, data, ttlMs });
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

let pool: Pool;
let app: ReturnType<typeof createApp>;
let store: EventStore;
let push: PushService;
let sender: FakeSender;
/** The Mac that reports calls, and the phone that is pushed. */
let mac: Record<string, string>;
let phone: Record<string, string>;
let phoneId: string;

beforeAll(async () => {
  const url = testDatabaseUrl();
  await migrate(url);
  pool = openPool(url);
});
afterAll(() => pool.end());

beforeEach(async () => {
  await resetTables(pool);
  sender = new FakeSender();
  ({ app, store, push } = buildServer(pool, { pushSenders: [sender] }));
  const first = await signup(app.request);
  mac = { Authorization: `Bearer ${first.token}`, "Content-Type": "application/json" };
  const joined = await join(app.request, first.token, { name: "Galaxy", kind: "app" });
  phone = { Authorization: `Bearer ${joined.token}`, "Content-Type": "application/json" };
  phoneId = joined.device.id;
});
afterEach(async () => {
  await push.idle();
  store.close();
});

function setToken(headers: Record<string, string>, token = "fcm-token-1") {
  return app.request("/v1/devices/me/push", {
    method: "PUT",
    headers,
    body: JSON.stringify({ provider: "fcm", token }),
  });
}

async function call(): Promise<AgentEvent> {
  const res = await app.request("/v1/events", {
    method: "POST",
    headers: mac,
    body: JSON.stringify({ source: "codex", sealed: sealed("done") }),
  });
  expect(res.status).toBe(201);
  await push.idle();
  return (await res.json()) as AgentEvent;
}

function receipt(id: string, via: "push" | "stream" = "push") {
  return app.request(`/v1/events/${id}/receipt`, {
    method: "POST",
    headers: phone,
    body: JSON.stringify({ via }),
  });
}

async function jobs(): Promise<{ attempt: number; state: string; error: string | null }[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT attempt, state, error FROM push_jobs ORDER BY id",
  );
  return rows as { attempt: number; state: string; error: string | null }[];
}

/** Drains as if `ms` passed since the call came in. */
async function later(event: AgentEvent, ms: number): Promise<void> {
  await push.drain(new Date(new Date(event.receivedAt).getTime() + ms));
}

/** Just past the `n`th push again (each is due `PUSH_RETRY_MS` after the drain that sent the last). */
const retry = (n = 1) => n * (PUSH_RETRY_MS + 1_000);

describe("push tokens", () => {
  it("says which providers the server pushes with", async () => {
    const info = await (await app.request("/v1/server")).json();
    expect(info).toMatchObject({ push: ["fcm"] });
  });

  it("refuses a token for a provider the server has no credentials for", async () => {
    const bare = buildServer(pool);
    const session = await join(app.request, mac.Authorization?.slice(7) ?? "", {
      name: "Pixel",
      kind: "app",
    });
    const res = await bare.app.request("/v1/devices/me/push", {
      method: "PUT",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "fcm", token: "t" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "push_unavailable" });
    expect(await (await bare.app.request("/v1/server")).json()).toMatchObject({ push: [] });
    bare.store.close();
  });

  it("validates the token", async () => {
    const res = await app.request("/v1/devices/me/push", {
      method: "PUT",
      headers: phone,
      body: JSON.stringify({ provider: "apns", token: "t" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("a new call", () => {
  it("pushes every device with a token, with no content: only which call it is", async () => {
    expect((await setToken(phone)).status).toBe(204);
    const event = await call();
    expect(sender.sent).toEqual([
      {
        token: "fcm-token-1",
        data: {
          type: "call",
          eventId: event.id,
          seq: String(event.seq),
          receivedAt: event.receivedAt,
        },
        ttlMs: expect.any(Number),
      },
    ]);
    expect(sender.sent[0]?.ttlMs).toBeLessThanOrEqual(RING_WINDOW_MS);
    expect(sender.sent[0]?.ttlMs).toBeGreaterThan(RING_WINDOW_MS - 10_000);
  });

  it("pushes nobody without tokens, and uses the latest token of a device", async () => {
    await call();
    expect(sender.sent).toEqual([]);
    await setToken(phone, "old");
    await setToken(phone, "new");
    await call();
    expect(sender.sent.map((s) => s.token)).toEqual(["new"]);
  });

  it("lets the phone fetch the call it was pushed, only in its own account", async () => {
    await setToken(phone);
    const event = await call();
    const res = await app.request(`/v1/events/${event.id}`, { headers: phone });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(event);
    const stranger = await signup(app.request, { name: "Other", kind: "app" });
    const other = { Authorization: `Bearer ${stranger.token}` };
    expect((await app.request(`/v1/events/${event.id}`, { headers: other })).status).toBe(404);
  });
});

describe("pushing again", () => {
  beforeEach(async () => {
    await setToken(phone);
  });

  it("pushes again until the device sends a receipt", async () => {
    const event = await call();
    await later(event, retry());
    expect(sender.sent).toHaveLength(2);
    expect((await receipt(event.id)).status).toBe(204);
    await later(event, retry(2));
    expect(sender.sent).toHaveLength(2);
    expect((await jobs()).map((j) => [j.attempt, j.state, j.error])).toEqual([
      [1, "sent", null],
      [2, "sent", null],
      [3, "skipped", "receipt"],
    ]);
  });

  it("stops after a few pushes, once the call is taken, or past the ring window", async () => {
    const unanswered = await call();
    for (let i = 1; i <= MAX_PUSH_ATTEMPTS + 1; i++) await later(unanswered, retry(i));
    expect(sender.sent).toHaveLength(MAX_PUSH_ATTEMPTS);

    const taken = await call();
    const answered = await app.request(`/v1/events/${taken.id}/answer`, {
      method: "POST",
      headers: mac,
    });
    expect(answered.status).toBe(200);
    await later(taken, retry());
    expect(sender.sent).toHaveLength(MAX_PUSH_ATTEMPTS + 1);

    const stale = await call();
    await later(stale, RING_WINDOW_MS + 1);
    expect(sender.sent).toHaveLength(MAX_PUSH_ATTEMPTS + 2);
    expect((await jobs()).slice(-1)).toEqual([{ attempt: 2, state: "skipped", error: "too_late" }]);
  });

  it("keeps pushing after a provider error, and drops a token the provider no longer knows", async () => {
    sender.next = new Error("FCM unavailable");
    const event = await call();
    expect((await jobs())[0]).toEqual({ attempt: 1, state: "failed", error: "FCM unavailable" });
    sender.next = "unregistered";
    await later(event, retry());
    expect((await jobs()).map((j) => j.state)).toEqual(["failed", "failed"]);
    const [tokens] = await pool.query<RowDataPacket[]>("SELECT * FROM device_push_tokens");
    expect(tokens).toEqual([]);
  });

  it("queues pushes in the call's transaction: a restart before sending loses none", async () => {
    // Stored by a server that died before it pushed: the job waits in the outbox.
    const quiet = buildServer(pool, { pushSenders: [new FakeSender()] });
    quiet.push.kick = () => {};
    const res = await quiet.app.request("/v1/events", {
      method: "POST",
      headers: mac,
      body: JSON.stringify({ source: "codex", sealed: sealed("done") }),
    });
    expect(res.status).toBe(201);
    quiet.store.close();
    expect(sender.sent).toEqual([]);
    await push.drain();
    expect(sender.sent).toHaveLength(1);
  });

  it("stops pushing a removed device", async () => {
    const event = await call();
    const removed = await app.request(`/v1/devices/${phoneId}`, { method: "DELETE", headers: mac });
    expect(removed.status).toBe(204);
    await later(event, retry());
    expect(sender.sent).toHaveLength(1);
  });

  it("stops pushing a device that switched it off", async () => {
    const event = await call();
    const off = await app.request("/v1/devices/me/push", { method: "DELETE", headers: phone });
    expect(off.status).toBe(204);
    await later(event, retry());
    expect(sender.sent).toHaveLength(1);
  });
});

describe("receipts", () => {
  it("are only for calls of the device's own account, and say how the call came", async () => {
    const event = await call();
    expect((await receipt(event.id, "stream")).status).toBe(204);
    expect((await receipt(event.id, "push")).status).toBe(204);
    const [rows] = await pool.query<RowDataPacket[]>("SELECT via FROM call_receipts");
    expect(rows).toEqual([{ via: "stream" }]);
    expect((await receipt("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const bad = await app.request(`/v1/events/${event.id}/receipt`, {
      method: "POST",
      headers: phone,
      body: JSON.stringify({ via: "carrier pigeon" }),
    });
    expect(bad.status).toBe(400);
  });
});
