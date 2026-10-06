import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Device, DeviceKind, NewDevice } from "../protocol.ts";

interface DeviceRow extends RowDataPacket {
  id: string;
  account_id: string;
  kind: DeviceKind;
  name: string;
  created_at: Date;
  last_seen_at: Date | null;
}

/** Tells whether a device is connected right now (a daemon's WebSocket, an app's event stream). */
export interface DevicePresence {
  isOnline(deviceId: string): boolean;
}

/** The device a bearer token belongs to. */
export interface AuthDevice {
  id: string;
  accountId: string;
  kind: DeviceKind;
  name: string;
}

/**
 * Tokens carry a recognizable prefix per kind. Daemon tokens keep the `obm_` of the machine tokens
 * paired before accounts existed, which stay valid.
 */
const TOKEN_PREFIX: Record<DeviceKind, string> = { daemon: "obm_", app: "oba_" };

/** Don't write `last_seen_at` more often than this per device. */
const TOUCH_EVERY_MS = 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type Db = Pick<Pool, "execute"> | PoolConnection;

const COLUMNS = "id, account_id, kind, name, created_at, last_seen_at";

/** Every device of every account, with its revocable token (only hashes are stored). */
export class DeviceStore {
  readonly #pool: Pool;
  readonly #touched = new Map<string, number>();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  /** Adds a device to the account; `db` lets account creation and pairing run it in their transaction. */
  async create(
    accountId: string,
    device: NewDevice,
    now = new Date(),
    db: Db = this.#pool,
  ): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = TOKEN_PREFIX[device.kind] + randomBytes(32).toString("base64url");
    await db.execute(
      `INSERT INTO devices (id, account_id, kind, name, token_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, accountId, device.kind, device.name, hashToken(token), now, now],
    );
    return { id, token };
  }

  /** The unrevoked device the token belongs to; notes that it was seen. */
  async authenticate(token: string): Promise<AuthDevice | undefined> {
    if (!Object.values(TOKEN_PREFIX).some((prefix) => token.startsWith(prefix))) return undefined;
    const [rows] = await this.#pool.execute<DeviceRow[]>(
      `SELECT ${COLUMNS} FROM devices WHERE token_hash = ? AND revoked_at IS NULL`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return undefined;
    await this.#touch(row.id);
    return { id: row.id, accountId: row.account_id, kind: row.kind, name: row.name };
  }

  /** The account's devices that are not revoked, oldest first. */
  async list(accountId: string, presence: DevicePresence, currentId: string): Promise<Device[]> {
    const [rows] = await this.#pool.execute<DeviceRow[]>(
      `SELECT ${COLUMNS} FROM devices WHERE account_id = ? AND revoked_at IS NULL
       ORDER BY created_at, id`,
      [accountId],
    );
    return rows.map((row) => toDevice(row, presence, currentId));
  }

  async get(
    accountId: string,
    id: string,
    presence: DevicePresence,
    currentId: string,
    db: Db = this.#pool,
  ): Promise<Device | undefined> {
    const [rows] = await db.execute<DeviceRow[]>(
      `SELECT ${COLUMNS} FROM devices WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
      [id, accountId],
    );
    return rows[0] ? toDevice(rows[0], presence, currentId) : undefined;
  }

  /** Revokes a device of this account; false when there is none (another account's is none too). */
  async revoke(accountId: string, id: string, now = new Date()): Promise<boolean> {
    const [result] = await this.#pool.execute<ResultSetHeader>(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
      [now, id, accountId],
    );
    return result.affectedRows > 0;
  }

  async #touch(id: string, now = new Date()): Promise<void> {
    const last = this.#touched.get(id);
    if (last !== undefined && now.getTime() - last < TOUCH_EVERY_MS) return;
    this.#touched.set(id, now.getTime());
    await this.#pool.execute("UPDATE devices SET last_seen_at = ? WHERE id = ?", [now, id]);
  }
}

function toDevice(row: DeviceRow, presence: DevicePresence, currentId: string): Device {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    online: presence.isOnline(row.id),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    current: row.id === currentId,
  };
}
