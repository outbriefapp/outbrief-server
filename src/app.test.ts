import type { Pool, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { createApp } from "./app.ts";
import { migrate } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { resetTables, testDatabaseUrl } from "./db/testDatabase.ts";
import type { EventStore } from "./eventStore.ts";
import { type AgentEvent, STREAM_EVENT_NAME } from "./protocol.ts";
import { sealed } from "./testing/sealed.ts";
import { buildServer, signup } from "./testing/server.ts";

let auth: Record<string, string>;

let pool: Pool;
let store: EventStore;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  const url = testDatabaseUrl();
  await migrate(url);
  pool = openPool(url);
});
afterAll(() => pool.end());

beforeEach(async () => {
  await resetTables(pool);
  ({ app, store } = buildServer(pool));
  const { token } = await signup(app.request);
  auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
});
afterEach(() => {
  store.close();
});

function post(body: unknown, path = "/v1/events") {
  return app.request(path, { method: "POST", headers: auth, body: JSON.stringify(body) });
}

async function postEvent(body: object): Promise<AgentEvent> {
  const res = await post(body);
  expect(res.status).toBe(201);
  return (await res.json()) as AgentEvent;
}

async function pending(query = ""): Promise<AgentEvent[]> {
  const res = await app.request(`/v1/events${query}`, { headers: auth });
  return ((await res.json()) as { events: AgentEvent[] }).events;
}

async function pendingIds(query = ""): Promise<string[]> {
  return (await pending(query)).map((e) => e.id);
}

async function storedSealed(eventId: string): Promise<string | null | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT sealed FROM agent_events WHERE id = ?", [
    eventId,
  ]);
  return rows[0]?.sealed;
}

/** Reads SSE frames until `count` agent events arrived, then cancels the stream. */
async function readStreamEvents(res: Response, count: number) {
  if (!res.body) throw new Error("stream response has no body");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const events: { id: string; data: AgentEvent }[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let idx = buf.indexOf("\n\n"); idx >= 0; idx = buf.indexOf("\n\n")) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const fields: Record<string, string> = Object.fromEntries(
        frame
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
      );
      if (fields.event === STREAM_EVENT_NAME) {
        events.push({ id: fields.id ?? "", data: JSON.parse(fields.data ?? "null") });
      }
    }
  }
  await reader.cancel();
  return events;
}

