import { randomInt } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import {
  type DeviceKind,
  type DeviceSession,
  type NewDevice,
  PAIRING_CODE_TTL_MS,
  type PairingCode,
  type PairingCodeStatus,
} from "../protocol.ts";
import type { DevicePresence, DeviceStore } from "./devices.ts";

interface CodeRow extends RowDataPacket {
  code: string;
  account_id: string;
  expires_at: Date;
  used_at: Date | null;
  used_by: string | null;
  used_by_name: string | null;
  used_by_kind: DeviceKind | null;
}

const NOBODY_ONLINE: DevicePresence = { isOnline: () => false };

/**
 * One-time 6-digit codes: a device of the account shows one ("添加设备", `outbrief-daemon login`),
 * a new device types it (or scans the QR code that also carries the end-to-end key) and joins the
 * account. Valid for 10 minutes, once. Guessing is bounded by the caller's rate limit.
 */
export class PairingStore {
  readonly #pool: Pool;
  readonly #devices: DeviceStore;

  constructor(pool: Pool, devices: DeviceStore) {
    this.#pool = pool;
    this.#devices = devices;
  }

  async create(accountId: string, deviceId: string, now = new Date()): Promise<PairingCode> {
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
    // A code frees up once it expired; drop those so it can be handed out again. A used code
    // expires too (it was used before `expires_at`), and until then `status` still reports who
    // used it. One range on `idx_pairing_codes_expires`, not a scan that locks every row.
    await this.#pool.execute("DELETE FROM pairing_codes WHERE expires_at <= ?", [now]);
    for (let attempt = 0; ; attempt++) {
      const code = String(randomInt(1_000_000)).padStart(6, "0");
      try {
        await this.#pool.execute(
          `INSERT INTO pairing_codes (code, account_id, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          [code, accountId, deviceId, now, expiresAt],
        );
        return { code, expiresAt: expiresAt.toISOString() };
      } catch (err) {
        if ((err as { code?: string }).code !== "ER_DUP_ENTRY" || attempt >= 20) throw err;
      }
    }
  }

  /** The code as the account that made it sees it; undefined for another account's code. */
  async status(accountId: string, code: string): Promise<PairingCodeStatus | undefined> {
    const [rows] = await this.#pool.execute<CodeRow[]>(
      `SELECT p.code, p.account_id, p.expires_at, p.used_at, p.used_by,
         d.name AS used_by_name, d.kind AS used_by_kind
       FROM pairing_codes p LEFT JOIN devices d ON d.id = p.used_by
       WHERE p.code = ? AND p.account_id = ?`,
      [code, accountId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      code: row.code,
      expiresAt: row.expires_at.toISOString(),
      usedAt: row.used_at?.toISOString() ?? null,
      usedBy:
        row.used_by && row.used_by_name && row.used_by_kind
          ? { id: row.used_by, name: row.used_by_name, kind: row.used_by_kind }
          : null,
    };
  }

  /** Joins the code's account as a new device; undefined when the code is unknown, expired or used. */
  async redeem(
    code: string,
    device: NewDevice,
    now = new Date(),
  ): Promise<DeviceSession | undefined> {
    const conn = await this.#pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute<CodeRow[]>(
        `SELECT code, account_id FROM pairing_codes
         WHERE code = ? AND used_at IS NULL AND expires_at > ? FOR UPDATE`,
        [code, now],
      );
      const row = rows[0];
      if (!row) {
        await conn.rollback();
        return undefined;
      }
      const { id, token } = await this.#devices.create(row.account_id, device, now, conn);
      await conn.execute("UPDATE pairing_codes SET used_at = ?, used_by = ? WHERE code = ?", [
        now,
        id,
        code,
      ]);
      const created = await this.#devices.get(row.account_id, id, NOBODY_ONLINE, id, conn);
      if (!created) throw new Error(`devices row ${id} vanished right after insert`);
      await conn.commit();
      return { accountId: row.account_id, device: created, token };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }
}
