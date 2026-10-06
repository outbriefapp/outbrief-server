import { loadConfig } from "../config.ts";
import { migrate } from "./migrate.ts";

const { databaseUrl } = loadConfig();
const applied = await migrate(databaseUrl);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
