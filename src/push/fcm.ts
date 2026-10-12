import { cert, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";
import type { CallPushData } from "../protocol.ts";
import type { PushResult, PushSender } from "./push.ts";

/** FCM error codes meaning the token is gone for good: stop pushing it. */
const GONE = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/**
 * Firebase Cloud Messaging (HTTP v1) with a service account of the Firebase project the Android app
 * is built with. Calls go as high-priority data messages: Android delivers them at once even in
 * Doze and lets the app show its full-screen call.
 */
export class FcmSender implements PushSender {
  readonly provider = "fcm";
  readonly #messaging: Messaging;

  /** `serviceAccount`: the service account key file's JSON (Firebase → 项目设置 → 服务账号). */
  constructor(serviceAccount: ServiceAccount) {
    const app = initializeApp({ credential: cert(serviceAccount) }, "outbrief-fcm");
    this.#messaging = getMessaging(app);
  }

  async send(token: string, data: CallPushData, ttlMs: number): Promise<PushResult> {
    try {
      await this.#messaging.send({
        token,
        data,
        android: { priority: "high", ttl: Math.max(0, Math.floor(ttlMs)) },
      });
      return "sent";
    } catch (err) {
      if (GONE.has((err as { code?: string }).code ?? "")) return "unregistered";
      throw err;
    }
  }
}
