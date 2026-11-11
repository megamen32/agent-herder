import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { redactSecrets, type AutopilotDecision, type JudgeClient } from "../autopilot/index.js";

export type V1BrowserAutopilotTarget = { instanceRef: string; sessionRef: string };
export type V1BrowserAutopilotMessage = {
  id: string; role: string; text: string; turnId?: string; phase?: string; origin?: string; inputId?: string;
  completionStatus?: string; endTurn?: boolean;
};
export type V1BrowserAutopilotSnapshot = V1BrowserAutopilotTarget & {
  harness: "chatgpt" | "zai"; nativeSessionId: string; cwd: string;
  status: "idle" | "running" | "needs_input" | "stopped" | "error";
  humanStopHeld: boolean;
  /** Fresh authority/content revision, excluding observation timestamps. */
  revision: string; messages: V1BrowserAutopilotMessage[]; model?: string;
};
export type V1BrowserDeliveryReceipt = {
  status: "confirmed" | "accepted" | "unknown" | "rejected";
  receiptRef?: string; messageId?: string; inputId?: string; reason?: string;
};
export type V1BrowserAutopilotOptions = {
  statePath: string;
  /** Browser inference may itself have been admitted before a process died. */
  holdUnfinishedJudgingOnRestart?: boolean;
  /** Public Rust core read, never an unscoped native/browser route. Throw if unavailable. */
  read(target: V1BrowserAutopilotTarget, signal?: AbortSignal): Promise<V1BrowserAutopilotSnapshot>;
  canApply(target: V1BrowserAutopilotTarget, snapshot: V1BrowserAutopilotSnapshot): Promise<boolean> | boolean;
  createJudge(input: {
    target: V1BrowserAutopilotTarget; signal: AbortSignal; shouldContinue: () => Promise<boolean>;
  }): JudgeClient;
  /** Public Rust deliver must perform its own fresh final authority/HumanStop check. */
  deliver(input: {
    target: V1BrowserAutopilotTarget; nativeSessionId: string; message: string;
    requestKey: string; expectedRevision: string; turnId: string; signal: AbortSignal;
  }): Promise<V1BrowserDeliveryReceipt>;
  /** Read this exact existing request key. Never submit a new send. */
  reconcile(input: {
    target: V1BrowserAutopilotTarget; requestKey: string; receipt?: V1BrowserDeliveryReceipt; signal: AbortSignal;
    evidence?: { message: string; assistantMessageId: string; nativeSessionId: string };
  }): Promise<V1BrowserDeliveryReceipt>;
  isGeneratedPrompt?(target: V1BrowserAutopilotTarget, message: V1BrowserAutopilotMessage): Promise<boolean> | boolean;
};
export type V1BrowserAutopilotPolicy = V1BrowserAutopilotTarget & {
  enabled: boolean; revision: number; updatedAt: string; observation?: string;
  /** Complete redacted human text, only reused with a continuous native-history anchor. */
  lastHuman?: { id: string; text: string };
  lastObservedMessageId?: string;
};
export type V1BrowserAutopilotTurn = V1BrowserAutopilotTarget & {
  id: string; nativeSessionId: string; humanMessageId: string; assistantMessageId: string;
  turnId: string; fingerprint: string; expectedRevision: string; requestKey: string; policyRevision: number;
  state: "judging" | "judge_unknown" | "done" | "blocked" | "pending" | "accepted" | "confirmed" | "unknown" | "rejected" | "stale" | "cancelled" | "failed";
  updatedAt: string; message?: string; decision?: AutopilotDecision; receipt?: V1BrowserDeliveryReceipt; reason?: string;
};
type GeneratedInput = V1BrowserAutopilotTarget & {
  requestKey: string; afterAssistantId: string; digest: string; messageId?: string; inputId?: string;
};
export type V1BrowserAutopilotState = {
  version: 1; targets: V1BrowserAutopilotPolicy[]; turns: V1BrowserAutopilotTurn[]; generated: GeneratedInput[];
};
type Flight = { target: V1BrowserAutopilotTarget; controller: AbortController; promise: Promise<void> };
const INDETERMINATE = new Set(["pending", "accepted", "unknown"]);
const TERMINAL = new Set(["done", "blocked", "confirmed", "rejected", "judge_unknown"]);
const TURN_STATES = new Set(["judging", ...INDETERMINATE, ...TERMINAL, "stale", "cancelled", "failed"]);
const RECEIPT_STATES = new Set(["confirmed", "accepted", "unknown", "rejected"]);
const emptyState = (): V1BrowserAutopilotState => ({ version: 1, targets: [], turns: [], generated: [] });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const targetKey = (target: V1BrowserAutopilotTarget) => hash([target.instanceRef, target.sessionRef]);
const sameTarget = (a: V1BrowserAutopilotTarget, b: V1BrowserAutopilotTarget) =>
  a.instanceRef === b.instanceRef && a.sessionRef === b.sessionRef;
