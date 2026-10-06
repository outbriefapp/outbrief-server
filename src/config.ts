export interface ServerConfig {
  port: number;
  /** mysql://user:pass@host:3306/outbrief */
  databaseUrl: string;
  /** Anyone may create an account (public cloud). Off: the first account needs the claim code. */
  openSignup: boolean;
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

/** Every setting has a default: the server starts with no environment and no `.env`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: positiveInt(env, "PORT", 8787),
    databaseUrl: env.OUTBRIEF_DATABASE_URL?.trim() || LOCAL_DATABASE_URL,
    openSignup: flag(env, "OUTBRIEF_OPEN_SIGNUP"),
  };
}
