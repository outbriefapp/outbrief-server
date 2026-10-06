import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  AgentEvent,
  AgentSource,
  CallOutcome,
  Delivery,
  DeliveryStatus,
  EventStatus,
  MulticaReport,
  Sealed,
} from "./protocol.ts";
import { REPLY_TTL_MS } from "./protocol.ts";

type Listener = (event: AgentEvent) => void;

/** A stream subscriber: it only hears about its own account's calls. */
interface Subscription {
  accountId: string;
  listener: Listener;
}

interface EventRow extends RowDataPacket {
  seq: number;
  id: string;
  account_id: string;
  source: AgentEvent["source"];
  status: EventStatus;
  occurred_at: Date;
  received_at: Date;
  /** Null once the call ended. */
  sealed: string | null;
  /** multica_reports columns; null for other sources. */
  m_task_id: string | null;
  m_reply_comment_id: string | null;
  m_replied_at: Date | null;
  /** machines / daemon_replies columns; null unless a daemon relayed the report. */
  machine_id: string | null;
  mc_name: string | null;
  r_id: string | null;
  r_status: DeliveryStatus | null;
  r_error: string | null;
  r_created_at: Date | null;
  r_settled_at: Date | null;
  r_expires_at: Date | null;
}

/** Tells whether a machine's daemon is connected right now (held in memory by the gateway). */
export interface Presence {
  isOnline(machineId: string): boolean;
}

/** A reply the gateway should hand to a daemon. */
export interface PendingReply {
  id: string;
  eventId: string;
  machineId: string;
  source: AgentEvent["source"];
  sealed: Sealed;
}

/** What the server is told about a new report: where it came from and the sealed report. */
export interface NewReport {
  source: AgentSource;
  occurredAt?: string;
  sealed: Sealed;
}

const SELECT_EVENTS = `SELECT e.seq, e.id, e.account_id, e.source, e.status, e.occurred_at, e.received_at, e.sealed,
  m.task_id AS m_task_id, m.reply_comment_id AS m_reply_comment_id, m.replied_at AS m_replied_at,
  e.machine_id, mc.name AS mc_name,
  r.id AS r_id, r.status AS r_status, r.error AS r_error,
  r.created_at AS r_created_at, r.settled_at AS r_settled_at, r.expires_at AS r_expires_at
  FROM agent_events e
  LEFT JOIN multica_reports m ON m.event_id = e.id
  LEFT JOIN devices mc ON mc.id = e.machine_id
  LEFT JOIN daemon_replies r ON r.event_id = e.id`;

const PAGE = 100;

function toMulticaReport(row: EventRow): MulticaReport | undefined {
  if (!row.m_task_id) return undefined;
  return {
    taskId: row.m_task_id,
    reply:
      row.m_reply_comment_id && row.m_replied_at
        ? { commentId: row.m_reply_comment_id, sentAt: row.m_replied_at.toISOString() }
        : null,
  };
}

function toDelivery(row: EventRow): Delivery | undefined {
  if (!row.r_id || !row.r_status || !row.r_created_at || !row.r_expires_at) return undefined;
  return {
    id: row.r_id,
    status: row.r_status,
    error: row.r_error,
    createdAt: row.r_created_at.toISOString(),
    settledAt: row.r_settled_at?.toISOString() ?? null,
    expiresAt: row.r_expires_at.toISOString(),
  };
}

function toEvent(row: EventRow, presence: Presence): AgentEvent {
  return {
    seq: Number(row.seq),
    id: row.id,
    source: row.source,
    status: row.status,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    sealed: row.sealed,
    multica: toMulticaReport(row),
    machine:
      row.machine_id && row.mc_name !== null
        ? { id: row.machine_id, name: row.mc_name, online: presence.isOnline(row.machine_id) }
        : undefined,
    delivery: toDelivery(row),
  };
}

async function insertEvent(
  db: Pick<Pool, "execute"> | PoolConnection,
  id: string,
  accountId: string,
  report: NewReport,
  now: Date,
  machineId: string | null = null,
): Promise<void> {
  const occurredAt = report.occurredAt ? new Date(report.occurredAt) : now;
  await db.execute<ResultSetHeader>(
    `INSERT INTO agent_events (id, account_id, source, machine_id, sealed, status, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, 'received', ?, ?)`,
    [id, accountId, report.source, machineId, report.sealed, occurredAt, now],
  );
}

