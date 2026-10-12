import { readFileSync } from "node:fs";

export interface ServerConfig {
  port: number;
  /** mysql://user:pass@host:3306/outbrief */
  databaseUrl: string;
  /** Anyone may create an account (public cloud). Off: the first account needs the claim code. */
  openSignup: boolean;
  /**
   * Firebase service account that sends call pushes to Android (ADR 0010); null: no pushes, calls
   * reach a phone only while it holds its event stream.
   */
  fcmServiceAccount: FcmServiceAccount | null;
}

/** The fields of a service account key file that FCM needs. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** The local docker MySQL from `db/bootstrap.sql`; deployment platforms inject their own URL. */
export const LOCAL_DATABASE_URL = "mysql://outbrief:outbrief_local@127.0.0.1:3306/outbrief";

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

/**
 * `OUTBRIEF_FCM_SERVICE_ACCOUNT`: the key file's JSON (a deployment platform's variable), or the
 * path to the file. Set but unreadable fails the start: the server does not run without the pushes
 * it was told to send.
 */
function fcmServiceAccount(env: NodeJS.ProcessEnv): FcmServiceAccount | null {
  const raw = env.OUTBRIEF_FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  const text = raw.startsWith("{") ? raw : readFileSync(raw, "utf8");
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("OUTBRIEF_FCM_SERVICE_ACCOUNT is not a service account key (invalid JSON)");
  }
  const { project_id, client_email, private_key } = key;
  if (
    key.type !== "service_account" ||
    typeof project_id !== "string" ||
    typeof client_email !== "string" ||
    typeof private_key !== "string"
  ) {
    throw new Error("OUTBRIEF_FCM_SERVICE_ACCOUNT is not a service account key");
  }
  return { projectId: project_id, clientEmail: client_email, privateKey: private_key };
}

/** Every setting has a default: the server starts with no environment and no `.env`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: positiveInt(env, "PORT", 8787),
    databaseUrl: env.OUTBRIEF_DATABASE_URL?.trim() || LOCAL_DATABASE_URL,
    openSignup: flag(env, "OUTBRIEF_OPEN_SIGNUP"),
    fcmServiceAccount: fcmServiceAccount(env),
  };
}
