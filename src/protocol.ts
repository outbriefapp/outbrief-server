import { z } from "zod";

/**
 * Where a report came from. `generic` = any HTTP caller; `multica` = a Multica task, reported by the
 * outbrief-daemon that holds the user's Multica token (never POSTed by a hook).
 */
export const AgentSource = z.enum(["claude-code", "codex", "gemini-cli", "generic", "multica"]);
export type AgentSource = z.infer<typeof AgentSource>;

/** Sources that may be POSTed to `/v1/events` / `/v1/daemon/events`. */
export const HookSource = AgentSource.exclude(["multica"]);
export type HookSource = z.infer<typeof HookSource>;

/**
 * Lifecycle of one agent report on the server.
 * received  -> ingested, waiting for the user to take the call
 * completed -> the user took the call and hung up
 * dismissed -> the user declined the call
 * acknowledged -> a missed call the user knows about and will not answer (全部知悉, YOUT-212)
 */
export const EventStatus = z.enum(["received", "completed", "dismissed", "acknowledged"]);
export type EventStatus = z.infer<typeof EventStatus>;

/** Final statuses a client may set after a call. */
export const CallOutcome = EventStatus.exclude(["received"]);
export type CallOutcome = z.infer<typeof CallOutcome>;

export const MAX_REPORT_CHARS = 200_000;

// ---------------------------------------------------------------------------------------------
// End-to-end encryption (ADR 0007). Reports, briefs, replies and reply errors travel as `Sealed`
// text that only the user's outbrief-daemon and apps can open: AES-256-GCM under a key the server
// never sees. The server stores and relays it without reading it.
// ---------------------------------------------------------------------------------------------

/** Longest sealed text accepted (a 200 000-character report plus its brief, encrypted). */
export const MAX_SEALED_CHARS = 2_000_000;

/**
 * `ob1.<keyId>.<iv>.<ciphertext>`: format version, 16 hex chars naming the key (so a client can
 * tell "wrong key" from "corrupt"), then base64url of the 12-byte IV and of ciphertext + GCM tag.
 */
export const SEALED_PATTERN = /^ob1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

const SEALED_HEAD = /^ob1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\./;
const NOT_BASE64URL = /[^A-Za-z0-9_-]/;

/**
 * `SEALED_PATTERN`, checked without matching the ciphertext with a quantifier: V8 runs out of
 * stack on `{22,}` over a few million characters (a dispatch with images, YOUT-226).
 */
function isSealedText(text: string): boolean {
  const head = SEALED_HEAD.exec(text.slice(0, 64))?.[0];
  if (!head) return false;
  const body = text.slice(head.length);
  return body.length >= 22 && !NOT_BASE64URL.test(body);
}

function sealedText(maxChars: number) {
  return z.string().max(maxChars).refine(isSealedText, "not sealed text");
}

export const Sealed = sealedText(MAX_SEALED_CHARS);
export type Sealed = z.infer<typeof Sealed>;

/**
 * Longest sealed settings request an app may relay to a daemon: one dispatch image of up to
 * Multica's 100 MB upload limit (YOUT-226), base64 inside the JSON and again inside the sealed text.
 */
export const MAX_SETTINGS_SEALED_CHARS = 180_000_000;

/**
 * A report with its brief: `POST /v1/daemon/events` (daemon token) or `POST /v1/events` (any device
 * of the account). Everything about it is inside `sealed` (a `SealedReport`); only what the server routes by
 * stays in the clear.
 */
export const ReportSubmission = z.object({
  source: HookSource,
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  sealed: Sealed,
});
export type ReportSubmission = z.infer<typeof ReportSubmission>;

/**
 * `POST /v1/daemon/multica-reports` (daemon token): a finished Multica task the daemon read with
 * the user's own token. `taskId` stays in the clear so one task makes one call. 201 → `AgentEvent`;
 * 409 `duplicate_task` when the task already has a call.
 */
export const MulticaReportInput = z.object({
  taskId: z.string().min(1).max(64),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  sealed: Sealed,
});
export type MulticaReportInput = z.infer<typeof MulticaReportInput>;

