import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CanonicalAutomationClient } from "./canonical-herder.js";
import { CanonicalHerderError, requireCanonicalMigrationReady } from "./canonical-herder.js";
import { readRetainedResumeAfter } from "./canonical-migration.js";
import { DEFAULT_RESUME_AFTER_MESSAGE, validRfc3339Instant } from "./resume-after.js";
import type { ResumeAfterBackend, ResumeAfterRequest, ResumeAfterTrigger, ResumeAfterWait, SessionRef } from "./resume-after.js";

type ObjectValue = Record<string, unknown>;
type CanonicalRule = { kind: "timer"; trigger: { kind: "delay"; delay_ms: number } | { kind: "at"; at: string }; wake_message: string }
  | { kind: "session_completion"; dependencies: string[]; wake_message: string };
const key = (ref: SessionRef): string => JSON.stringify([ref.harness, ref.sessionId]);
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_wait_projection_invalid");
  return value as ObjectValue;
};
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const publicId = (value: string): boolean => /^wait-rule:[a-f0-9]{64}$/.test(value);
const legacyId = (value: string): boolean => /^wait_[a-f0-9]{32}$/.test(value);
const facadeKey = (value: unknown): value is string => typeof value === "string" && /^resume-after:wait_[a-f0-9]{32}$/.test(value);
const phaseState: Record<string, ResumeAfterWait["state"]> = {
  armed: "waiting", paused: "delivery_blocked", cancelled: "cancelled", dispatching: "dispatching",
  waiting_receipt: "delivery_unknown", delivery_unknown: "delivery_unknown", confirmed: "resumed", rejected: "delivery_blocked",
};

function fingerprint(wait: Pick<ResumeAfterWait, "owner" | "dependencies" | "message" | "trigger" | "humanRequestId" | "expiresAt">): string {
  return JSON.stringify({ owner: wait.owner, dependencies: wait.dependencies, message: wait.message,
    ...(wait.trigger ? { trigger: wait.trigger } : {}), ...(wait.humanRequestId ? { humanRequestId: wait.humanRequestId } : {}),
    ...(wait.expiresAt ? { expiresAt: wait.expiresAt } : {}),
  });
}

/** Preserve the legacy retry key without computing a new due time in the facade. */
export function canonicalResumeRequest(input: ResumeAfterRequest): {
  legacyId: string; requestKey: string; owner: SessionRef; dependencies: SessionRef[]; message: string; fingerprint: string;
} {
  const valid = (ref: SessionRef): boolean => Boolean(ref && exact(ref.harness) && exact(ref.sessionId));
  if (!valid(input.owner)) throw new Error("An exact owner session is required");
  if (input.humanRequestId !== undefined || input.expiresAt !== undefined) throw new Error("canonical_human_request_wait_unsupported");
  const requested = input.dependencies ?? [];
  if (!Array.isArray(requested) || requested.length > 32 || !requested.every(valid)) throw new Error("Dependencies must contain at most 32 exact sessions");
  if (input.trigger && requested.length) throw new Error("A scheduled resume cannot also wait for session dependencies");
  if (!input.trigger && !requested.length) throw new Error("Provide a schedule trigger or 1..32 session dependencies");
  const dependencies = [...new Map(requested.map(ref => [key(ref), { ...ref }])).values()].sort((a, b) => key(a).localeCompare(key(b)));
  if (dependencies.some(ref => key(ref) === key(input.owner))) throw new Error("A session cannot wait for itself");
  const message = input.message ?? DEFAULT_RESUME_AFTER_MESSAGE;
  if (typeof message !== "string" || !message.trim() || message.length > 16000) throw new Error("A nonempty continuation up to 16000 characters is required");
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 256)) throw new Error("A stable requestId up to 256 characters is required");
  if (input.trigger) {
    if (!input.requestId?.trim() || !input.message?.trim()) throw new Error("A scheduled resume requires an explicit message and stable requestId");
    if (input.trigger.kind === "delay") {
      if (!Number.isSafeInteger(input.trigger.delayMs) || input.trigger.delayMs <= 0) throw new Error("delayMs must be a positive safe integer");
    } else if (input.trigger.kind !== "at" || !validRfc3339Instant(input.trigger.at)) throw new Error("at must be a timezone-qualified RFC3339 instant");
  }
  const signature = fingerprint({ owner: input.owner, dependencies, message, ...(input.trigger ? { trigger: input.trigger } : {}) });
  const id = "wait_" + createHash("sha256").update(JSON.stringify([key(input.owner), input.requestId ?? signature])).digest("hex").slice(0, 32);
  return { legacyId: id, requestKey: "resume-after:" + id, owner: { ...input.owner }, dependencies, message, fingerprint: signature };
}

function nativeOwner(value: unknown): SessionRef {
  const owner = object(value);
  if (!exact(owner.harness) || !exact(owner.native_session_id) || !exact(owner.node_ref) || !exact(owner.instance_ref)) throw new Error("canonical_wait_owner_invalid");
  return { harness: owner.harness, sessionId: owner.native_session_id };
}

