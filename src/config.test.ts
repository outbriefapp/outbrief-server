import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const KEY = {
  type: "service_account",
  project_id: "outbrief-test",
  client_email: "push@outbrief-test.iam.gserviceaccount.com",
  private_key: "not-a-real-key",
};
const ACCOUNT = {
  projectId: KEY.project_id,
  clientEmail: KEY.client_email,
  privateKey: KEY.private_key,
};

describe("OUTBRIEF_FCM_SERVICE_ACCOUNT", () => {
  it("is off by default", () => {
    expect(loadConfig({}).fcmServiceAccount).toBeNull();
  });

  it("takes the key file's JSON, or the path to the file", async () => {
    expect(
      loadConfig({ OUTBRIEF_FCM_SERVICE_ACCOUNT: JSON.stringify(KEY) }).fcmServiceAccount,
    ).toEqual(ACCOUNT);
    const dir = await mkdtemp(join(tmpdir(), "outbrief-fcm-"));
    try {
      const file = join(dir, "key.json");
      await writeFile(file, JSON.stringify(KEY));
      expect(loadConfig({ OUTBRIEF_FCM_SERVICE_ACCOUNT: file }).fcmServiceAccount).toEqual(ACCOUNT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start with something that is not a service account key", () => {
    expect(() => loadConfig({ OUTBRIEF_FCM_SERVICE_ACCOUNT: "{not json" })).toThrow(/invalid JSON/);
    expect(() =>
      loadConfig({ OUTBRIEF_FCM_SERVICE_ACCOUNT: JSON.stringify({ ...KEY, type: "user" }) }),
    ).toThrow(/not a service account key/);
    expect(() => loadConfig({ OUTBRIEF_FCM_SERVICE_ACCOUNT: "/no/such/key.json" })).toThrow();
  });
});
