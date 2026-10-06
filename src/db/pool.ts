import { createPool, type Pool } from "mysql2/promise";

/** All DATETIME columns hold UTC; `timezone: "Z"` keeps mysql2 from shifting them to local time. */
export function openPool(databaseUrl: string): Pool {
  return createPool({ uri: databaseUrl, timezone: "Z", charset: "utf8mb4", connectionLimit: 10 });
}