function projection(value: unknown, epoch: string): { raw: ObjectValue; wait: ResumeAfterWait; rule: CanonicalRule } {
  const raw = object(value);
  const rule = object(raw.rule);
  const state = object(raw.wait);
  if (typeof raw.rule_ref !== "string" || !publicId(raw.rule_ref) || !exact(raw.session_ref)
    || !facadeKey(raw.request_key) || typeof raw.status !== "string" || !Object.hasOwn(phaseState, raw.status)
    || state.phase !== raw.status || typeof raw.created_at !== "string" || !validRfc3339Instant(raw.created_at)
    || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1
    || !["timer", "session_completion"].includes(String(raw.kind)) || rule.kind !== raw.kind
    || typeof rule.wake_message !== "string" || !rule.wake_message.trim() || rule.wake_message.length > 16000
    || !Array.isArray(raw.dependencies)) throw new Error("canonical_wait_projection_invalid");
  const owner = nativeOwner(raw.owner);
  const dependencies: SessionRef[] = [];
  const dependencyTurns: Record<string, string> = {};
  const canonicalDependencies: string[] = [];
  for (const value of raw.dependencies) {
    const dependency = object(value);
    const native = nativeOwner(dependency.owner);
    if (!exact(dependency.session_ref) || !exact(dependency.native_turn_id)) throw new Error("canonical_wait_dependency_invalid");
    dependencies.push(native);
    dependencyTurns[key(native)] = dependency.native_turn_id;
    canonicalDependencies.push(dependency.session_ref);
  }
  let trigger: ResumeAfterTrigger | undefined;
  let scheduledAt: string | undefined;
  if (rule.kind === "timer") {
    const nativeTrigger = object(rule.trigger);
    if (dependencies.length !== 0 || typeof raw.due_at !== "string" || !validRfc3339Instant(raw.due_at)
      || !Number.isSafeInteger(raw.due_unix_ms) || Date.parse(raw.due_at) !== raw.due_unix_ms) throw new Error("canonical_wait_due_invalid");
    if (nativeTrigger.kind === "delay" && Number.isSafeInteger(nativeTrigger.delay_ms) && Number(nativeTrigger.delay_ms) > 0) {
      trigger = { kind: "delay", delayMs: Number(nativeTrigger.delay_ms) };
    } else if (nativeTrigger.kind === "at" && typeof nativeTrigger.at === "string" && validRfc3339Instant(nativeTrigger.at)) {
      trigger = { kind: "at", at: nativeTrigger.at };
    } else throw new Error("canonical_wait_trigger_invalid");
    scheduledAt = raw.due_at;
  } else {
    if (!Array.isArray(rule.dependencies) || rule.dependencies.length < 1 || rule.dependencies.length > 32
      || !rule.dependencies.every(exact) || new Set(rule.dependencies).size !== rule.dependencies.length
      || JSON.stringify([...rule.dependencies].sort()) !== JSON.stringify(canonicalDependencies.sort())
      || raw.due_at !== null || raw.due_unix_ms !== null) throw new Error("canonical_wait_dependency_invalid");
  }
  const wait: ResumeAfterWait = {
    id: raw.rule_ref, owner, dependencies, message: rule.wake_message, createdAt: raw.created_at,
    state: phaseState[raw.status]!, completed: {}, ...(trigger ? { trigger, scheduledAt } : {}),
    ...(dependencies.length ? { dependencyTurns } : {}),
    ...(typeof state.detail === "string" ? { reason: state.detail } : {}),
    canonical: { ruleRef: raw.rule_ref, epoch, phase: raw.status, requestKey: raw.request_key, sessionRef: raw.session_ref,
      ...(typeof state.delivery_task === "string" ? { deliveryTask: state.delivery_task } : {}) },
  };
  if (raw.status === "confirmed") wait.delivery = { status: "accepted" };
  if (["dispatching", "waiting_receipt", "delivery_unknown"].includes(raw.status)) wait.delivery = { status: "ambiguous", reason: wait.reason };
  if (raw.status === "rejected") wait.delivery = { status: "rejected", reason: wait.reason };
  return { raw, wait, rule: rule as unknown as CanonicalRule };
}

/** A stateless compatibility facade. The native authority owns all clocks and deliveries. */
export class CanonicalResumeAfterService implements ResumeAfterBackend {
  readonly authority = "canonical" as const;
  constructor(private readonly client: CanonicalAutomationClient) {}

  /** Observe the actual loaded backend without a second facade or native call. */
  async canonicalReadiness(): Promise<{ config: string; config_sha256: string; epoch: string; authority: string; writer_drain_sha256: string }> {
    const { canonicalClientBinding } = await import("./canonical-herder.js");
    const binding = canonicalClientBinding(this.client);
    if (!binding) throw new Error("canonical_client_binding_unavailable");
    await this.client.assertCurrent();
    await requireCanonicalMigrationReady(this.client);
    await this.client.assertCurrent();
    return { ...binding, epoch: this.client.epoch, authority: this.client.config.authority,
      writer_drain_sha256: this.client.config.writer_drain.sha256 };
  }