describe("auth", () => {
  it("rejects /v1 requests without a device token but keeps healthz public", async () => {
    expect((await app.request("/v1/events")).status).toBe(401);
    expect((await app.request("/v1/me")).status).toBe(401);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("accepts only device tokens: no shared token, no login", async () => {
    expect((await app.request("/v1/me", { headers: auth })).status).toBe(200);
    for (const bearer of ["obu_old-session", "0123456789abcdef0123456789abcdef", "oba_forged"]) {
      const other = { Authorization: `Bearer ${bearer}` };
      expect((await app.request("/v1/me", { headers: other })).status).toBe(401);
    }
    expect((await app.request("/v1/auth/check", { headers: auth })).status).toBe(404);
    for (const path of ["/v1/auth/google", "/v1/auth/me", "/v1/auth/logout"]) {
      expect((await app.request(path, { method: "POST", headers: auth })).status).toBe(404);
    }
  });
});

describe("POST /v1/events", () => {
  it("stores the sealed report as it came and answers with the deliverable event", async () => {
    const event = await postEvent({ source: "codex", sealed: sealed("done") });
    expect(event).toEqual({
      id: expect.any(String),
      seq: 1,
      source: "codex",
      status: "received",
      occurredAt: event.receivedAt,
      receivedAt: expect.any(String),
      sealed: sealed("done"),
    });
    expect(await pendingIds()).toEqual([event.id]);
  });

  it("normalizes an offset occurredAt to the same instant in UTC", async () => {
    const event = await postEvent({
      source: "claude-code",
      sealed: sealed("done"),
      occurredAt: "2026-09-25T12:30:00.250+08:00",
    });
    expect(event.occurredAt).toBe("2026-09-25T04:30:00.250Z");
  });

  it("accepts only sealed reports: plaintext fields are refused", async () => {
    expect((await post({ source: "codex", content: "report in the clear" })).status).toBe(400);
    expect((await post({ source: "codex", sealed: "report in the clear" })).status).toBe(400);
    expect((await post({ source: "cursor", sealed: sealed("x") })).status).toBe(400);
    expect((await post({ source: "multica", sealed: sealed("x") })).status).toBe(400);
    const notJson = await app.request("/v1/events", { method: "POST", headers: auth, body: "{" });
    expect(notJson.status).toBe(400);
    expect(await pendingIds()).toEqual([]);
  });

  it("has no LLM or TTS endpoints: the server never sees the report in the clear", async () => {
    for (const path of ["/v1/llm/qa", "/v1/llm/next-prompt", "/v1/tts"]) {
      expect((await app.request(path, { method: "POST", headers: auth, body: "{}" })).status).toBe(
        404,
      );
    }
  });
});

describe("pending queue", () => {
  it("lists pending events after a cursor and drops them once the call has an outcome", async () => {
    const a = await postEvent({ source: "codex", sealed: sealed("a") });
    const b = await postEvent({ source: "codex", sealed: sealed("b") });

    expect(await pendingIds()).toEqual([a.id, b.id]);
    expect(await pendingIds(`?after=${a.seq}`)).toEqual([b.id]);

    const done = await post({ status: "completed" }, `/v1/events/${a.id}/status`);
    expect(((await done.json()) as AgentEvent).status).toBe("completed");
    expect(await pendingIds()).toEqual([b.id]);
  });

  it("refuses to reset an event back to received and 404s unknown ids", async () => {
    const a = await postEvent({ source: "codex", sealed: sealed("a") });
    expect((await post({ status: "received" }, `/v1/events/${a.id}/status`)).status).toBe(400);
    expect((await post({ status: "dismissed" }, "/v1/events/nope/status")).status).toBe(404);
  });
});

describe("GET /v1/stream", () => {
  it("replays pending events after Last-Event-ID, then pushes new ones live", async () => {
    await postEvent({ source: "codex", sealed: sealed("old") });
    await postEvent({ source: "codex", sealed: sealed("missed") });

    const res = await app.request("/v1/stream", { headers: { ...auth, "Last-Event-ID": "1" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const received = readStreamEvents(res, 2);
    await postEvent({ source: "claude-code", sealed: sealed("live") });

    const events = await received;
    expect(events.map((e) => e.id)).toEqual(["2", "3"]);
    expect(events.map((e) => e.data.sealed)).toEqual([sealed("missed"), sealed("live")]);
  });
});

describe("ending a call", () => {
  it("erases the sealed report", async () => {
    const a = await postEvent({ source: "codex", sealed: sealed("a") });
    const b = await postEvent({ source: "codex", sealed: sealed("b") });
    const c = await postEvent({ source: "codex", sealed: sealed("c") });

    const done = await post({ status: "completed" }, `/v1/events/${a.id}/status`);
    expect(await done.json()).toMatchObject({ id: a.id, status: "completed", sealed: null });
    expect(await storedSealed(a.id)).toBeNull();
    await post({ status: "dismissed" }, `/v1/events/${b.id}/status`);
    expect(await storedSealed(b.id)).toBeNull();
    const acked = await post({ status: "acknowledged" }, `/v1/events/${c.id}/status`);
    expect(await acked.json()).toMatchObject({ id: c.id, status: "acknowledged", sealed: null });
    expect(await storedSealed(c.id)).toBeNull();
  });

  it("has no history endpoint: history lives on the user's devices", async () => {
    expect((await app.request("/v1/history", { headers: auth })).status).toBe(404);
  });
});

describe("replies", () => {
  it("refuses a reply to an event no daemon reported, and a reply in the clear", async () => {
    const hookEvent = await postEvent({ source: "codex", sealed: sealed("done") });
    const res = await post({ sealed: sealed("好的") }, `/v1/events/${hookEvent.id}/reply`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no_return_path" });
    expect((await post({ content: "好的" }, `/v1/events/${hookEvent.id}/reply`)).status).toBe(400);
    expect((await post({ sealed: sealed("x") }, "/v1/events/nope/reply")).status).toBe(404);
  });
});
