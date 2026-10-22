import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import type { AgentSession, HarnessAdapter } from "./types/index.js";
import { coordinationNotes } from "./coordination-notes.js";
import { deferredMessages, isBusyCodexWriter, withDeferred } from "./deferred-messages.js";
import { getHumanStopStore } from "./human-stop-store.js";
import { automaticDeliveryHeld, HUMAN_STOP_MESSAGE } from "./human-stop-actions.js";
import { isCoordinationActive, sendCurrentTurnOnly, previousCoordinationReceipt } from "./coordination-active-delivery.js";
import { agentRelayEnvelope } from "./agent-relay-envelope.js";
import {
  automationDisarmDecision,
  sessionWorkKey,
  AutomationDisarmStore,
  AUTOMATION_DISARMED_MESSAGE,
  AUTOMATION_FORBIDDEN_CODE,
  type AutomationDisarmDecision,
  type AutomationLaunchSource,
} from "./automation-disarm/index.js";
import { resolveAutopilotStateDir } from "./autopilot/state-dir.js";

export type NamedSessionMode = "queue" | "sync";

export interface NamedSessionRequest {
  healthRecovery?: boolean;
  requireSourceHostId?: boolean;
  sourceSessions?: Array<{ harness: string; sessionId: string; hostId?: string }>;
  sourceSessionId?: string;
  sourceHarness?: string;
  harness: string;
  name: string;
  cwd: string;
  model?: string;
  /** Ordered same-harness models for definite pre-admission 429/quota failures; when omitted, a known model route may supply its default. */
  fallbackModels?: string[];
}

export interface NewOrResumeNamedSessionRequest extends NamedSessionRequest {
  inputId?: string;
  humanRequested?: boolean;
  message: string;
  mode?: NamedSessionMode;
  model?: string;
}

export interface NamedSessionResult {
  ok: boolean;
  created: boolean;
  harness: string;
  name: string;
  cwd: string;
  sessionId?: string;
  delivery?: "accepted" | "accepted_unconfirmed" | "accepted_failed" | "completed" | "failed" | "not_attempted" | "deferred" | "skipped_inactive" | "not_found" | "previously_admitted" | "admission_unknown";
  admitted?: boolean;
  inputId?: string;
  turnId?: string;
  admissionUnknown?: boolean;
  nonRetryable?: boolean;
  pending?: boolean;
  /** Definite provider rejection observed before session creation/input admission. */
  failureCode?: "quota_exhausted" | "automation_disabled";
  /**
   * The area of the refusal, as a structured field beside the code.
   *
   * The area never travels inside the wording alone: the code says that the
   * automation is off, and this field says where. The catch-all scope keeps
   * its own literal, so a reader tells the whole contour from one project.
   */
  routingReasonDetail?: string;
  model?: string;
  requestedModel?: string;
  fallbackFrom?: string;
  error?: string;
}

type NamedSessionResolution =
  | { kind: "error"; result: NamedSessionResult }
  | { kind: "resolved"; adapter: HarnessAdapter; target: AgentSession; created: boolean; normalized: NamedSessionRequest };

const canonicalSources = new WeakMap<NamedSessionRequest, Array<{ harness: string; sessionId: string; hostId?: string }>>();
const queues = new Map<string, Promise<void>>();
const recentNamedSessions = new Map<string, { session: AgentSession; seenAt: number }>();
const recentNamedDeliveries = new Map<string, { result: NamedSessionResult; seenAt: number }>();
const RECENT_NAMED_SESSION_TTL_MS = 60_000;

/**
 * The owner-level automation lever, read from the durable owner file.
 *
 * The lever is keyed by the logical work, never by a session id, so a repeat
 * of the same work under a new session id resolves to the same key and stays
 * refused. Only an automatic run is ever refused: work a person started, and
 * an explicit creation request for one concrete session, keep running.
 */
async function automationDisarmRefusal(
  normalized: NamedSessionRequest,
  source: AutomationLaunchSource,
): Promise<AutomationDisarmDecision | undefined> {
  const decision = await automationDisarmDecision(
    AutomationDisarmStore.forRuntime(),
    [sessionWorkKey(normalized.harness, normalized.name, normalized.cwd)],
    source,
  );
  return decision.allowed ? undefined : decision;
}

/**
 * The refusal of the owner lever, in the shape of a failed result.
 *
 * The refusal carries the stable code of the lever next to the human text, so
 * a caller can tell "the owner forbids this scope" from "a person stopped
 * this chat" without reading the text. The area of the refusal travels in
 * its own field beside the code, so nobody has to parse the wording to learn
 * where the owner put the lever. A forbidden launch is not a delivery
 * failure: a retry would be refused the same way, so it is not retryable.
 */
