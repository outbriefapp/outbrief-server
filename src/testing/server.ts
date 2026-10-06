import { upgradeWebSocket } from "@hono/node-server";
import type { Pool } from "mysql2/promise";
import { expect } from "vitest";
import { AccountStore } from "../accounts/accounts.ts";
import { DeviceStore } from "../accounts/devices.ts";
import { PairingStore } from "../accounts/pairing.ts";
import { createApp, type Limits } from "../app.ts";
import { DaemonGateway } from "../daemon/gateway.ts";
import { EventStore } from "../eventStore.ts";
import type { DeviceKind, DeviceSession } from "../protocol.ts";

/** Test-only: the server wired as `main.ts` does, over the test pool. */
export function buildServer(
  pool: Pool,
  options: { openSignup?: boolean; heartbeatMs?: number; limits?: Partial<Limits> } = {},
) {
  const store = new EventStore(pool);
  const gateway = new DaemonGateway(store);
  store.usePresence(gateway);
  const devices = new DeviceStore(pool);
  const accounts = new AccountStore(pool, devices, { openSignup: options.openSignup ?? true });
  const app = createApp({
    store,
    accounts: { accounts, devices, pairing: new PairingStore(pool, devices) },
    heartbeatMs: options.heartbeatMs ?? 20,
    daemon: { gateway, upgradeWebSocket },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return { app, store, gateway, accounts };
}

type Fetcher = (path: string, init?: RequestInit) => Response | Promise<Response>;

function json(bearer?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
}

/** Test-only: a new account (open signup) with its first device. */
export async function signup(
  fetcher: Fetcher,
  device: { name: string; kind: DeviceKind } = { name: "Mac", kind: "app" },
  claimCode?: string,
): Promise<DeviceSession> {
  const res = await fetcher("/v1/accounts", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ device, ...(claimCode ? { claimCode } : {}) }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as DeviceSession;
}

/** Test-only: another device joins `bearer`'s account with a fresh pairing code. */
export async function join(
  fetcher: Fetcher,
  bearer: string,
  device: { name: string; kind: DeviceKind },
): Promise<DeviceSession> {
  const created = await fetcher("/v1/pairing", { method: "POST", headers: json(bearer) });
  expect(created.status).toBe(201);
  const { code } = (await created.json()) as { code: string };
  const res = await fetcher("/v1/pairing/redeem", {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ code, device }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as DeviceSession;
}