// ---------------------------------------------------------------------------------------------
// Inside `sealed`: never seen by the server. The contract between outbrief-daemon, which seals
// reports and opens replies, and the apps, which do the opposite. The server cannot validate it.
// ---------------------------------------------------------------------------------------------

/**
 * Briefs call the listener by this placeholder instead of a fixed title; each client replaces it
 * with the user's own 称呼 setting before showing or speaking the brief.
 */
export const ADDRESS_PLACEHOLDER = "{称呼}";

export const FactImportance = z.enum(["critical", "normal"]);
export type FactImportance = z.infer<typeof FactImportance>;

/** One atomic fact extracted from the report. `critical` facts must be spoken in some segment. */
export const BriefFact = z.object({
  /** Short stable id, e.g. "f1"; referenced by `BriefSegment.coveredFactIds`. */
  id: z.string().min(1),
  text: z.string().min(1),
  importance: FactImportance,
});
export type BriefFact = z.infer<typeof BriefFact>;

/** What the screen shows while the segment is spoken. */
export const BriefCard = z.object({
  title: z.string().min(1),
  bullets: z.array(z.string().min(1)),
});
export type BriefCard = z.infer<typeof BriefCard>;

/** One "page" of the call: a spoken paragraph plus its card. Played in array order. */
export const BriefSegment = z.object({
  /** Short stable id, e.g. "s1". */
  id: z.string().min(1),
  /** Conversational spoken text (assistant voice, conclusion first); split into sentences for TTS. */
  speech: z.string().min(1),
  card: BriefCard,
  coveredFactIds: z.array(z.string()),
});
export type BriefSegment = z.infer<typeof BriefSegment>;

export const DecisionOption = z.object({
  /** Short stable id, e.g. "a". */
  id: z.string().min(1),
  label: z.string().min(1),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

/** A question the agent left for the user. */
export const BriefDecision = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(DecisionOption).min(1),
  recommendedOptionId: z.string().nullable(),
  /** Why the recommended option; null when there is no recommendation. */
  reason: z.string().nullable(),
});
export type BriefDecision = z.infer<typeof BriefDecision>;