  private async readCanonical(id: string): Promise<ReturnType<typeof projection> | null> {
    try {
      const result = projection(await this.client.call("automation", { action: "get", rule_ref: id }), this.client.epoch);
      if (result.wait.id !== id) throw new Error("canonical_wait_identity_mismatch");
      return result;
    } catch (error) {
      if (error instanceof CanonicalHerderError && error.code === "rule_not_found" && error.effect === "none") return null;
      throw error;
    }
  }

  async register(input: ResumeAfterRequest): Promise<ResumeAfterWait> {
    const normalized = canonicalResumeRequest(input);
    const retained = await readRetainedResumeAfter(this.client);
    const existing = retained.waits.find(wait => wait.id === normalized.legacyId);
    if (existing) {
      if (fingerprint(existing) !== normalized.fingerprint) throw new Error("Retry id belongs to a different retained wait");
      return existing;
    }
    await requireCanonicalMigrationReady(this.client);
    const [owner, ...dependencies] = await Promise.all([normalized.owner, ...normalized.dependencies]
      .map(ref => this.client.resolveNative(ref.harness, ref.sessionId)));
    const rule: CanonicalRule = input.trigger ? {
      kind: "timer", trigger: input.trigger.kind === "delay" ? { kind: "delay", delay_ms: input.trigger.delayMs }
        : { kind: "at", at: input.trigger.at }, wake_message: normalized.message,
    } : { kind: "session_completion", dependencies: dependencies.map(ref => ref.sessionRef).sort(), wake_message: normalized.message };
    const result = projection(await this.client.call("automation", {
      action: "create", session_ref: owner!.sessionRef, request_key: normalized.requestKey, rule,
    }), this.client.epoch);
    if (result.raw.session_ref !== owner!.sessionRef || result.raw.request_key !== normalized.requestKey
      || !isDeepStrictEqual(result.rule, rule) || key(result.wait.owner) !== key(normalized.owner)) {
      throw new Error("canonical_wait_admission_identity_mismatch");
    }
    return result.wait;
  }

  async get(id: string): Promise<ResumeAfterWait | null> {
    if (legacyId(id)) return (await readRetainedResumeAfter(this.client)).waits.find(wait => wait.id === id) ?? null;
    if (!publicId(id)) throw new Error("Invalid wait id");
    return (await this.readCanonical(id))?.wait ?? null;
  }

  async list(): Promise<ResumeAfterWait[]> {
    const [retained, listed] = await Promise.all([
      readRetainedResumeAfter(this.client), this.client.call("automation", { action: "list" }),
    ]);
    if (listed.complete !== true || !Array.isArray(listed.rules)) throw new Error("canonical_wait_list_incomplete");
    const waits: ResumeAfterWait[] = [...retained.waits];
    const ids = new Set(waits.map(wait => wait.id));
    for (const value of listed.rules) {
      const row = object(value);
      if (!facadeKey(row.request_key)) continue;
      const result = projection(row, this.client.epoch);
      if (ids.has(result.wait.id)) throw new Error("canonical_wait_list_ambiguous");
      ids.add(result.wait.id); waits.push(result.wait);
    }
    return waits.sort((a, b) => a.id.localeCompare(b.id));
  }

  async cancel(id: string, owner: SessionRef): Promise<ResumeAfterWait | null> {
    if (legacyId(id)) {
      const retained = await this.get(id);
      if (!retained) return null;
      if (key(retained.owner) !== key(owner)) throw new Error("Only the waiting session may cancel this wait");
      throw new Error("canonical_retained_wait_requires_reconciliation");
    }
    if (!publicId(id)) throw new Error("Invalid wait id");
    const before = await this.readCanonical(id);
    if (!before) return null;
    if (before.wait.id !== id || key(before.wait.owner) !== key(owner)) throw new Error("Only the waiting session may cancel this wait");
    const resolved = await this.client.resolveNative(owner.harness, owner.sessionId);
    if (resolved.sessionRef !== before.raw.session_ref) throw new Error("canonical_wait_owner_changed");
    const after = projection(await this.client.call("automation", {
      action: "delete", rule_ref: id, revision: before.raw.revision,
    }), this.client.epoch);
    if (after.wait.id !== id || after.raw.session_ref !== before.raw.session_ref) throw new Error("canonical_wait_cancel_identity_mismatch");
    return after.wait;
  }

  async invalidateByHumanRequest(_requestId: string, _reason: string): Promise<number> {
    throw new Error("canonical_human_request_wait_unsupported");
  }
}

export function createCanonicalResumeAfterRuntime(client: CanonicalAutomationClient): {
  service: ResumeAfterBackend; start(): Promise<() => void>;
} {
  return { service: new CanonicalResumeAfterService(client), async start() {
    // Validate retained evidence for read-only status, even when cutover remains
    // blocked. No intervals, native subscriptions, sweeps, or writable registry.
    await readRetainedResumeAfter(client);
    return () => {};
  } };
}
