import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  type CallPushData,
  type CallReceiptInput,
  type PushProvider,
  RING_WINDOW_MS,
} from "../protocol.ts";

/** What a provider made of one push. */
export type PushResult = "sent" | "unregistered";

/**
 * Sends one push through a provider (FCM). Resolves `unregistered` when the provider no longer
 * knows the token (the app was uninstalled or its data cleared); throws on any other failure.
 */
export interface PushSender {
  readonly provider: PushProvider;
  send(token: string, data: CallPushData, ttlMs: number): Promise<PushResult>;
}

/** Pushes again this long after one that brought no receipt. */
export const PUSH_RETRY_MS = 10_000;
/** Pushes per call and device, the first one included. */
export const MAX_PUSH_ATTEMPTS = 3;
/** Settled jobs and receipts are kept this long, to tell afterwards what reached which device. */
const KEEP_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
const MAX_ERROR_CHARS = 500;

interface JobRow extends RowDataPacket {
  id: number;
  event_id: string;
  device_id: string;
  attempt: number;
  seq: number;
  status: string;
  handled_by: string | null;
  received_at: Date;
  provider: PushProvider | null;
  token: string | null;
  revoked_at: Date | null;
  delivered: number;
}

/** Why a due push is not sent; null when it is. */
function skipReason(job: JobRow, now: Date): string | null {
  if (job.delivered) return "receipt";
  if (job.status !== "received" || job.handled_by) return "call_taken";
  if (now.getTime() - job.received_at.getTime() > RING_WINDOW_MS) return "too_late";
  if (job.revoked_at) return "device_removed";
  if (!job.token) return "no_token";
  return null;
}

/**
 * Wakes the account's devices when a call comes in (ADR 0010). Pushes go through an outbox
 * (`push_jobs`) written in the call's own transaction, so a restart between storing a call and
 * pushing it loses nothing; a device is pushed again every `PUSH_RETRY_MS` until it sends a receipt,
 * the call is taken, or it can no longer ring. A push carries no content, only which call it is.
 *
 * Jobs are drained in this process, one batch at a time: run one server instance (ADR 0009).
 */
