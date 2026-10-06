import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { DeviceSession, NewDevice, SignupMode } from "../protocol.ts";
import type { DevicePresence, DeviceStore } from "./devices.ts";

/** Why `create` refused: signup is closed, or the claim code is missing / wrong. */
export class SignupError extends Error {
  override name = "SignupError";
  readonly code: "signup_closed" | "invalid_claim_code";

  constructor(code: SignupError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Claim codes: 12 characters of Crockford base32 (no I, L, O, U), shown as XXXX-XXXX-XXXX. */
const CLAIM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newClaimCode(): string {
  const chars = Array.from({ length: 12 }, () => CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** Case, spaces and dashes don't matter when the code is typed back. */
function normalizeClaimCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(normalizeClaimCode(a));
  const right = Buffer.from(normalizeClaimCode(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

const NOBODY_ONLINE: DevicePresence = { isOnline: () => false };

/**
 * Anonymous accounts: an id and nothing else, created together with the account's first device.
 *
 * Who may create one depends on the deployment. The public cloud runs with `openSignup` (rate
 * limited by the caller). A private server starts unclaimed: it prints a one-time claim code in
 * its log, the first account needs it, and after that signup is off, so someone who learns the
 * server's address still cannot use it. New devices join an existing account with a pairing code
 * either way.
 */
export class AccountStore {
  readonly #pool: Pool;
  readonly #devices: DeviceStore;
  readonly #openSignup: boolean;
  /** Set while the server is unclaimed and `claimCode()` was asked for it. */
  #claimCode: string | null = null;
  /** Account creation runs one at a time, so two claims cannot both see an unclaimed server. */
  #creating: Promise<unknown> = Promise.resolve();

  constructor(pool: Pool, devices: DeviceStore, options: { openSignup: boolean }) {
    this.#pool = pool;
    this.#devices = devices;
    this.#openSignup = options.openSignup;
  }

  async signupMode(): Promise<SignupMode> {
    if (this.#openSignup) return "open";
    return (await this.#claimed()) ? "closed" : "claim";
  }

  /**
   * The claim code of an unclaimed server (a new one per process), or null once the server is
   * claimed or signup is open. The server prints it on start.
   */
  async claimCode(): Promise<string | null> {
    if ((await this.signupMode()) !== "claim") return null;
    this.#claimCode ??= newClaimCode();
    return this.#claimCode;
  }

  /** Creates an account with its first device; throws `SignupError` when that is not allowed. */
  create(
    device: NewDevice,
    claimCode: string | undefined,
    now = new Date(),
  ): Promise<DeviceSession> {
    const run = this.#creating.then(async () => {
      const mode = await this.signupMode();
      if (mode === "closed") throw new SignupError("signup_closed");
      if (
        mode === "claim" &&
        !(claimCode && this.#claimCode && sameCode(claimCode, this.#claimCode))
      ) {
        throw new SignupError("invalid_claim_code");
      }
      const session = await this.#insert(mode === "claim" ? "claim" : "signup", device, now);
      if (mode === "claim") this.#claimCode = null;
      return session;
    });
    this.#creating = run.catch(() => undefined);
    return run;
  }

  async #insert(via: "signup" | "claim", device: NewDevice, now: Date): Promise<DeviceSession> {
    const accountId = randomUUID();
    const conn = await this.#pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("INSERT INTO accounts (id, created_via, created_at) VALUES (?, ?, ?)", [
        accountId,
        via,
        now,
      ]);
      const { id, token } = await this.#devices.create(accountId, device, now, conn);
      const created = await this.#devices.get(accountId, id, NOBODY_ONLINE, id, conn);
      if (!created) throw new Error(`devices row ${id} vanished right after insert`);
      await conn.commit();
      return { accountId, device: created, token };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async #claimed(): Promise<boolean> {
    const [rows] = await this.#pool.execute<RowDataPacket[]>("SELECT 1 FROM accounts LIMIT 1");
    return rows.length > 0;
  }
}
