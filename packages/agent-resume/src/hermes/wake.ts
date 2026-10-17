import { timingSafeEqual } from "node:crypto";

/**
 * Hermes binding: address exactly one already-selected Hermes session.
 *
 * The locator is immutable and validated here; nothing is discovered. The wake
 * itself goes to the Gateway's authenticated loopback seam, and a receipt that
 * does not match the bound target is refused — a wake that reached some other
 * chat is a failed delivery, not a success.
 */
export interface HermesLocator {
  schema: string;
  session_key: string;
  platform: string;
  chat_id: string;
  chat_type: string;
  thread_id?: string;
  user_id?: string;
  user_id_alt?: string;
  scope_id?: string;
  prospective_thread_id?: string;
  profile?: string;
}

export interface HermesWakeReceipt {
  receipt_id: string;
  receipt_ref: string;
  status: "accepted" | "failed";
  target: HermesLocator | null;
  result_ref: string | null;
  reason?: string;
  error?: string;
}

const PLATFORM_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
const CHAT_TYPES = new Set(["dm", "group", "channel", "thread", "webhook"]);
const OPAQUE_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTIONAL_FIELDS = ["thread_id", "user_id", "user_id_alt", "scope_id", "prospective_thread_id", "profile"] as const;

function requiredString(value: unknown, field: string): string {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`locator.${field} is required`);
  return String(value).trim();
}

/** Validate the exact-session locator; discovery is never involved. */
export function resolveHermesLocator(locator: unknown): HermesLocator {
  if (!locator || typeof locator !== "object") throw new Error("locator is required");
  const record = locator as Record<string, unknown>;
  if (String(record.schema ?? "") !== "hermes.locator.v2") throw new Error("unsupported Hermes locator schema");
  const platform = requiredString(record.platform, "platform");
  if (!PLATFORM_PATTERN.test(platform)) throw new Error("locator.platform is unsupported");
  const chatType = requiredString(record.chat_type, "chat_type");
  if (!CHAT_TYPES.has(chatType)) throw new Error("locator.chat_type is unsupported");
  const target: HermesLocator = {
    schema: "hermes.locator.v2",
    session_key: requiredString(record.session_key, "session_key"),
    platform,
    chat_id: requiredString(record.chat_id, "chat_id"),
    chat_type: chatType,
  };
  for (const field of OPTIONAL_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    target[field] = String(value).trim();
  }
  return target;
}

export function validateHermesResultRef(value: unknown): string {
  const reference = String(value ?? "").trim();
  if (!OPAQUE_REF.test(reference)) throw new Error("result_ref must be an opaque UUID reference");
  return reference;
}

export interface HermesWakeClientOptions {
  endpoint: string;
  token: string;
  timeoutMs?: number;
}

/** Client for the Gateway's authenticated wake seam. */
export class HermesWakeClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: HermesWakeClientOptions) {
    if (!options.endpoint || !options.token) throw new Error("Hermes wake endpoint and token are required");
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  async wake(locator: unknown, resultRef: unknown): Promise<HermesWakeReceipt> {
    const target = resolveHermesLocator(locator);
    const reference = validateHermesResultRef(resultRef);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ locator: target, result_ref: reference }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok || value.status !== "accepted") {
      return {
        receipt_id: String(value.receipt_id ?? `hermes-wake-${Date.now()}`),
        receipt_ref: String(value.receipt_ref ?? value.receipt_id ?? ""),
        status: "failed",
        target,
        result_ref: reference,
        reason: String(value.reason ?? "failed"),
        error: typeof value.error === "string" ? value.error.slice(0, 300) : `HTTP ${response.status}`,
      };
    }
    // A receipt for another chat is not a delivery of this one.
    if (JSON.stringify(value.target ?? null) !== JSON.stringify(target)) {
      return {
        receipt_id: String(value.receipt_id ?? ""),
        receipt_ref: String(value.receipt_ref ?? value.receipt_id ?? ""),
        status: "failed",
        target,
        result_ref: reference,
        reason: "failed",
        error: "Hermes wake receipt does not match the bound target",
      };
    }
    return {
      receipt_id: String(value.receipt_id ?? ""),
      receipt_ref: String(value.receipt_ref ?? value.receipt_id ?? ""),
      status: "accepted",
      target,
      result_ref: reference,
    };
  }
}

/** Constant-time bearer check for a loopback wake receiver. */
export function hermesTokenMatches(expected: string | undefined, authorization: string | undefined): boolean {
  if (!expected) return false;
  const supplied = String(authorization ?? "");
  const want = Buffer.from(`Bearer ${expected}`);
  const got = Buffer.from(supplied);
  if (want.length !== got.length) return false;
  return timingSafeEqual(want, got);
}

/** Hermes wake client built from the environment the old service used. */
export function hermesWakeClientFromEnv(env: NodeJS.ProcessEnv = process.env): HermesWakeClient | undefined {
  const endpoint = env.AGENT_RESUME_HERMES_ENDPOINT?.trim();
  const token = env.AGENT_RESUME_HERMES_TOKEN?.trim();
  return endpoint && token ? new HermesWakeClient({ endpoint, token }) : undefined;
}