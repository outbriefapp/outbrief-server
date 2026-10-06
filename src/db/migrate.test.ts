import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { expect, it } from "vitest";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";
import { testDatabaseUrl } from "./testDatabase.ts";

const RETIRED_TABLES = new Set(["sessions", "users", "briefs", "tts_usage"]);

async function accountCount(url: string): Promise<number> {
  const conn = await createConnection({ uri: url });
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM accounts");
    return Number(rows[0]?.n);
  } finally {
    await conn.end();
  }
}

async function tableNames(url: string): Promise<string[]> {
  const conn = await createConnection({ uri: url });
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    return rows.map((row) => String(row.name));
  } finally {
    await conn.end();
  }
}

it("applies each migration once and drops retired tables", async () => {
  const url = testDatabaseUrl();
  const conn = await createConnection({ uri: url });
  await conn.query(
    "DROP TABLE IF EXISTS sessions, users, daemon_replies, pairing_codes, machines, devices, multica_reports, briefs, tts_usage, agent_events, accounts, schema_migrations",
  );
  await conn.end();

  expect(await migrate(url)).toEqual([
    "001_agent_events",
    "004_multica_reports",
    "005_daemon_replies",
    "009_erase_finished_calls",
    "010_sealed_payloads",
    "011_drop_retired_tables",
    "012_accounts_and_devices",
  ]);
  expect(await migrate(url)).toEqual([]);
  expect(await tableNames(url)).toEqual([
    "accounts",
    "agent_events",
    "daemon_replies",
    "devices",
    "multica_reports",
    "pairing_codes",
    "schema_migrations",
  ]);
  // A fresh database has nothing to own, so no default account: the server starts unclaimed.
  expect(await accountCount(url)).toBe(0);

  // A database that applied the old migrations can still have these tables. The next migrate drops them.
  const leftover = await createConnection({ uri: url, multipleStatements: true });
  await leftover.query(`
    CREATE TABLE users (id CHAR(36) NOT NULL PRIMARY KEY);
    CREATE TABLE sessions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
    );
    CREATE TABLE briefs (
      event_id CHAR(36) NOT NULL PRIMARY KEY,
      CONSTRAINT fk_briefs_event FOREIGN KEY (event_id) REFERENCES agent_events (id) ON DELETE CASCADE
    );
    CREATE TABLE tts_usage (
      day DATE NOT NULL,
      user_key CHAR(64) NOT NULL,
      chars INT UNSIGNED NOT NULL,
      PRIMARY KEY (day, user_key)
    );
  `);
  await leftover.query("DELETE FROM schema_migrations WHERE version = '011_drop_retired_tables'");
  await leftover.end();

  expect(await migrate(url)).toEqual(["011_drop_retired_tables"]);
  expect((await tableNames(url)).filter((name) => RETIRED_TABLES.has(name))).toEqual([]);
});

it("moves the data from before accounts into one default account, keeping machine tokens", async () => {
  const url = testDatabaseUrl();
  const conn = await createConnection({ uri: url, multipleStatements: true });
  await conn.query(
    "DROP TABLE IF EXISTS daemon_replies, pairing_codes, machines, devices, multica_reports, agent_events, accounts, schema_migrations",
  );
  await conn.end();

  // Apply everything up to 011, then fill it the way a single-user server was used.
  const before = await mkdtemp(join(tmpdir(), "outbrief-migrations-"));
  try {
    for (const file of await readdir(MIGRATIONS_DIR)) {
      if (file < "012") await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
    }
    await migrate(url, before);
  } finally {
    await rm(before, { recursive: true, force: true });
  }
  const old = await createConnection({ uri: url, multipleStatements: true });
  await old.query(`
    INSERT INTO machines (id, name, token_hash, created_at)
      VALUES ('m1', 'mac-mini', '${"a".repeat(64)}', UTC_TIMESTAMP(3));
    INSERT INTO agent_events (id, source, machine_id, sealed, status, occurred_at, received_at)
      VALUES ('e1', 'multica', 'm1', NULL, 'completed', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
    INSERT INTO multica_reports (event_id, task_id) VALUES ('e1', 'task-1');
    INSERT INTO daemon_replies (id, event_id, machine_id, sealed, status, created_at, expires_at)
      VALUES ('r1', 'e1', 'm1', '', 'delivered', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3));
  `);
  await old.end();

  expect(await migrate(url)).toEqual(["012_accounts_and_devices"]);

  const check = await createConnection({ uri: url });
  try {
    const [accounts] = await check.query<RowDataPacket[]>("SELECT id, created_via FROM accounts");
    expect(accounts).toEqual([{ id: expect.any(String), created_via: "migration" }]);
    const accountId = accounts[0]?.id;
    const [devices] = await check.query<RowDataPacket[]>(
      "SELECT id, account_id, kind, token_hash FROM devices",
    );
    expect(devices).toEqual([
      { id: "m1", account_id: accountId, kind: "daemon", token_hash: "a".repeat(64) },
    ]);
    const [events] = await check.query<RowDataPacket[]>("SELECT account_id FROM agent_events");
    expect(events).toEqual([{ account_id: accountId }]);
    const [reports] = await check.query<RowDataPacket[]>("SELECT account_id FROM multica_reports");
    expect(reports).toEqual([{ account_id: accountId }]);
    // The reply still points at its machine through the renamed table.
    const [replies] = await check.query<RowDataPacket[]>(
      "SELECT d.name FROM daemon_replies r JOIN devices d ON d.id = r.machine_id",
    );
    expect(replies).toEqual([{ name: "mac-mini" }]);
  } finally {
    await check.end();
  }
});