const stamp = () => new Date().toISOString();
function identifier(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function targetValid(value: V1BrowserAutopilotTarget): boolean {
  return !!value && identifier(value.instanceRef) && identifier(value.sessionRef);
}
function fingerprint(snapshot: V1BrowserAutopilotSnapshot): string {
  return hash([snapshot.harness, snapshot.nativeSessionId, snapshot.cwd,
    snapshot.messages.map(m => [m.id, m.role, m.text, m.turnId, m.phase, m.origin, m.inputId, m.completionStatus, m.endTurn])]);
}
function turnIdentity(target: V1BrowserAutopilotTarget, nativeId: string, assistantId: string, turnId: string): string {
  return hash([target.instanceRef, target.sessionRef, nativeId, assistantId, turnId]);
}
function stopped(): Error { return new DOMException("Browser autopilot cancelled", "AbortError"); }
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw stopped(); }
function cancelable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(stopped());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(stopped()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { assertActive(signal); return work(); }).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}

/** Caller-driven consumer over the public Rust port. No discovery authorization,
 * native write bypass, notifications or global inference queue. */
export class V1BrowserAutopilot {
  private state = emptyState();
  private loading?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private persistenceFailed = false;
  private readonly flights = new Map<string, Flight>();
  constructor(private readonly options: V1BrowserAutopilotOptions) {
    if (!isAbsolute(options.statePath)) throw new Error("browser_autopilot_state_path_must_be_absolute");
  }
  async setEnabled(target: V1BrowserAutopilotTarget, enabled: boolean): Promise<V1BrowserAutopilotPolicy> {
    if (!targetValid(target) || typeof enabled !== "boolean") throw new Error("invalid_browser_autopilot_target");
    await this.load();
    const existing = this.policy(target);
    if (existing?.enabled === enabled) return structuredClone(existing);
    const next: V1BrowserAutopilotPolicy = {
      ...target, enabled, revision: (existing?.revision ?? 0) + 1, updatedAt: stamp(),
      observation: enabled ? "enabled" : "disabled",
    };
    if (existing) Object.assign(existing, next); else this.state.targets.push(next);
    this.stop(target);
    await this.save();
    return structuredClone(this.policy(target)!);
  }
  /** Returns without awaiting inference, so a busy session cannot block polling. */
  async tick(): Promise<{ started: number; active: number }> {
    await this.load();
    if (this.persistenceFailed) throw new Error("browser_autopilot_persistence_unavailable");
    let started = 0;
    for (const policy of this.state.targets) {
      const key = targetKey(policy);
      if (!policy.enabled || this.flights.has(key)) continue;
      const target = { instanceRef: policy.instanceRef, sessionRef: policy.sessionRef };
      const flight: Flight = { target, controller: new AbortController(), promise: Promise.resolve() };
      this.flights.set(key, flight);
      flight.promise = this.run(target, policy.revision, flight.controller.signal)
        .catch(() => { /* run records safe diagnostics; failed persistence closes admission. */ })
        .finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
      started++;
    }
    return { started, active: this.flights.size };
  }
  /** Abort active work; setEnabled(false) makes a durable policy change. */
  stop(target?: V1BrowserAutopilotTarget): void {
    for (const flight of this.flights.values()) if (!target || sameTarget(flight.target, target)) flight.controller.abort();
  }
  async settle(target?: V1BrowserAutopilotTarget): Promise<void> {
    await Promise.all([...this.flights.values()].filter(f => !target || sameTarget(f.target, target)).map(f => f.promise));
    await this.writing;
  }
  async inspect(): Promise<V1BrowserAutopilotState & { active: V1BrowserAutopilotTarget[]; persistenceFailed: boolean }> {
    await this.load();
    return structuredClone({ ...this.state, active: [...this.flights.values()].map(f => f.target), persistenceFailed: this.persistenceFailed });
  }
  private policy(target: V1BrowserAutopilotTarget) { return this.state.targets.find(p => sameTarget(p, target)); }
  private enabled(target: V1BrowserAutopilotTarget, revision: number, signal: AbortSignal): boolean {
    const current = this.policy(target);
    return !this.persistenceFailed && !signal.aborted && current?.enabled === true && current.revision === revision;
  }
  private async observe(target: V1BrowserAutopilotTarget, observation: string): Promise<void> {
    const policy = this.policy(target);
    if (policy && policy.observation !== observation) { policy.observation = observation; policy.updatedAt = stamp(); await this.save(); }
  }
  private async fresh(target: V1BrowserAutopilotTarget, signal: AbortSignal): Promise<V1BrowserAutopilotSnapshot | null> {
    const value = await cancelable(() => this.options.read(target, signal), signal);
    if (!value || !sameTarget(value, target) || !identifier(value.nativeSessionId) || !identifier(value.revision)
      || !["chatgpt", "zai"].includes(value.harness) || !isAbsolute(value.cwd) || typeof value.humanStopHeld !== "boolean"
      || !["idle", "running", "needs_input", "stopped", "error"].includes(value.status)
      || !Array.isArray(value.messages) || !value.messages.every(m => identifier(m.id) && identifier(m.role) && typeof m.text === "string"
        && (m.completionStatus === undefined || typeof m.completionStatus === "string")
        && (m.endTurn === undefined || typeof m.endTurn === "boolean"))) return null;
    const snapshot = structuredClone(value);
    if (!await cancelable(() => Promise.resolve(this.options.canApply(target, snapshot)), signal)) return null;
    return snapshot;
  }
  private async generated(target: V1BrowserAutopilotTarget, message: V1BrowserAutopilotMessage,
    index: number, messages: V1BrowserAutopilotMessage[], signal: AbortSignal): Promise<"yes" | "no" | "unknown"> {
    if (this.options.isGeneratedPrompt
      && await cancelable(() => Promise.resolve(this.options.isGeneratedPrompt!(target, message)), signal)) return "yes";
    let ambiguous = false;
    for (const input of this.state.generated) {
      if (!sameTarget(input, target)) continue;
      if (input.messageId === message.id || input.inputId && input.inputId === message.inputId) return "yes";
      if (input.messageId || input.digest !== hash(message.text)) continue;
      const anchor = messages.findIndex(row => row.id === input.afterAssistantId);
      const candidates = messages.filter((row, at) => at > anchor && row.role === "user" && hash(row.text) === input.digest);
      const firstUser = messages.findIndex((row, at) => at > anchor && row.role === "user");
      if (anchor >= 0 && index === firstUser && candidates.length === 1) {
        // Only a confirmed send plus unique fresh native readback binds a message ID.
        input.messageId = message.id;
        return "yes";
      }
      ambiguous = true;
    }
    return ambiguous ? "unknown" : "no";
  }
  private async pair(target: V1BrowserAutopilotTarget, snapshot: V1BrowserAutopilotSnapshot, signal: AbortSignal) {
    let assistantIndex = -1;
    let latestUserIndex = -1;
    let human: V1BrowserAutopilotMessage | undefined;
    let humanIndex = -1;
    for (let index = snapshot.messages.length - 1; index >= 0; index--) {
      const message = snapshot.messages[index]!;
      if (assistantIndex < 0 && message.role === "assistant") assistantIndex = index;
      if (message.role !== "user") continue;
      if (latestUserIndex < 0) latestUserIndex = index;
      const origin = await this.generated(target, message, index, snapshot.messages, signal);
      if (origin === "unknown") return null;
      if (origin === "no") { human = message; humanIndex = index; break; }
    }
    const policy = this.policy(target)!;
    if (!human) {
      // Carry a previously observed human only when the last observed anchor
      // remains in this bounded tail and every observed user was proven generated.
      const anchor = policy.lastObservedMessageId
        ? snapshot.messages.findIndex(message => message.id === policy.lastObservedMessageId) : -1;
      if (!policy.lastHuman || anchor < 0 || assistantIndex < anchor) return null;
      human = { ...policy.lastHuman, role: "user" };
    }
    if (assistantIndex < 0 || assistantIndex < humanIndex || assistantIndex < latestUserIndex) return null;
    const assistant = snapshot.messages[assistantIndex]!;
    if (!human.text.trim() || !assistant.text.trim()
      || assistant.phase !== undefined && !["stop", "final", "completed"].includes(assistant.phase)) return null;
    // Native session idle and channel=final may both be observed while final
    // text is still streaming. Require positive native completion evidence;
    // explicit incomplete/error evidence always wins over a contradictory flag.
    if (assistant.endTurn === false) return null;
    if (assistant.completionStatus !== undefined && assistant.completionStatus !== "finished_successfully") return null;
    if (assistant.endTurn !== true && assistant.completionStatus !== "finished_successfully") return null;
    policy.lastHuman = { id: human.id, text: redactSecrets(human.text) };
    policy.lastObservedMessageId = snapshot.messages.at(-1)!.id;
    return { human, assistant };
  }
  private async applyReceipt(record: V1BrowserAutopilotTurn, value: V1BrowserDeliveryReceipt): Promise<void> {
    const receipt = cleanReceipt(value);
    record.receipt = { ...record.receipt, ...receipt };
    record.state = receipt.status; record.updatedAt = stamp();
    if (receipt.status === "confirmed" && record.message && !this.state.generated.some(item => item.requestKey === record.requestKey)) {
      this.state.generated.push({
        instanceRef: record.instanceRef, sessionRef: record.sessionRef, requestKey: record.requestKey,
        afterAssistantId: record.assistantMessageId, digest: hash(record.message),
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}), ...(receipt.inputId ? { inputId: receipt.inputId } : {}),
      });
    }
    await this.save();
  }
  private async run(target: V1BrowserAutopilotTarget, policyRevision: number, signal: AbortSignal): Promise<void> {
    let record: V1BrowserAutopilotTurn | undefined;
    let dispatchStarted = false;
    let judgeStarted = false;
    try {
      if (!this.enabled(target, policyRevision, signal)) return;
      record = this.state.turns.find(turn => sameTarget(turn, target) && INDETERMINATE.has(turn.state));
      if (record) {
        dispatchStarted = true; // An earlier process may already have submitted this effect.
        // Accepted/UNKNOWN/pending effects survive restart. No new inference or send.
        const receipt = await cancelable(() => this.options.reconcile({
          target, requestKey: record!.requestKey, receipt: record!.receipt, signal,
          evidence: { message: record!.message!, assistantMessageId: record!.assistantMessageId, nativeSessionId: record!.nativeSessionId },
        }), signal);
        await this.applyReceipt(record, receipt); await this.observe(target, record.state); return;
      }
      const before = await this.fresh(target, signal);
      if (!before || before.status !== "idle" || before.humanStopHeld) {
        await this.observe(target, !before ? "paused_scope_or_state_unavailable" : before.humanStopHeld ? "paused_human_stop" : `waiting_${before.status}`); return;
      }
      const pair = await this.pair(target, before, signal);
      if (!pair) { await this.observe(target, "paused_missing_complete_human_assistant_pair"); return; }
      const turnId = pair.assistant.turnId || pair.assistant.id;
      const id = turnIdentity(target, before.nativeSessionId, pair.assistant.id, turnId);
      record = this.state.turns.find(turn => turn.id === id);
      if (record && (TERMINAL.has(record.state) || record.state === "failed" && record.policyRevision === policyRevision)) {
        // Retain native readback provenance and continuity anchors even when no
        // new inference is admitted for this completed turn.
        await this.save(); await this.observe(target, record.state); return;
      }
      const beforeFingerprint = fingerprint(before);
      const next: V1BrowserAutopilotTurn = {
        ...target, id, nativeSessionId: before.nativeSessionId, humanMessageId: pair.human.id,
        assistantMessageId: pair.assistant.id, turnId, fingerprint: beforeFingerprint,
        expectedRevision: before.revision, requestKey: `browser-autopilot:${id}`, policyRevision, state: "judging", updatedAt: stamp(),
      };
      if (record) Object.assign(record, next); else { record = next; this.state.turns.push(record); }
      await this.save();
      const fence = async () => {
        if (!this.enabled(target, policyRevision, signal)) return false;
        const current = await this.fresh(target, signal);
        return !!current && current.status === "idle" && !current.humanStopHeld
          && current.nativeSessionId === before.nativeSessionId && current.cwd === before.cwd
          && current.revision === before.revision && fingerprint(current) === beforeFingerprint
          && this.enabled(target, policyRevision, signal);
      };
      if (!await fence()) { record.state = "stale"; record.updatedAt = stamp(); await this.save(); return; }
      await this.observe(target, "judging");
      const judge = this.options.createJudge({ target, signal, shouldContinue: fence });
      const raw = await cancelable(() => {
        judgeStarted = true;
        return judge.decide({
        hook: {
          hook_event_name: "Stop", harness: before.harness, session_id: before.nativeSessionId,
          cwd: before.cwd, turn_id: turnId, transcript_path: null, stop_hook_active: false,
          last_user_message: pair.human.text, last_assistant_message: pair.assistant.text,
          messages: before.messages.map(({ id, role, text }) => ({ id, role, text })),
          ...(before.model ? { model: before.model } : {}),
        },
        evidence: "Authoritative native messages and the complete latest human/assistant pair are supplied in hook.",
        remainingContinuations: 1,
        });
      }, signal);
      const decision = cleanDecision(raw);
      if (!await fence()) { record.state = "stale"; record.updatedAt = stamp(); await this.save(); return; }
      record.decision = decision;
      if (decision.kind !== "continue") {
        record.state = decision.kind === "done" ? "done" : "blocked"; record.updatedAt = stamp();
        await this.save(); await this.observe(target, record.state); return;
      }
      record.message = decision.nextGoal; record.state = "pending"; record.updatedAt = stamp();
      await this.save(); // Must precede every native deliver.
      if (!await fence()) { record.state = "stale"; record.updatedAt = stamp(); await this.save(); return; }
      const receipt = await cancelable(() => {
        dispatchStarted = true;
        return this.options.deliver({
          target, nativeSessionId: before.nativeSessionId, message: decision.nextGoal,
          requestKey: record!.requestKey, expectedRevision: before.revision, turnId, signal,
        });
      }, signal);
      await this.applyReceipt(record, receipt); await this.observe(target, record.state);
    } catch (error) {
      if (record && !TERMINAL.has(record.state)) {
        const aborted = signal.aborted || (error as { name?: string })?.name === "AbortError";
        const uncertainBrowserJudge = this.options.holdUnfinishedJudgingOnRestart
          && judgeStarted && record.state === "judging" && aborted;
        record.state = dispatchStarted && INDETERMINATE.has(record.state) ? "unknown"
          : uncertainBrowserJudge ? "judge_unknown" : aborted ? "cancelled" : "failed";
        record.reason = record.state === "unknown" ? "delivery_outcome_requires_reconciliation"
          : record.state === "judge_unknown" ? "browser_judge_outcome_requires_verification"
          : record.state === "cancelled" ? "cancelled_or_fenced" : "evaluation_unavailable";
        record.updatedAt = stamp(); await this.save();
      }
      await this.observe(target, record?.state ?? (signal.aborted ? "cancelled" : "paused_read_unavailable"));
    }
  }
  private load(): Promise<void> {
    return this.loading ??= (async () => {
      let contents: string;
      try {
        const info = await lstat(this.options.statePath);
        if (!info.isFile() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()) || info.size > 16 * 1024 * 1024) {
          throw new Error("browser_autopilot_state_not_private_or_too_large");
        }
        contents = await readFile(this.options.statePath, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const value = JSON.parse(contents) as V1BrowserAutopilotState;
      validateState(value); this.state = value;
      if (this.options.holdUnfinishedJudgingOnRestart) {
        let changed = false;
        for (const turn of this.state.turns) {
          if (turn.state !== "judging") continue;
          turn.state = "judge_unknown";
          turn.reason = "browser_judge_outcome_requires_verification";
          turn.updatedAt = stamp();
          const policy = this.policy(turn);
          if (policy) { policy.observation = "judge_unknown"; policy.updatedAt = stamp(); }
          changed = true;
        }
        if (changed) await this.save();
      }
    })();
  }
  private save(): Promise<void> {
    const work = this.writing.then(async () => {
      if (this.persistenceFailed) throw new Error("browser_autopilot_persistence_unavailable");
      const parent = dirname(this.options.statePath);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const temporary = `${this.options.statePath}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.options.statePath);
        const directory = await open(parent, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    this.writing = work.catch(() => { this.persistenceFailed = true; this.stop(); });
    return work;
  }
}
function cleanReceipt(value: V1BrowserDeliveryReceipt): V1BrowserDeliveryReceipt {
  if (!value || !RECEIPT_STATES.has(value.status)
    || value.receiptRef !== undefined && !identifier(value.receiptRef)
    || value.messageId !== undefined && !identifier(value.messageId)
    || value.inputId !== undefined && !identifier(value.inputId)) throw new Error("invalid_browser_delivery_receipt");
  return { status: value.status, ...(value.receiptRef ? { receiptRef: value.receiptRef } : {}),
    ...(value.messageId ? { messageId: value.messageId } : {}), ...(value.inputId ? { inputId: value.inputId } : {}),
    ...(typeof value.reason === "string" ? { reason: redactSecrets(value.reason).slice(0, 500) } : {}),
  };
}
function cleanDecision(value: unknown): AutopilotDecision {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (value: unknown, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_browser_judge_decision");
    return redactSecrets(value).trim();
  };
  if (item.kind === "continue") return { kind: "continue", nextGoal: text(item.nextGoal, 16_000) };
  if (item.kind === "done") return { kind: "done", summary: text(item.summary, 16_000), notify: false };
  if (item.kind === "human" && ["low", "medium", "high"].includes(String(item.severity))) {
    return { kind: "human", title: text(item.title, 512), body: text(item.body, 16_000), severity: item.severity as "low" | "medium" | "high" };
  }
  if (item.kind === "choice" && Array.isArray(item.choices) && item.choices.length >= 2 && item.choices.length <= 4) {
    const choices = item.choices.map(choice => ({
      choiceId: text(choice?.choiceId, 128), label: text(choice?.label, 512), nextGoal: text(choice?.nextGoal, 16_000),
    }));
    if (new Set(choices.map(choice => choice.choiceId)).size !== choices.length) throw new Error("invalid_browser_judge_decision");
    return { kind: "choice", choices, ...(typeof item.recommendedChoiceId === "string" && choices.some(c => c.choiceId === item.recommendedChoiceId)
      ? { recommendedChoiceId: item.recommendedChoiceId } : {}) };
  }
  throw new Error("invalid_browser_judge_decision");
}
function validateState(value: V1BrowserAutopilotState): void {
  const invalid = () => { throw new Error("invalid_browser_autopilot_state"); };
  if (!value || value.version !== 1 || !Array.isArray(value.targets) || !Array.isArray(value.turns) || !Array.isArray(value.generated)) invalid();
  const targets = new Set<string>();
  for (const policy of value.targets) {
    if (!targetValid(policy) || typeof policy.enabled !== "boolean" || !Number.isSafeInteger(policy.revision) || policy.revision < 1
      || policy.lastHuman && (!identifier(policy.lastHuman.id) || typeof policy.lastHuman.text !== "string" || !policy.lastHuman.text.trim())
      || policy.lastObservedMessageId !== undefined && !identifier(policy.lastObservedMessageId)) invalid();
    const key = targetKey(policy); if (targets.has(key)) invalid(); targets.add(key);
  }
  const ids = new Set<string>();
  for (const turn of value.turns) {
    if (!targetValid(turn) || !targets.has(targetKey(turn)) || !TURN_STATES.has(turn.state)
      || !identifier(turn.nativeSessionId) || !identifier(turn.assistantMessageId) || !identifier(turn.humanMessageId) || !identifier(turn.turnId)
      || turn.id !== turnIdentity(turn, turn.nativeSessionId, turn.assistantMessageId, turn.turnId)
      || turn.requestKey !== `browser-autopilot:${turn.id}` || !/^[a-f0-9]{64}$/u.test(turn.fingerprint)
      || !identifier(turn.expectedRevision) || !Number.isSafeInteger(turn.policyRevision) || turn.policyRevision < 1 || ids.has(turn.id)) invalid();
    ids.add(turn.id);
    if ((INDETERMINATE.has(turn.state) || turn.state === "confirmed")
      && (typeof turn.message !== "string" || !turn.message.trim() || turn.message.length > 16_000)) invalid();
    if (turn.receipt) cleanReceipt(turn.receipt);
    if (turn.decision) cleanDecision(turn.decision);
  }
  for (const input of value.generated) {
    if (!targetValid(input) || !/^[a-f0-9]{64}$/u.test(input.digest) || !identifier(input.afterAssistantId)
      || input.messageId !== undefined && !identifier(input.messageId) || input.inputId !== undefined && !identifier(input.inputId)
      || !value.turns.some(turn => turn.state === "confirmed" && turn.requestKey === input.requestKey && sameTarget(turn, input))) invalid();
  }
}