export class PushService {
  readonly #pool: Pool;
  readonly #senders: Map<PushProvider, PushSender>;
  #draining: Promise<void> = Promise.resolve();
  #again = false;
  #busy = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(pool: Pool, senders: PushSender[] = []) {
    this.#pool = pool;
    this.#senders = new Map(senders.map((s) => [s.provider, s]));
  }

  /** The providers this server has credentials for. */
  get providers(): PushProvider[] {
    return [...this.#senders.keys()];
  }

  /** False when the server has no credentials for `provider`. */
  async setToken(
    deviceId: string,
    provider: PushProvider,
    token: string,
    now = new Date(),
  ): Promise<boolean> {
    if (!this.#senders.has(provider)) return false;
    await this.#pool.execute(
      `INSERT INTO device_push_tokens (device_id, provider, token, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE provider = VALUES(provider), token = VALUES(token),
         updated_at = VALUES(updated_at)`,
      [deviceId, provider, token, now],
    );
    return true;
  }

  async clearToken(deviceId: string): Promise<void> {
    await this.#pool.execute("DELETE FROM device_push_tokens WHERE device_id = ?", [deviceId]);
  }

  /** The device heard of the call; the first receipt counts. */
  async recordReceipt(
    eventId: string,
    deviceId: string,
    via: CallReceiptInput["via"],
    now = new Date(),
  ): Promise<void> {
    await this.#pool.execute(
      `INSERT IGNORE INTO call_receipts (event_id, device_id, via, received_at) VALUES (?, ?, ?, ?)`,
      [eventId, deviceId, via, now],
    );
  }

  /**
   * Queues the first push of a new call for every device of the account that can be pushed. Runs
   * in the transaction that stores the call.
   */
  async enqueue(
    conn: PoolConnection,
    eventId: string,
    accountId: string,
    now: Date,
  ): Promise<void> {
    if (!this.#senders.size) return;
    await conn.execute(
      `INSERT INTO push_jobs (event_id, device_id, attempt, state, due_at)
       SELECT ?, t.device_id, 1, 'pending', ?
       FROM device_push_tokens t JOIN devices d ON d.id = t.device_id
       WHERE d.account_id = ? AND d.revoked_at IS NULL`,
      [eventId, now, accountId],
    );
  }

  /** Sends what is due now, soon; a drain already running runs once more afterwards. */
  kick(): void {
    if (!this.#senders.size) return;
    if (this.#busy) {
      this.#again = true;
      return;
    }
    this.#busy = true;
    this.#draining = (async () => {
      try {
        do {
          this.#again = false;
          await this.drain();
        } while (this.#again);
      } catch (err) {
        console.error("[push] drain failed", err);
      } finally {
        this.#busy = false;
      }
    })();
  }

  /** Resolves once the drain in progress, if any, is done (tests). */
  idle(): Promise<void> {
    return this.#draining;
  }

  /** Drains every `intervalMs` for the pushes sent again later. */
  start(intervalMs = 1_000): void {
    this.#timer ??= setInterval(() => this.kick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Sends every push due by `now`. */
  async drain(now = new Date()): Promise<void> {
    for (;;) {
      const [jobs] = await this.#pool.execute<JobRow[]>(
        `SELECT j.id, j.event_id, j.device_id, j.attempt,
           e.seq, e.status, e.handled_by, e.received_at,
           t.provider, t.token, d.revoked_at,
           EXISTS (SELECT 1 FROM call_receipts r
                   WHERE r.event_id = j.event_id AND r.device_id = j.device_id) AS delivered
         FROM push_jobs j
         JOIN agent_events e ON e.id = j.event_id
         JOIN devices d ON d.id = j.device_id
         LEFT JOIN device_push_tokens t ON t.device_id = j.device_id
         WHERE j.state = 'pending' AND j.due_at <= ?
         ORDER BY j.due_at, j.id LIMIT ${BATCH}`,
        [now],
      );
      for (const job of jobs) await this.#run(job, now);
      if (jobs.length < BATCH) return;
    }
  }

  async #run(job: JobRow, now: Date): Promise<void> {
    const skipped = skipReason(job, now);
    const sender = job.provider ? this.#senders.get(job.provider) : undefined;
    if (skipped || !sender || !job.token) {
      await this.#settle(job.id, "skipped", skipped ?? "no_sender", now);
      return;
    }
    const data: CallPushData = {
      type: "call",
      eventId: job.event_id,
      seq: String(job.seq),
      receivedAt: job.received_at.toISOString(),
    };
    // Past the ring window the push is useless: the provider drops it rather than deliver it late.
    const ttlMs = job.received_at.getTime() + RING_WINDOW_MS - now.getTime();
    let result: PushResult;
    try {
      result = await sender.send(job.token, data, ttlMs);
    } catch (err) {
      await this.#settle(job.id, "failed", errorText(err), now);
      await this.#retry(job, now);
      return;
    }
    if (result === "unregistered") {
      await this.#settle(job.id, "failed", "unregistered", now);
      await this.#pool.execute("DELETE FROM device_push_tokens WHERE device_id = ? AND token = ?", [
        job.device_id,
        job.token,
      ]);
      return;
    }
    await this.#settle(job.id, "sent", null, now);
    await this.#retry(job, now);
  }

  async #retry(job: JobRow, now: Date): Promise<void> {
    if (job.attempt >= MAX_PUSH_ATTEMPTS) return;
    await this.#pool.execute(
      `INSERT INTO push_jobs (event_id, device_id, attempt, state, due_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      [job.event_id, job.device_id, job.attempt + 1, new Date(now.getTime() + PUSH_RETRY_MS)],
    );
  }

  async #settle(id: number, state: string, error: string | null, now: Date): Promise<void> {
    await this.#pool.execute<ResultSetHeader>(
      "UPDATE push_jobs SET state = ?, error = ?, settled_at = ? WHERE id = ?",
      [state, error, now, id],
    );
  }

  /** Forgets settled jobs and receipts older than a day. */
  async prune(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - KEEP_MS);
    await this.#pool.execute("DELETE FROM push_jobs WHERE state <> 'pending' AND settled_at < ?", [
      before,
    ]);
    await this.#pool.execute("DELETE FROM call_receipts WHERE received_at < ?", [before]);
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.slice(0, MAX_ERROR_CHARS);
}
