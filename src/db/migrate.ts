import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, type RowDataPacket } from "mysql2/promise";

export const MIGRATIONS_DIR = join(import.meta.dirname, "../../db/migrations");

/**
 * Applies `db/migrations/NNN_*.sql` in filename order, each at most once (tracked in
 * `schema_migrations`). Returns the versions applied by this call.
 *
 * MySQL DDL auto-commits, so a failing file can leave earlier statements applied; keep one change
 * per file and fix forward with a new file.
 */
export async function migrate(databaseUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const conn = await createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    VARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
       ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    );
    const [rows] = await conn.query<RowDataPacket[]>("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => String(r.version)));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

    const applied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      await conn.query(await readFile(join(dir, file), "utf8"));
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      applied.push(version);
    }
    return applied;
  } finally {
    await conn.end();
  }
}
