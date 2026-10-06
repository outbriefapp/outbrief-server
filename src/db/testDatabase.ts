import type { Pool } from "mysql2/promise";

/** The local docker MySQL's test database (`db/bootstrap.sql`); CI sets its own. */
const LOCAL_TEST_DATABASE_URL = "mysql://outbrief:outbrief_local@127.0.0.1:3306/outbrief_test";

/** Test-only: URL of the throwaway database the integration tests truncate and drop tables in. */
export function testDatabaseUrl(): string {
  const url = process.env.OUTBRIEF_TEST_DATABASE_URL?.trim() || LOCAL_TEST_DATABASE_URL;
  // Tests TRUNCATE / DROP tables; refuse anything that is not clearly a test database.
  if (!new URL(url).pathname.endsWith("_test")) {
    throw new Error(`OUTBRIEF_TEST_DATABASE_URL must point at a *_test database, got ${url}`);
  }
  return url;
}

/**
 * Test-only: empties every table. TRUNCATE also resets AUTO_INCREMENT, so each test starts at
 * seq 1; FK checks are off on this connection because child tables reference `agent_events` /
 * `devices` / `accounts`.
 */
export async function resetTables(pool: Pool): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of [
      "daemon_replies",
      "multica_reports",
      "agent_events",
      "pairing_codes",
      "devices",
      "accounts",
    ]) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}