function disarmFailed(
  request: NamedSessionRequest,
  decision: AutomationDisarmDecision,
): NamedSessionResult {
  return failed(request, decision.reason ?? AUTOMATION_DISARMED_MESSAGE, "not_attempted", {
    failureCode: AUTOMATION_FORBIDDEN_CODE,
    // The area is a field of its own, next to the code and not inside the text.
    ...(decision.routingReasonDetail ? { routingReasonDetail: decision.routingReasonDetail } : {}),
    nonRetryable: true,
  });
}

/**
 * Catalog-wide search limit.
 *
 * The harness clients list the newest sessions of a directory and the window
 * is small: the core client defaults to 100 rows and the OpenCode 2 client
 * caps the request at 500. The busiest workspace already holds thousands of
 * sessions, so a bounded window must never decide that a session does not
 * exist. A lookup that cannot prove absence has to say so instead of letting
 * the caller create a second session under the same name.
 */
const NAMED_SESSION_SEARCH_LIMIT = 5000;

/** How many durable bindings are kept before the oldest ones are dropped. */
const NAMED_SESSION_BINDING_LIMIT = 5000;

/** Durable binding between a named session and the native session that serves it. */
type NamedSessionBinding = {
  harness: string;
  cwd: string;
  name: string;
  sessionId: string;
  title?: string;
  updatedAt: string;
};

type NamedSessionBindingFile = { version: 1; bindings: NamedSessionBinding[] };

/**
 * Durable name→session bindings.
 *
 * A repeated delivery has to reuse the session it created, also after the
 * runtime restarted. The native catalog answers that question, but only while
 * the session is still inside a listing window; this file answers it with the
 * session id, so reuse never depends on how many sessions appeared since.
 */
class NamedSessionBindingStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async get(harness: string, cwd: string, name: string): Promise<NamedSessionBinding | undefined> {
    const file = await this.serial(() => this.read());
    return file.bindings.find((binding) => binding.harness === harness && binding.cwd === cwd && binding.name === name);
  }

  async put(binding: NamedSessionBinding): Promise<void> {
    await this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const index = file.bindings.findIndex((item) => item.harness === binding.harness && item.cwd === binding.cwd && item.name === binding.name);
      const existing = index < 0 ? undefined : file.bindings[index];
      if (existing && existing.sessionId === binding.sessionId) return;
      if (index < 0) file.bindings.push(binding);
      else file.bindings[index] = binding;
      if (file.bindings.length > NAMED_SESSION_BINDING_LIMIT) file.bindings.splice(0, file.bindings.length - NAMED_SESSION_BINDING_LIMIT);
      await this.write(file);
    }));
  }

  async remove(harness: string, cwd: string, name: string): Promise<void> {
    await this.serial(() => this.withFileLock(async () => {
      const file = await this.read();
      const index = file.bindings.findIndex((item) => item.harness === harness && item.cwd === cwd && item.name === name);
      if (index < 0) return;
      file.bindings.splice(index, 1);
      await this.write(file);
    }));
  }

  private async read(): Promise<NamedSessionBindingFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as NamedSessionBindingFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.bindings)) return { version: 1, bindings: [] };
      return {
        version: 1,
        bindings: parsed.bindings.filter((binding) => binding
          && typeof binding.harness === "string"
          && typeof binding.cwd === "string"
          && typeof binding.name === "string"
          && typeof binding.sessionId === "string"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: [] };
      throw error;
    }
  }

  private async write(file: NamedSessionBindingFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Bounded interprocess lock: the binding file is written by every worker. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.lockTarget, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

let bindingStore: NamedSessionBindingStore | undefined;
let bindingStorePath: string | undefined;

function namedSessionBindings(): NamedSessionBindingStore {
  const path = resolveNamedSessionBindingPath();
  if (!bindingStore || bindingStorePath !== path) {
    bindingStore = new NamedSessionBindingStore(path);
    bindingStorePath = path;
  }
  return bindingStore;
}

function resolveNamedSessionBindingPath(): string {
  const configured = process.env.AGENT_HERDER_NAMED_SESSION_STORE?.trim();
  if (configured) return configured;
  return join(resolveAutopilotStateDir(), "named-sessions.json");
}

export async function createNamedSession(
  adapters: Map<string, HarnessAdapter>,
  request: NamedSessionRequest,
): Promise<NamedSessionResult> {
  return withNamedSessionLock(request, async (normalized) => {
    const sourceError = await namedAutomationError(adapters, request, normalized);
    if (sourceError) return failed(normalized, sourceError, "not_attempted");
    const disarm = await automationDisarmRefusal(normalized, "explicit");
    if (disarm) return disarmFailed(normalized, disarm);
    const adapter = adapters.get(normalized.harness);
    if (!adapter) return failed(normalized, `Harness '${normalized.harness}' is not configured`);
    if (!adapter.createSession) return failed(normalized, `${adapter.name} does not support session creation`);
    let matches: AgentSession[];
    try {
      matches = await exactMatches(adapter, normalized.name, normalized.cwd);
    } catch (error) {
      return failed(normalized, (error as Error).message);
    }
    if (matches.length > 0) {
      return failed(normalized, `Named session '${normalized.name}' already exists for ${normalized.harness}:${normalized.cwd}`);
    }
    try {
      if (await sourceHeldNow(request)) return failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted");
      const session = await adapter.createSession({ name: normalized.name, cwd: normalized.cwd, model: request.model, fullAccess: true, healthRecovery: request.healthRecovery });
      await rememberNamedSession(adapter, normalized.name, normalized.cwd, session);
      return { ok: true, created: true, sessionId: session.id, model: request.model, ...normalized };
    } catch (error) {
      return failed(normalized, (error as Error).message);
    }
  });
}

export async function newOrResumeNamedSession(
  adapters: Map<string, HarnessAdapter>,
  request: NewOrResumeNamedSessionRequest,
): Promise<NamedSessionResult> {
  const resolved = await withNamedSessionLock<NamedSessionResolution>(request, async (normalized) => {
    const sourceError = await namedAutomationError(adapters, request, normalized);
    if (sourceError) return { kind: "error", result: failed(normalized, sourceError, "not_attempted") };
    const disarm = await automationDisarmRefusal(normalized, request.humanRequested === true ? "human" : "automation");
    if (disarm) return { kind: "error", result: disarmFailed(normalized, disarm) };
    const adapter = adapters.get(normalized.harness);
    if (!adapter) return { kind: "error", result: failed(normalized, `Harness '${normalized.harness}' is not configured`, "not_attempted") };
    if (!adapter.createSession) return { kind: "error", result: failed(normalized, `${adapter.name} does not support session creation`, "not_attempted") };

    let matches: AgentSession[];
    try {
      matches = await exactMatches(adapter, normalized.name, normalized.cwd);
    } catch (error) {
      return { kind: "error", result: failed(normalized, (error as Error).message, "not_attempted") };
    }
    if (matches.length > 1) {
      return { kind: "error", result: failed(normalized, `Ambiguous named session '${normalized.name}' for ${normalized.harness}:${normalized.cwd}`, "not_attempted") };
    }

    let target = matches[0];
    if (target && await automaticDeliveryHeld(target, request.humanRequested, adapter)) return { kind: "error", result: failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted") };
    let created = false;
    if (!target) {
      if (await getHumanStopStore().findHeldNamed(normalized.harness, normalized.name, normalized.cwd)) return { kind: "error", result: failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted") };
      try {
        if (await sourceHeldNow(request)) return { kind: "error", result: failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted") };
        target = await adapter.createSession({ name: normalized.name, cwd: normalized.cwd, model: request.model, fullAccess: true, healthRecovery: request.healthRecovery });
        await rememberNamedSession(adapter, normalized.name, normalized.cwd, target);
        created = true;
      } catch (error) {
        return { kind: "error", result: failed(normalized, (error as Error).message, "not_attempted") };
      }
    }
    return { kind: "resolved", adapter, target, created, normalized };
  });
  if (resolved.kind === "error") return resolved.result;

  if (request.healthRecovery && resolved.target.meta?.healthRecovery !== true) return { ...failed(resolved.normalized, "Health recovery requires a dedicated bounded session", "not_attempted"), sessionId: resolved.target.id };

  const deliveryIdentity = namedDeliveryIdentity(resolved.normalized, request.message);
  const priorDelivery = recentNamedDelivery(deliveryIdentity);
  if (priorDelivery && !request.humanRequested) return priorDelivery;

  const mode = request.mode || "sync";
  // A create request may accept a model option without the native service
  // actually applying it. Trust only the returned session state; otherwise
  // select the model explicitly before the first prompt.
  const currentModel = resolved.target.harness === "hermes" && typeof resolved.target.meta?.selectedModel === "string"
    ? resolved.target.meta.selectedModel : resolved.target.model;
  if (request.model !== undefined && currentModel !== request.model) {
    if (!resolved.adapter.changeModel) {
      return {
        ok: false,
        created: resolved.created,
        sessionId: resolved.target.id,
        delivery: "not_attempted",
        error: `${resolved.adapter.name} does not support model selection before delivery`,
        ...resolved.normalized,
      };
    }
    const modelResult = await resolved.adapter.changeModel(resolved.target.id, request.model);
    if (!modelResult.ok) {
      return {
        ok: false,
        created: resolved.created,
        sessionId: resolved.target.id,
        delivery: "not_attempted",
        error: modelResult.error || "Model selection failed",
        ...resolved.normalized,
      };
    }
  }
  const pending = await withDeferred(resolved.target.id, agentRelayEnvelope(request.message));
  const injectedMessage = await coordinationNotes.inject(resolved.target, pending.message);
  if (await sourceHeldNow(request) || await automaticDeliveryHeld(resolved.target, false, resolved.adapter)) return { ...failed(resolved.normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: resolved.target.id, created: resolved.created };
  const inputId = request.inputId ?? (request.humanRequested ? undefined : createHash("sha256").update(request.message).digest("hex"));
  let selectedModel = request.model;
  let fallbackFrom: string | undefined;
  const send = (model?: string) => sendWithSourceAdmission(request, () => resolved.adapter.sendMessage(resolved.target.id, {
      model,
      origin: request.humanRequested ? "human" : "automation",
      inputId,
      ...(resolved.target.harness === "hermes" && resolved.target.meta?.taskBinding
        ? { expectedTaskBinding: resolved.target.meta.taskBinding as { name: string; cwd: string; generation: string } }
        : {}),
      message: injectedMessage,
      queue: mode === "queue",
  }));
  const firstSend = await send(request.model);
  if (!firstSend.allowed) return { ...failed(resolved.normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: resolved.target.id, created: resolved.created };
  let delivery = firstSend.value;
  const tried = new Set([request.model].filter((model): model is string => typeof model === "string"));
  for (const fallbackModel of request.fallbackModels ?? defaultFallbackModels(request.harness, request.model)) {
    if (delivery.ok || delivery.admitted || delivery.admissionUnknown || !isFallbackEligibleRejection(delivery.error)) break;
    if (!request.model || !resolved.adapter.changeModel || tried.has(fallbackModel)) continue;
    tried.add(fallbackModel);
    const changed = await resolved.adapter.changeModel(resolved.target.id, fallbackModel);
    if (!changed.ok) break;
    if (await sourceHeldNow(request) || await automaticDeliveryHeld(resolved.target, false, resolved.adapter)) {
      return { ...failed(resolved.normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: resolved.target.id, created: resolved.created,
        ...(request.model ? { requestedModel: request.model, model: request.model } : {}) };
    }
    fallbackFrom ??= request.model;
    selectedModel = fallbackModel;
    const retrySend = await send(fallbackModel);
    if (!retrySend.allowed) {
      return { ...failed(resolved.normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: resolved.target.id, created: resolved.created,
        ...(request.model ? { requestedModel: request.model, model: request.model } : {}) };
    }
    delivery = retrySend.value;
  }
  if (!delivery.ok) {
    const result: NamedSessionResult = {
      ok: false,
      created: resolved.created,
      sessionId: resolved.target.id,
      delivery: delivery.admitted && delivery.nonRetryable ? "accepted_failed" : "failed",
      ...(delivery.admitted ? { admitted: true } : {}),
      ...(delivery.nonRetryable ? { nonRetryable: true } : {}),
      // An unknown admission must survive the failure: a caller deciding on a
      // harness fallback must never treat it as a definite pre-admission
      // rejection and start a second executor.
      ...(delivery.admissionUnknown ? { admissionUnknown: true } : {}),
      ...(isConfirmedQuotaExhaustion(delivery.error) ? { failureCode: "quota_exhausted" as const } : {}),
      error: delivery.error || "Message delivery failed",
      ...resolved.normalized,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(fallbackFrom ? { requestedModel: fallbackFrom, fallbackFrom } : {}),
    };
    if (delivery.admitted) rememberNamedDelivery(deliveryIdentity, result);
    if ((delivery.admitted || (delivery.admissionUnknown && delivery.nonRetryable)) && pending.ids.length) await deferredMessages.remove(pending.ids);
    return result;
  }
  const result: NamedSessionResult = {
    ok: true,
    created: resolved.created,
    sessionId: resolved.target.id,
    delivery: delivery.pending ? "accepted_unconfirmed" : mode === "queue" ? "accepted" : "completed",
    ...(delivery.admitted ? { admitted: true } : {}),
    ...(delivery.pending ? { pending: true } : {}),
    ...resolved.normalized,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(fallbackFrom ? { requestedModel: fallbackFrom, fallbackFrom } : {}),
  };
  if (delivery.pending) rememberNamedDelivery(deliveryIdentity, result);
  if (pending.ids.length) await deferredMessages.remove(pending.ids);
  return result;
}

/** Provider quota exhaustion and HTTP 429 authorize retry on an explicit fallback. */
function isFallbackEligibleRejection(error: string | undefined): boolean {
  return isConfirmedQuotaExhaustion(error) || /\b429\b/u.test(error ?? "");
}

function defaultFallbackModels(harness: string, model: string | undefined): string[] {
  const glmFlashModels = new Set([
    "omniroute/zc/glm-5.3-flash",
    "zai-coding-plan/glm-5.3-flash",
    "opencode/glm-5.3-flash",
  ]);
  if (harness === "opencode" && glmFlashModels.has(model?.trim().toLowerCase() ?? "")) {
    return ["omniroute/minimax-combo-m3.1"];
  }
  return [];
}

function isConfirmedQuotaExhaustion(error: string | undefined): boolean {
  if (!error) return false;
  return /(?:\b4292056\b|\b2056\b|\b(?:1308|1310|1316|1317|1318|1319|1320|1321)\b|quota[_ -]exhausted|quota exceeded|usage limit exceeded)/iu.test(error);
}

async function exactMatches(adapter: HarnessAdapter, name: string, cwd: string): Promise<AgentSession[]> {
  const identity = namedIdentity(adapter.type, name, cwd);
  const recent = recentNamedSessions.get(identity);
  if (recent && Date.now() - recent.seenAt < RECENT_NAMED_SESSION_TTL_MS) return [recent.session];
  if (recent) recentNamedSessions.delete(identity);

  // A durable binding answers with the session id, so a repeated delivery
  // reuses its session even when the runtime restarted and the session left
  // every listing window of the native catalog.
  const bound = await namedSessionBindings().get(adapter.type, cwd, name);
  if (bound) {
    const session = await adapter.getSession(bound.sessionId);
    if (session && session.title === name && await sameCwd(session.cwd, cwd)) {
      recentNamedSessions.set(identity, { session, seenAt: Date.now() });
      return [session];
    }
    // The native session is gone or was renamed: the binding is stale.
    await namedSessionBindings().remove(adapter.type, cwd, name);
  }

  const sessions = adapter.findNamedSessions
    ? await adapter.findNamedSessions(name, cwd)
    : await adapter.listSessions({ cwd, limit: NAMED_SESSION_SEARCH_LIMIT });
  const candidates = adapter.findNamedSessions ? sessions : sessions.filter((session) => session.title === name);
  const matches: AgentSession[] = [];
  for (const session of candidates) {
    if (await sameCwd(session.cwd, cwd)) matches.push(session);
  }
  if (matches.length === 1) {
    recentNamedSessions.set(identity, { session: matches[0]!, seenAt: Date.now() });
    await rememberNamedSession(adapter, name, cwd, matches[0]!);
  }
  return matches;
}

/** True when the session really works in the requested canonical directory. */
async function sameCwd(sessionCwd: string, cwd: string): Promise<boolean> {
  try {
    return await realpath(sessionCwd) === cwd;
  } catch {
    // A vanished legacy CWD cannot be the requested canonical identity.
    return false;
  }
}

function namedIdentity(harness: string, name: string, cwd: string): string {
  return `${harness}\u0000${cwd}\u0000${name}`;
}

function namedDeliveryIdentity(request: NamedSessionRequest & {inputId?: string}, message: string): string {
  return `${namedIdentity(request.harness, request.name, request.cwd)}\0${request.inputId ?? createHash("sha256").update(message).digest("hex")}`;
}

function recentNamedDelivery(identity: string): NamedSessionResult | undefined {
  const cached = recentNamedDeliveries.get(identity);
  if (!cached) return undefined;
  if (Date.now() - cached.seenAt >= RECENT_NAMED_SESSION_TTL_MS) {
    recentNamedDeliveries.delete(identity);
    return undefined;
  }
  return cached.result;
}

function rememberNamedDelivery(identity: string, result: NamedSessionResult): void {
  recentNamedDeliveries.set(identity, { result, seenAt: Date.now() });
}

/**
 * Remember the native session that serves a name.
 *
 * The in-memory map is the fast path, the durable binding survives a restart
 * of the runtime. A failed binding write is reported but never fails the
 * delivery: the native catalog is still the authority.
 */
async function rememberNamedSession(adapter: HarnessAdapter, name: string, cwd: string, session: AgentSession): Promise<void> {
  recentNamedSessions.set(namedIdentity(adapter.type, name, cwd), { session, seenAt: Date.now() });
  try {
    await namedSessionBindings().put({
      harness: adapter.type,
      cwd,
      name,
      sessionId: session.id,
      ...(session.title ? { title: session.title } : {}),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[agent-herder] named session binding was not written: ${(error as Error).message}`);
  }
}

async function normalize(request: NamedSessionRequest): Promise<NamedSessionRequest> {
  const harness = request.harness.trim();
  const name = request.name.trim();
  if (!harness) throw new Error("harness must be a non-empty string");
  if (!name) throw new Error("name must be a non-empty string");
  if (!isAbsolute(request.cwd)) throw new Error("cwd must be an absolute path");
  return { harness, name, cwd: await realpath(request.cwd) };
}

async function withNamedSessionLock<T>(
  request: NamedSessionRequest,
  operation: (normalized: NamedSessionRequest) => Promise<T>,
): Promise<T> {
  const normalized = await normalize(request);
  const key = `${normalized.harness}\u0000${normalized.cwd}\u0000${normalized.name}`;
  const previous = queues.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  queues.set(key, tail);
  await previous.catch(() => undefined);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireFileLock(key);
    return await operation(normalized);
  } finally {
    try {
      if (releaseFileLock) await releaseFileLock();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }
}

async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  const root = process.env.AGENT_HERDER_LOCK_DIR
    || (process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, "agent-herder", "named-session-locks")
      : join(tmpdir(), `agent-herder-${uid}`, "named-session-locks"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(key).digest("hex");
  const lockTarget = join(root, digest);
  await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
  return lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 120, minTimeout: 25, maxTimeout: 250, factor: 1.2 },
  });
}

function launchSources(request: NamedSessionRequest) {
  const refs = [...(request.sourceSessions ?? []), ...(request.sourceSessionId ? [{ harness: request.sourceHarness || request.harness, sessionId: request.sourceSessionId }] : [])];
  return [...new Map(refs.map((ref) => [`${ref.hostId ?? ""}:${ref.harness}:${ref.sessionId}`, ref])).values()];
}
async function sourceHeldNow(request: NamedSessionRequest): Promise<boolean> {
  return getHumanStopStore().anyHeld(canonicalSources.get(request) ?? launchSources(request));
}

async function sendWithSourceAdmission<T>(request: NamedSessionRequest, operation: () => Promise<T>): Promise<{ allowed: false } | { allowed: true; value: T }> {
  return getHumanStopStore().withSourcesUnheld(canonicalSources.get(request) ?? launchSources(request), operation);
}

async function namedAutomationError(adapters: Map<string, HarnessAdapter>, request: NamedSessionRequest, normalized: NamedSessionRequest): Promise<string | undefined> {
  const store = getHumanStopStore();
  const refs = launchSources(request);
  if (refs.length > 32) return "Слишком много исходных чатов; автоматическое создание запрещено.";
  const canonical: Array<{ harness: string; sessionId: string; hostId?: string }> = [];
  const localHostId = process.env.NOTICEPLACE_MESH_HOST_ID || process.env.AGENT_HERDER_HOST_ID || "";
  for (const ref of refs) {
    if (request.requireSourceHostId && !ref.hostId) {
      return "Исходный чат не содержит подтверждённую идентичность узла; автоматически создавать замену запрещено.";
    }
    if (ref.hostId && (!localHostId || ref.hostId !== localHostId)) {
      return "Исходный чат принадлежит другому или неизвестному узлу; автоматически создавать замену запрещено.";
    }
    const source = await adapters.get(ref.harness)?.getSession(ref.sessionId);
    if (source) {
      if (await store.observe(source)) return HUMAN_STOP_MESSAGE;
      canonical.push({ harness: source.harness, sessionId: source.id, ...(ref.hostId ? { hostId: ref.hostId } : {}) });
    } else {
      if (await store.isHeld(ref.harness, ref.sessionId)) return HUMAN_STOP_MESSAGE;
      return "Исходный чат недоступен; автоматически создавать замену запрещено.";
    }
  }
  canonicalSources.set(request, canonical);
  if (await store.anyHeld(canonical)) return HUMAN_STOP_MESSAGE;
  if ("humanRequested" in request && request.humanRequested === true) return undefined;
  return await store.findHeldNamed(normalized.harness, normalized.name, normalized.cwd) ? HUMAN_STOP_MESSAGE : undefined;
}

function failed(
  request: NamedSessionRequest,
  error: string,
  delivery?: NamedSessionResult["delivery"],
  extra?: Partial<NamedSessionResult>,
): NamedSessionResult {
  return { ok: false, created: false, error, ...(delivery ? { delivery } : {}), ...request, ...extra };
}

export type DeliverActivation = "always" | "if_running" | "defer";
export type DeliverCreate = "if_missing" | "never";
export interface DeliverNamedRequest extends NewOrResumeNamedSessionRequest { create?: DeliverCreate; activation?: DeliverActivation; }
export type DeliverResult = Omit<NamedSessionResult, "delivery"> & { sessionStatus?: AgentSession["status"]; activated?: boolean; delivery?: NamedSessionResult["delivery"] | "deferred" | "skipped_inactive" | "not_found"; };

/** Apply an explicitly selected model before an idle delivery, never ignore it. */
export async function selectDeliveryModel(adapter: HarnessAdapter, session: AgentSession, model?: string): Promise<string | null> {
  if (model === undefined || model === session.model) return null;
  if (session.status === "running" || session.status === "needs_input" || session.needsPermission) {
    return "The target is active or awaiting permission; its model cannot be changed for this delivery. Continue independent work, then send with the chosen model when it is idle.";
  }
  if (!adapter.changeModel) return "The target adapter does not support explicit model selection; no message was sent";
  try {
    const selected = await adapter.changeModel(session.id, model);
    return selected.ok ? null : selected.error || "Model selection failed; no message was sent";
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

export async function deliverNamedSession(adapters: Map<string,HarnessAdapter>, request: DeliverNamedRequest): Promise<DeliverResult> {
  return withNamedSessionLock(request, async normalized => {
    const sourceError = await namedAutomationError(adapters, request, normalized);
    if (sourceError) return { ...failed(normalized, sourceError, "not_attempted"), activated: false };
    const disarm = await automationDisarmRefusal(normalized, request.humanRequested === true ? "human" : "automation");
    if (disarm) return { ...disarmFailed(normalized, disarm), activated: false };
    const deliveryIdentity = namedDeliveryIdentity(normalized, request.message);
    const priorDelivery = recentNamedDelivery(deliveryIdentity);
    if (priorDelivery) return {...priorDelivery,activated:false};
    const adapter=adapters.get(normalized.harness);
    if (!adapter) return {...failed(normalized,`Harness '${normalized.harness}' is not configured`,"not_attempted"),activated:false};
    let matches:AgentSession[]; try { matches=await exactMatches(adapter,normalized.name,normalized.cwd); } catch(e){ return {...failed(normalized,(e as Error).message,"not_attempted"),activated:false}; }
    if (matches.length>1) return {...failed(normalized,`Ambiguous named session '${normalized.name}' for ${normalized.harness}:${normalized.cwd}`,"not_attempted"),activated:false};
    let target=matches[0], created=false;
    if (target) {
      const prior = await previousCoordinationReceipt(adapter,target.id,request.inputId);
      if (prior) return {...JSON.parse(prior),...normalized,created:false};
    }
    if (target && await automaticDeliveryHeld(target, false, adapter)) return { ...failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: target.id, activated: false };
    if (!target) {
      if ((request.create||"if_missing")==="never") return {ok:false,created:false,harness:normalized.harness,name:normalized.name,cwd:normalized.cwd,delivery:"not_found",activated:false,error:"Named session not found"};
      if (!adapter.createSession) return {...failed(normalized,`${adapter.name} does not support session creation`,"not_attempted"),activated:false};
      try { if (await sourceHeldNow(request)) return { ...failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted"), activated: false }; target=await adapter.createSession({name:normalized.name,cwd:normalized.cwd,model:request.model,fullAccess:true}); await rememberNamedSession(adapter, normalized.name, normalized.cwd, target); created=true; } catch(e){ return {...failed(normalized,(e as Error).message,"not_attempted"),activated:false}; }
    }
    const fresh=await adapter.getSession(target.id); const activation=request.activation ?? (created ? "always" : "if_running");
    if (!fresh) return {...failed(normalized,"Native target activity unavailable","not_attempted"),sessionId:target.id,activated:false};
    if (await sourceHeldNow(request) || await automaticDeliveryHeld(fresh, false, adapter)) return { ...failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: fresh.id, activated: false };
    if (activation==="if_running" && (fresh.meta?.nativeStateObserved === false || fresh.meta?.nativeLoaded === false)) return {...failed(normalized,"Текущая native-активность не установлена.","not_attempted"),sessionId:fresh.id,activated:false};
    if (activation==="if_running" && !isCoordinationActive(fresh)) return {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"skipped_inactive",activated:false,...normalized};
    if (activation==="defer" && request.model && request.model!==fresh.model) return {...failed(normalized,"A deferred message cannot preserve a model override; select it explicitly at delivery time","not_attempted"),sessionId:fresh.id,activated:false};
    if (activation==="defer" && fresh.status!=="running") { await deferredMessages.add(fresh.id,request.message); return {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"deferred",activated:false,...normalized}; }
    const modelError = await selectDeliveryModel(adapter,fresh,request.model);
    if (modelError) return {...failed(normalized,modelError,"not_attempted"),sessionId:fresh.id,activated:false};
    const pending=await withDeferred(fresh.id,agentRelayEnvelope(request.message, "deliver")); const injected=await coordinationNotes.inject(fresh,pending.message);
    if (await sourceHeldNow(request) || await automaticDeliveryHeld(fresh, false, adapter)) return { ...failed(normalized, HUMAN_STOP_MESSAGE, "not_attempted"), sessionId: fresh.id, activated: false };
    const options={message:injected,model:request.model,retainedInboxIds:pending.ids,queue:(request.mode||"queue")==="queue",inputId:request.inputId ?? createHash("sha256").update(request.message).digest("hex"),origin:"automation" as const};
    const sent=activation==='if_running'?await sendCurrentTurnOnly(adapter,fresh.id,options):await adapter.sendMessage(fresh.id,options);
    if (sent.notSubmitted) return {ok:sent.error?.startsWith('skipped_inactive')===true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:sent.error?.startsWith('skipped_inactive')?'skipped_inactive':'not_attempted',activated:false,...normalized,...(sent.error?.startsWith('skipped_inactive')?{}:{error:sent.error})};
    const receipt = {...(request.model?{requestedModel:request.model}:{}),...(sent.admissionKind?{admissionKind:sent.admissionKind}:{}),...(sent.admitted !== undefined ? {admitted:sent.admitted} : {}), ...(sent.inputId ? {inputId:sent.inputId} : {}), ...(sent.turnId ? {turnId:sent.turnId} : {}), ...(sent.admissionUnknown ? {admissionUnknown:true,nonRetryable:true} : {})};
    if (!sent.ok && sent.admissionUnknown && sent.nonRetryable && sent.admissionKind !== "current_turn_context" && pending.ids.length) await deferredMessages.remove(pending.ids);
    if (!sent.ok && sent.admitted && sent.nonRetryable) {
      const result: DeliverResult = {ok:false,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"accepted_failed",activated:false,admitted:true,nonRetryable:true,error:sent.error||"Native turn failed after prompt admission",...normalized,...receipt};
      rememberNamedDelivery(deliveryIdentity, result);
      if (sent.admissionKind !== "current_turn_context" && pending.ids.length) await deferredMessages.remove(pending.ids);
      return result;
    }
    if (activation !== 'if_running' && !sent.ok && !sent.nonRetryable && isBusyCodexWriter(fresh.harness, sent.error)) {
      await deferredMessages.add(fresh.id, request.message);
      return {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"deferred",activated:false,...normalized,...receipt};
    }
    if (sent.ok && sent.pending) {
      const result: DeliverResult = {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"accepted_unconfirmed",activated:false,admitted:sent.admitted === true,pending:true,...normalized,...receipt};
      rememberNamedDelivery(deliveryIdentity, result);
      if (sent.admissionKind !== "current_turn_context" && pending.ids.length) await deferredMessages.remove(pending.ids);
      return result;
    }
    if (sent.ok && sent.admissionKind !== "current_turn_context" && pending.ids.length) await deferredMessages.remove(pending.ids);
    return sent.ok ? {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:(request.mode||"queue")==="queue"?"accepted":"completed",activated:activation !== 'if_running',...normalized,...receipt} : {ok:false,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"failed",activated:false,error:sent.error||"Message delivery failed",...normalized,...receipt};
  });
}