/** Overall outcome of the agent's task. */
export const VerdictStatus = z.enum(["done", "partial", "blocked", "failed"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

export const Brief = z.object({
  verdict: z.object({ status: VerdictStatus, headline: z.string().min(1) }),
  facts: z.array(BriefFact),
  segments: z.array(BriefSegment).min(1),
  decisions: z.array(BriefDecision),
});
export type Brief = z.infer<typeof Brief>;

/** Daemon LLM channel that produced the brief (ADR 0004 / 0005): primary or fallback. */
export const LlmChannel = z.enum(["primary", "fallback"]);
export type LlmChannel = z.infer<typeof LlmChannel>;

/**
 * ready  -> `brief` holds the refined brief
 * failed -> the daemon could not generate it (every channel failed, or no LLM configured on that
 *           machine); `brief` is null and clients show the raw report
 */
export const BriefStatus = z.enum(["ready", "failed"]);
export type BriefStatus = z.infer<typeof BriefStatus>;

export const BriefEnvelope = z.object({
  status: BriefStatus,
  brief: Brief.nullable(),
  llmChannel: LlmChannel.nullable(),
  /** Why generation failed; null when ready. */
  error: z.string().nullable(),
  generatedAt: z.iso.datetime({ offset: true }),
});
export type BriefEnvelope = z.infer<typeof BriefEnvelope>;

/** Where a `multica` report came from, and where its reply is posted. */
export const MulticaOrigin = z.object({
  workspaceId: z.string(),
  issueId: z.string(),
  /** e.g. "YOUT-149". */
  issueIdentifier: z.string(),
  issueTitle: z.string(),
  /** The issue's project; null when it is in none. Absent on reports from older daemons. */
  projectId: z.string().nullable().optional(),
  projectTitle: z.string().nullable().optional(),
  /**
   * The issue's priority ("urgent" | "high" | "medium" | "low" | "none") and last update when the
   * task finished. The app sorts its call list by them, refreshed through the local daemon.
   */
  issuePriority: z.string().optional(),
  issueUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  agentId: z.string(),
  agentName: z.string(),
  /** Last comment the task posted: replying to it wakes that same agent. */
  reportCommentId: z.string(),
});
export type MulticaOrigin = z.infer<typeof MulticaOrigin>;

/** Plaintext of a report's `sealed`. AAD: `outbrief:report:v1`. */
export const SealedReport = z.object({
  /** Short human label, usually the project folder name or "YOUT-7 issue title". */
  title: z.string().max(200).optional(),
  /** The agent's final report, verbatim. */
  content: z.string().min(1).max(MAX_REPORT_CHARS),
  /** Working directory the agent ran in. */
  cwd: z.string().max(1_000).optional(),
  /** Agent-native session id; a reply resumes it. */
  sessionId: z.string().max(200).optional(),
  brief: BriefEnvelope,
  /** Set exactly for `multica` reports. */
  multica: MulticaOrigin.optional(),
});
export type SealedReport = z.infer<typeof SealedReport>;

/** Plaintext of a reply's `sealed`. AAD: `outbrief:reply:v1:<eventId>`. */
export const SealedReply = z.object({
  content: z.string().min(1),
  /** The session to resume (hook reports); the daemon looks up its cwd in its own records. */
  sessionId: z.string().nullable(),
  /** Set for `multica` reports: post the reply as a comment under `reportCommentId`. */
  multica: MulticaOrigin.pick({
    workspaceId: true,
    issueId: true,
    reportCommentId: true,
  }).nullable(),
});
export type SealedReply = z.infer<typeof SealedReply>;

/** A daemon's reason why a reply failed is sealed too. AAD: `outbrief:reply-error:v1:<replyId>`. */
export const REPLY_ERROR_AAD_PREFIX = "outbrief:reply-error:v1:";

// ---------------------------------------------------------------------------------------------
// Events as the server stores and relays them.
// ---------------------------------------------------------------------------------------------

/** The user's reply, posted as a Multica comment under the agent's report. */
export const MulticaReply = z.object({
  commentId: z.string(),
  sentAt: z.iso.datetime({ offset: true }),
});
export type MulticaReply = z.infer<typeof MulticaReply>;

/** What the server knows about a `multica` event: its task (one call per task) and the reply. */
export const MulticaReport = z.object({
  taskId: z.string(),
  /** Null until the daemon posted the user's reply. */
  reply: MulticaReply.nullable(),
});
export type MulticaReport = z.infer<typeof MulticaReport>;

/** Machine whose outbrief-daemon relayed the report; replies are delivered to its daemon. */
export const MachineRef = z.object({
  id: z.string(),
  name: z.string(),
  /** Its daemon holds a WebSocket to this server right now. */
  online: z.boolean(),
});
export type MachineRef = z.infer<typeof MachineRef>;

/**
 * Delivery of a reply to the daemon of the event's machine.
 * queued     -> stored, the daemon has not accepted it yet (offline, or not yet sent)
 * dispatched -> the daemon accepted it and is running it
 * delivered  -> the agent ran with the reply / the Multica comment was posted
 * failed     -> the daemon could not run it, or it stayed queued past `expiresAt`
 */
export const DeliveryStatus = z.enum(["queued", "dispatched", "delivered", "failed"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const Delivery = z.object({
  /** Reply id; the daemon executes each id at most once. */
  id: z.string(),
  status: DeliveryStatus,
  /**
   * Why it failed; null otherwise. Sealed when the daemon reported it, plain text when the server
   * failed it (`REPLY_EXPIRED_ERROR`) or the daemon could not open the reply at all.
   */
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  settledAt: z.iso.datetime({ offset: true }).nullable(),
  /** A reply still `queued` at this time fails. */
  expiresAt: z.iso.datetime({ offset: true }),
});
export type Delivery = z.infer<typeof Delivery>;

export const AgentEvent = z.object({
  id: z.string(),
  /** Monotonic server sequence; clients resume streams with it. */
  seq: z.number().int().positive(),
  source: AgentSource,
  status: EventStatus,
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  /** The `SealedReport`. Null once the call ended: the server erases it (ADR 0006). */
  sealed: Sealed.nullable(),
  /** Present exactly when `source` is "multica". */
  multica: MulticaReport.optional(),
  /** Present when an outbrief-daemon relayed the report. */
  machine: MachineRef.optional(),
  /** Present once a reply to a daemon-relayed event was sent. */
  delivery: Delivery.optional(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const UpdateEventStatusInput = z.object({ status: CallOutcome });
export type UpdateEventStatusInput = z.infer<typeof UpdateEventStatusInput>;

/** SSE event name used on `/v1/stream`; the SSE `id` field carries `AgentEvent.seq`. */
export const STREAM_EVENT_NAME = "agent-event";

/**
 * `POST /v1/events/:id/reply` → the updated `AgentEvent` with `delivery` (queued for the machine
 * whose daemon reported it). A Multica event also gets `multica.reply` once that daemon posted the
 * comment. Errors: 404 unknown event, 409 `no_return_path` (no machine) / `already_replied`.
 */
export const SendReplyInput = z.object({ sealed: Sealed });
export type SendReplyInput = z.infer<typeof SendReplyInput>;

/** SSE event name for a changed reply delivery; `data` is the whole updated `AgentEvent`. */
export const DELIVERY_EVENT_NAME = "event-delivery";

/** Replies still `queued` this long after they were sent fail (the machine stayed offline). */
export const REPLY_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Accounts and devices (YOUT-217). There is no login: an account is an anonymous id, and every
// device (app, phone, outbrief-daemon) holds its own revocable bearer token. The first device
// creates the account (`POST /v1/accounts`); the others join it with a one-time pairing code.
// ---------------------------------------------------------------------------------------------

/** `daemon` = an outbrief-daemon machine (the calls come from it); `app` = a desktop / phone app. */
export const DeviceKind = z.enum(["daemon", "app"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** What a new device says about itself. */
export const NewDevice = z.object({
  name: z.string().trim().min(1).max(200),
  kind: DeviceKind,
});
export type NewDevice = z.infer<typeof NewDevice>;

/**
 * Who may create an account (`GET /v1/server`).
 * open   -> anyone (public cloud, `OUTBRIEF_OPEN_SIGNUP=true`; rate limited)
 * claim  -> nobody has claimed this server yet: the first account needs the claim code the server
 *           printed in its log
 * closed -> the server is claimed and signup is off: new devices join an account with a pairing code
 */
export const SignupMode = z.enum(["open", "claim", "closed"]);
export type SignupMode = z.infer<typeof SignupMode>;

export interface ServerInfo {
  signup: SignupMode;
}

/** `POST /v1/accounts` (no bearer): creates an account and its first device. */
export const CreateAccountInput = z.object({
  device: NewDevice,
  /** Required while the server is unclaimed (`signup: "claim"`). */
  claimCode: z.string().trim().max(64).optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  kind: DeviceKind,
  /** A daemon holds its WebSocket, or an app its event stream, right now. */
  online: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }).nullable(),
  /** The device that asked (`GET /v1/devices`). */
  current: z.boolean(),
});
export type Device = z.infer<typeof Device>;

/** `POST /v1/accounts`, `POST /v1/pairing/redeem` → 201. */
export const DeviceSession = z.object({
  accountId: z.string(),
  device: Device,
  /** Bearer for `/v1/*`; returned only here, the server keeps just its hash. */
  token: z.string(),
});
export type DeviceSession = z.infer<typeof DeviceSession>;

/** `GET /v1/me`: the account and device the bearer belongs to. */
export interface Me {
  accountId: string;
  device: Device;
}

/** `GET /v1/devices`: every device of the account, oldest first. */
export interface DevicesResponse {
  devices: Device[];
}

/** Pairing codes are 6 digits, valid this long, and work once. */
export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PairingCodeText = z.string().regex(/^\d{6}$/, "not a 6-digit code");

/** `POST /v1/pairing` → 201: a code another device joins this account with. */
export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** `GET /v1/pairing/:code`: whether the code was used yet, and by which device. */
export interface PairingCodeStatus extends PairingCode {
  usedAt: string | null;
  usedBy: { id: string; name: string; kind: DeviceKind } | null;
}

/**
 * `POST /v1/pairing/redeem` (no bearer): joins the code's account as a new device. 404
 * `invalid_pairing_code` when the code is unknown, expired or used; 429 after too many misses.
 *
 * The end-to-end key never goes through here: a QR code / pairing link carries it from device to
 * device (`outbrief://pair?server=…&code=…&key=obk1_…`), a bare code does not.
 */
export const RedeemPairingInput = z.object({
  code: PairingCodeText,
  device: NewDevice,
});
export type RedeemPairingInput = z.infer<typeof RedeemPairingInput>;

// ---------------------------------------------------------------------------------------------
// Daemon settings through the server (YOUT-217): an app with no local daemon (a phone) changes a
// machine's Multica / LLM / brief-language settings with a request sealed with the end-to-end key.
// The server relays it over the daemon's WebSocket and hands back the sealed answer; it reads
// neither.
// ---------------------------------------------------------------------------------------------

/**
 * `POST /v1/devices/:id/settings` → 200 `{ sealed }` (the daemon's sealed answer). 404 when the
 * device is not a daemon of this account, 409 `machine_offline` / `duplicate_request`, 504
 * `machine_timeout`.
 */
export const SettingsRelayInput = z.object({
  /** Chosen by the app (a UUID): both sides bind their sealed text to it. */
  requestId: z.uuid(),
  sealed: sealedText(MAX_SETTINGS_SEALED_CHARS),
});
export type SettingsRelayInput = z.infer<typeof SettingsRelayInput>;

/**
 * How long the server waits for the daemon's answer: long enough for the daemon to upload a
 * dispatch image of up to 100 MB to Multica (its upload timeout is 120 s).
 */
export const SETTINGS_RELAY_TIMEOUT_MS = 150_000;

/**
 * Inside the request's `sealed` (AAD `outbrief:settings:v1:<requestId>`): the local settings API
 * call to make, e.g. `{ method: "PUT", path: "/llm/settings", body: {...} }`. The answer is sealed
 * under AAD `outbrief:settings-result:v1:<requestId>` as `{ status, body }`.
 */
export const SETTINGS_AAD_PREFIX = "outbrief:settings:v1:";
export const SETTINGS_RESULT_AAD_PREFIX = "outbrief:settings-result:v1:";

/** A reply the server hands to the daemon over `/v1/daemon` (WebSocket). */
export const DaemonReply = z.object({
  id: z.string(),
  eventId: z.string(),
  source: AgentSource,
  /** The `SealedReply` the app sent. */
  sealed: Sealed,
});
export type DaemonReply = z.infer<typeof DaemonReply>;

/** Frames the server sends to a daemon. */
export type ServerFrame =
  | { type: "hello"; machineId: string; machineName: string }
  | { type: "reply"; reply: DaemonReply }
  /** A sealed settings request from an app of the same account (`POST /v1/devices/:id/settings`). */
  | { type: "settings"; requestId: string; sealed: string }
  | { type: "pong" };

/** Longest `error` a daemon may report (sealed, or plain when it could not open the reply). */
export const DELIVERY_ERROR_MAX_CHARS = 8_000;

/** Frames a daemon sends to the server. */
export const DaemonFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({
    type: z.literal("result"),
    replyId: z.string(),
    status: z.enum(["delivered", "failed"]),
    error: z.string().max(DELIVERY_ERROR_MAX_CHARS).nullish(),
    /** Multica comment the reply was posted as (Multica replies only). */
    commentId: z.string().max(64).nullish(),
  }),
  /** The daemon's sealed answer to a `settings` frame. */
  z.object({
    type: z.literal("settings-result"),
    requestId: z.string().max(64),
    sealed: Sealed,
  }),
]);
export type DaemonFrame = z.infer<typeof DaemonFrame>;