const NOBODY_ONLINE: Presence = { isOnline: () => false };

/** Why a reply fails when its machine stays offline past `expires_at`. */
export const REPLY_EXPIRED_ERROR = "电脑一直离线，回复已过期";

interface PendingReplyRow extends RowDataPacket {
  id: string;
  event_id: string;
  machine_id: string;
  source: AgentEvent["source"];
  sealed: string;
}

/**
 * MySQL-backed relay queue (`agent_events`) with in-process fan-out to live stream subscribers.
 * Reports and replies are sealed by the user's devices (ADR 0007); the server stores the sealed
 * text and what it routes by. It is not an archive (ADR 0006): a call's sealed report is erased
 * once the call ends, a reply's once it settles. Every call belongs to one account and only that
 * account's devices read it or hear about it. Fan-out is per process: run one server instance
 * until a shared pub/sub is introduced.
 */
export class EventStore {
  readonly #pool: Pool;
  readonly #listeners = new Set<Subscription>();
  readonly #deliveryListeners = new Set<Subscription>();
  #inserting: Promise<void> = Promise.resolve();
  #presence: Presence = NOBODY_ONLINE;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Where `machine.online` comes from; the daemon gateway registers itself here. */
  usePresence(presence: Presence): void {
    this.#presence = presence;
  }

