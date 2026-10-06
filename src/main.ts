import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { AccountStore } from "./accounts/accounts.ts";
import { DeviceStore } from "./accounts/devices.ts";
import { PairingStore } from "./accounts/pairing.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { DaemonGateway } from "./daemon/gateway.ts";
import { migrate } from "./db/migrate.ts";
import { openPool } from "./db/pool.ts";
import { EventStore } from "./eventStore.ts";

const config = loadConfig();
const applied = await migrate(config.databaseUrl);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);

const pool = openPool(config.databaseUrl);
const store = new EventStore(pool);
const gateway = new DaemonGateway(store);
store.usePresence(gateway);
const devices = new DeviceStore(pool);
const accounts = new AccountStore(pool, devices, { openSignup: config.openSignup });
const pairing = new PairingStore(pool, devices);

const app = createApp({
  store,
  accounts: { accounts, devices, pairing },
  daemon: { gateway, upgradeWebSocket },
});

// A private server is claimed by whoever has its log: the first account needs this code.
const claimCode = await accounts.claimCode();
if (claimCode) {
  console.log(
    [
      "",
      "================================================================",
      ` Claim code: ${claimCode}`,
      " Nobody owns this server yet. Enter this code on the first device",
      " (app or `outbrief-daemon login`) to create your account; after",
      " that no new accounts can be created (OUTBRIEF_OPEN_SIGNUP=true",
      " allows them). A new code is printed on every start until then.",
      "================================================================",
      "",
    ].join("\n"),
  );
} else {
  console.log(`signup: ${config.openSignup ? "open" : "closed (join with a pairing code)"}`);
}
const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    websocket: { server: new WebSocketServer({ noServer: true }) },
  },
  (info) => {
    console.log(`outbrief server listening on http://localhost:${info.port}`);
  },
);

// Replies left `queued` past their expiry fail (the machine stayed offline).
const expiry = setInterval(() => {
  store.expireReplies().catch((err) => console.error("[daemon-replies] expiry failed", err));
}, 60_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    clearInterval(expiry);
    gateway.closeAll();
    server.close();
    store.close();
    await pool.end();
    process.exit(0);
  });
}