  /**
   * Stores a sealed report of the account and delivers it to the account's devices. `machineId` is
   * set when that machine's daemon relayed it.
   */
  append(
    accountId: string,
    report: NewReport,
    now = new Date(),
    machineId: string | null = null,
  ): Promise<AgentEvent> {
    return this.#insert(accountId, async (conn, id) => {
      await insertEvent(conn, id, accountId, report, now, machineId);
      return true;
    }) as Promise<AgentEvent>;
  }

  /**
   * Stores the sealed report of a finished Multica task, then delivers it. `machineId` is the daemon
   * that read it; replies go back to that machine. Returns null when that task already has an event
   * in this account (a repeated `task:completed`, or another machine of the account was first).
   */
  appendMulticaReport(
    accountId: string,
    taskId: string,
    report: Omit<NewReport, "source">,
    machineId: string,
    now = new Date(),
  ): Promise<AgentEvent | null> {
    return this.#insert(accountId, async (conn, id) => {
      await insertEvent(conn, id, accountId, { ...report, source: "multica" }, now, machineId);
      try {
        await conn.execute(
          "INSERT INTO multica_reports (event_id, account_id, task_id) VALUES (?, ?, ?)",
          [id, accountId, taskId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "ER_DUP_ENTRY") return false;
        throw err;
      }
      return true;
    });
  }

  /**
   * Runs `write` in a transaction and fans the new event out to stream subscribers. Inserts run one
   * at a time, so events commit and reach subscribers in ascending seq order (a stream skips any
   * seq at or below the last one it sent). `write` resolves false to roll back and return null.
   */
  #insert(
    accountId: string,
    write: (conn: PoolConnection, id: string) => Promise<boolean>,
  ): Promise<AgentEvent | null> {
    const run = this.#inserting.then(async () => {
      const id = randomUUID();
      const conn = await this.#pool.getConnection();
      try {
        await conn.beginTransaction();
        if (!(await write(conn, id))) {
          await conn.rollback();
          return null;
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
      const event = await this.get(id);
      if (!event) throw new Error(`agent_events row ${id} vanished right after insert`);
      for (const sub of this.#listeners) if (sub.accountId === accountId) sub.listener(event);
      return event;
    });
    this.#inserting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The account's events still waiting for a call, oldest first, strictly after `afterSeq`. */
  async listPending(accountId: string, afterSeq = 0, limit = PAGE): Promise<AgentEvent[]> {
    const [rows] = await this.#pool.execute<EventRow[]>(
      `${SELECT_EVENTS} WHERE e.account_id = ? AND e.status = 'received' AND e.seq > ?
       ORDER BY e.seq LIMIT ?`,
      [accountId, afterSeq, String(limit)],
    );
    return rows.map((row) => toEvent(row, this.#presence));
  }

  /** The event, when it belongs to `accountId`; any account's when that is omitted (server-internal). */
  async get(id: string, accountId?: string): Promise<AgentEvent | undefined> {
    return (await this.#load(id, accountId))?.event;
  }

  async #load(
    id: string,
    accountId?: string,
  ): Promise<{ event: AgentEvent; accountId: string } | undefined> {
    const [rows] = await this.#pool.execute<EventRow[]>(
      accountId === undefined
        ? `${SELECT_EVENTS} WHERE e.id = ?`
        : `${SELECT_EVENTS} WHERE e.id = ? AND e.account_id = ?`,
      accountId === undefined ? [id] : [id, accountId],
    );
    const row = rows[0];
    return row ? { event: toEvent(row, this.#presence), accountId: row.account_id } : undefined;
  }

  /**
   * Ends the account's call and erases its sealed report: the clients keep their own copy. The
   * source, machine and Multica task stay, so a reply can still be routed later.
   */
  async setOutcome(
    accountId: string,
    id: string,
    status: CallOutcome,
  ): Promise<AgentEvent | undefined> {
    await this.#pool.execute(
      "UPDATE agent_events SET status = ?, sealed = NULL WHERE id = ? AND account_id = ?",
      [status, id, accountId],
    );
    return this.get(id, accountId);
  }

  // --- Replies to daemon-relayed events ------------------------------------------------------

  /**
   * Queues the sealed reply for the event's machine. Returns the updated event, or null when the
   * event already has a reply (one reply per event).
   */
  async enqueueReply(
    event: Pick<AgentEvent, "id" | "machine">,
    sealed: Sealed,
    now = new Date(),
    ttlMs = REPLY_TTL_MS,
  ): Promise<AgentEvent | null> {
    if (!event.machine) throw new Error(`event ${event.id} was not relayed by a daemon`);
    try {
      await this.#pool.execute(
        `INSERT INTO daemon_replies (id, event_id, machine_id, sealed, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
        [randomUUID(), event.id, event.machine.id, sealed, now, new Date(now.getTime() + ttlMs)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "ER_DUP_ENTRY") return null;
      throw err;
    }
    return this.#deliveryChanged(event.id);
  }

  /**
   * Replies the machine's daemon should (re)execute, oldest first: `queued` ones not yet expired,
   * and `dispatched` ones whose result never came back (the daemon dedups by reply id).
   */
  async listOpenReplies(machineId: string, now = new Date()): Promise<PendingReply[]> {
    const [rows] = await this.#pool.execute<PendingReplyRow[]>(
      `SELECT r.id, r.event_id, r.machine_id, e.source, r.sealed
       FROM daemon_replies r JOIN agent_events e ON e.id = r.event_id
       WHERE r.machine_id = ? AND (r.status = 'dispatched' OR (r.status = 'queued' AND r.expires_at > ?))
       ORDER BY r.created_at, r.id`,
      [machineId, now],
    );
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      machineId: row.machine_id,
      source: row.source,
      sealed: row.sealed,
    }));
  }

  /** The daemon accepted the reply; `queued` → `dispatched`. */
  async markDispatched(replyId: string, now = new Date()): Promise<void> {
    const [result] = await this.#pool.execute<ResultSetHeader>(
      `UPDATE daemon_replies SET status = 'dispatched', dispatched_at = ?
       WHERE id = ? AND status IN ('queued', 'dispatched')`,
      [now, replyId],
    );
    if (result.affectedRows) await this.#deliveryChangedByReply(replyId);
  }

  /**
   * Records the daemon's result. Only the reply's own machine may settle it, and only once; returns
   * whether it was settled by this call. `commentId` is the Multica comment a delivered reply to a
   * Multica report was posted as; it is recorded as that report's reply. The sealed reply is
   * erased: the client that sent it keeps its own copy. `error` is sealed by the daemon.
   *
   * Both writes are one transaction: a reader that sees `delivery.status = delivered` must also see
   * the comment id. As two separate statements a reader could land between them and get a delivered
   * reply whose `multica.reply` was still null — CI caught exactly that, and it is not only a test
   * artifact: `#deliveryChangedByReply` pushes the event to stream subscribers, so a client could be
   * told the reply was delivered while the comment id was still missing.
   */
  async settleReply(
    replyId: string,
    machineId: string,
    status: Extract<DeliveryStatus, "delivered" | "failed">,
    error: string | null,
    now = new Date(),
    commentId: string | null = null,
  ): Promise<boolean> {
    const conn = await this.#pool.getConnection();
    let settled = false;
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute<ResultSetHeader>(
        `UPDATE daemon_replies SET status = ?, error = ?, settled_at = ?, sealed = ''
         WHERE id = ? AND machine_id = ? AND status IN ('queued', 'dispatched')`,
        [status, status === "failed" ? (error ?? "unknown error") : null, now, replyId, machineId],
      );
      settled = result.affectedRows > 0;
      if (settled && status === "delivered" && commentId) {
        await conn.execute(
          `UPDATE multica_reports m JOIN daemon_replies r ON r.event_id = m.event_id
           SET m.reply_comment_id = ?, m.replied_at = ?
           WHERE r.id = ? AND m.reply_comment_id IS NULL`,
          [commentId, now, replyId],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
    if (!settled) return false;
    await this.#deliveryChangedByReply(replyId);
    return true;
  }

  /** Fails every reply still `queued` at `expires_at`. Returns how many expired. */
  async expireReplies(now = new Date()): Promise<number> {
    const [rows] = await this.#pool.execute<RowDataPacket[]>(
      "SELECT id FROM daemon_replies WHERE status = 'queued' AND expires_at <= ?",
      [now],
    );
    let expired = 0;
    for (const row of rows) {
      const [result] = await this.#pool.execute<ResultSetHeader>(
        `UPDATE daemon_replies SET status = 'failed', error = ?, settled_at = ?, sealed = ''
         WHERE id = ? AND status = 'queued'`,
        [REPLY_EXPIRED_ERROR, now, row.id],
      );
      if (result.affectedRows) {
        expired++;
        await this.#deliveryChangedByReply(row.id as string);
      }
    }
    return expired;
  }

  /**
   * Events of this machine, re-read and fanned out to delivery subscribers (online flag changed).
   * Filters on `r.machine_id` (the reply's copy of `e.machine_id`) so it can use
   * `idx_daemon_replies_machine_status`; `agent_events.machine_id` has no index.
   */
  async announceMachine(machineId: string): Promise<void> {
    const [rows] = await this.#pool.execute<EventRow[]>(
      `${SELECT_EVENTS} WHERE r.machine_id = ? AND r.status IN ('queued', 'dispatched') ORDER BY e.seq`,
      [machineId],
    );
    for (const row of rows) this.#emitDelivery(toEvent(row, this.#presence), row.account_id);
  }

  async #deliveryChangedByReply(replyId: string): Promise<void> {
    const [rows] = await this.#pool.execute<RowDataPacket[]>(
      "SELECT event_id FROM daemon_replies WHERE id = ?",
      [replyId],
    );
    if (rows[0]) await this.#deliveryChanged(rows[0].event_id as string);
  }

  async #deliveryChanged(eventId: string): Promise<AgentEvent | null> {
    const loaded = await this.#load(eventId);
    if (!loaded) return null;
    this.#emitDelivery(loaded.event, loaded.accountId);
    return loaded.event;
  }

  #emitDelivery(event: AgentEvent, accountId: string): void {
    for (const sub of this.#deliveryListeners) if (sub.accountId === accountId) sub.listener(event);
  }

  /** New events of the account. */
  subscribe(accountId: string, listener: Listener): () => void {
    const sub = { accountId, listener };
    this.#listeners.add(sub);
    return () => this.#listeners.delete(sub);
  }

  /**
   * Every change of a reply delivery of the account (status, or the machine going on/offline while
   * it is open).
   */
  subscribeDeliveries(accountId: string, listener: Listener): () => void {
    const sub = { accountId, listener };
    this.#deliveryListeners.add(sub);
    return () => this.#deliveryListeners.delete(sub);
  }

  /** Drops stream subscribers; the pool is owned (and ended) by the caller. */
  close(): void {
    this.#listeners.clear();
    this.#deliveryListeners.clear();
  }
}
