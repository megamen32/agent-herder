import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { HerderJobRegistry } from "../herder-jobs.js";
import type { HarnessAdapter } from "../types/index.js";
import type { AutopilotRunnerInput, NativeFenceRead, NativeReportObservation } from "../autopilot-runner.js";
import { applyAutopilotGoalCompletion, autopilotGoalArmed, autopilotGoalControllerAllowed, autopilotGoalFenceCurrent, autopilotGoalNativeInputsKnown, autopilotGoalNativeReportAdmissible, withAutopilotGoalContinuationAdmission } from "../autopilot-runner.js";
import { getHumanStopStore } from "../human-stop-store.js";

/** Uses the existing daemon jobs/Stop judge/native writers. No subprocess or extra loop. */
export class BackgroundAutopilotStop {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, number>();
  private queued = 0;
  constructor(private readonly options: {
    jobs: HerderJobRegistry;
    adapters: Map<string, HarnessAdapter>;
    evaluate: (input: AutopilotRunnerInput) => Promise<Record<string, unknown>>;
    held: (harness: string, sessionId: string) => Promise<boolean>;
    allowed: (input: AutopilotRunnerInput) => Promise<boolean>;
    deliver: (input: AutopilotRunnerInput, goal: string, inputId: string) => Promise<unknown>;
  }) {}
  isPending(harness: string, id: string): boolean { return (this.pending.get(`${harness}:${id}`) ?? 0) > 0; }
  submit(input: AutopilotRunnerInput) {
    if (!["codex", "claude", "zcode", "opencode", "hermes"].includes(input.harness) || !input.sessionId?.trim()
      || !input.cwd?.startsWith("/") || !input.turnId?.trim()) throw new Error("Stop requires harness, sessionId, absolute cwd and turnId");
    // The same immutable event identity is independent from repeated hook metadata.
    const key = `autopilot-stop:${input.harness}:${resolve(input.cwd)}:${input.sessionId}:${input.turnId}`;
    const fingerprint = createHash("sha256").update(key).digest("hex");
    const existing = this.options.jobs.get(`job_${fingerprint}`);
    if (existing) return existing;
    if (this.queued >= 32) throw new Error("Background Autopilot queue is full");
    const target = `${input.harness}:${input.sessionId}`;
    this.pending.set(target, (this.pending.get(target) ?? 0) + 1); this.queued++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; });
    try {
      return this.options.jobs.start({ kind: "Разбор завершённого хода Автопилотом", ownerSessionId: input.sessionId,
        idempotencyKey: key, requestFingerprint: fingerprint,
        run: async ({ signal, progress }) => {
          try {
            await previous;
            if (signal.aborted || !await this.options.allowed(input) || await this.options.held(input.harness, input.sessionId)) return { decision: "human-stop-held" };
            const adapter = this.options.adapters.get(input.harness);
            if (!adapter) return { decision: "unavailable" };
            const before = await this.snapshot(adapter, input);
            if (!before || before.session.status === "needs_input") return { decision: "deferred" };
            const controller = await autopilotGoalControllerAllowed(input, before.session);
            if (!controller.allowed) return { decision: "unavailable", reason: controller.reason ?? "native-goal-controller-unavailable" };
            if (!await autopilotGoalNativeInputsKnown(input, before.messages)) return { decision: "unavailable", reason: "unregistered-native-human-input" };
            progress(.1, "Программа уже отпущена; Автопилот проверяет следующий шаг");
            if (input.lastAssistantMessage && before.lastAssistant && input.lastAssistantMessage.trim() !== before.lastAssistant.trim()) return { decision: "stale" };
            const result = await this.options.evaluate({ ...input,
              lastUserMessage: before.lastUser ?? input.lastUserMessage,
              lastAssistantMessage: before.lastAssistant ?? input.lastAssistantMessage,
              nativeReportObservation: before.nativeReportObservation,
              nativeFence: async () => {
                const current = await this.snapshot(adapter, input);
                if (!current || current.fingerprint !== before.fingerprint) return false;
                const currentController = await autopilotGoalControllerAllowed(input, current.session);
                const allowed = currentController.allowed
                  && current.session.status !== "running" && current.session.status !== "needs_input"
                  && await autopilotGoalNativeInputsKnown(input, current.messages)
                  && !signal.aborted && await this.options.allowed(input) && !await this.options.held(input.harness, input.sessionId);
                return { allowed, nativeReportObservation: current.nativeReportObservation } satisfies NativeFenceRead;
              } });
            const doneCandidate = result.decision === "done-candidate";
            if (!doneCandidate && (result.decision !== "continue" || typeof result.next_goal !== "string")) return result;
            const after = await this.snapshot(adapter, input);
            if (signal.aborted || !after || after.fingerprint !== before.fingerprint
              || after.session.status === "running" || after.session.status === "needs_input"
              || !await this.options.allowed(input) || await this.options.held(input.harness, input.sessionId)) return { decision: "stale-or-held" };
            const afterController = await autopilotGoalControllerAllowed(input, after.session);
            if (!afterController.allowed) return { decision: "unavailable", reason: afterController.reason ?? "native-goal-controller-unavailable" };
            if (result.goal_control === "opt-in") {
              const fence = result.goal_fence;
              if (!fence || typeof fence !== "object" || !await autopilotGoalFenceCurrent(input, fence as Record<string, unknown>)
                || !await autopilotGoalNativeInputsKnown(input, after.messages)) return { decision: "stale-goal-fence" };
            }
            if (doneCandidate) {
              if (signal.aborted || !await this.options.allowed(input) || await this.options.held(input.harness, input.sessionId)) return { decision: "stale-or-held" };
              const completed = await applyAutopilotGoalCompletion(input, result.completion_ticket, after.nativeReportObservation);
              return completed
                ? { ...result, decision: "terminal", terminalKind: "completed", completion_ticket: undefined }
                : { decision: "stale-completion-ticket" };
            }
            if (typeof result.next_goal !== "string") return { decision: "unavailable" };
            if (input.harness === "hermes") {
              if (result.goal_control === "opt-in") return { decision: "unavailable", reason: "Hermes full-goal delivery has no atomic admission" };
              return { ...result, local_delivery: true };
            }
            if (result.goal_control === "opt-in") {
              const fence = result.goal_fence as Record<string, unknown>;
              await getHumanStopStore().rememberGeneratedPrompt(input.harness, input.sessionId, result.next_goal, input.turnId);
              const admission = await withAutopilotGoalContinuationAdmission(input, fence, async () => {
                const admissionController = await autopilotGoalControllerAllowed(input, after.session);
                if (!admissionController.allowed || signal.aborted || !await this.options.allowed(input) || await this.options.held(input.harness, input.sessionId)) return { accepted: false as const };
                return { accepted: true as const, delivery: await this.options.deliver(input, result.next_goal as string, `agent-herder:auto:${fingerprint}`) };
              }, {
                actionFingerprint: String(result.goal_action_fingerprint ?? ""),
                evidenceFingerprint: String(result.goal_evidence_fingerprint ?? ""),
                classify: value => {
                  if (!value.accepted) return "not-admitted";
                  const receipt = value.delivery && typeof value.delivery === "object" ? (value.delivery as Record<string, unknown>).receipt as Record<string, unknown> | undefined : undefined;
                  const status = value.delivery && typeof value.delivery === "object" ? (value.delivery as Record<string, unknown>).status : undefined;
                  if (status === "accepted" || status === "delivered") return "accepted";
                  if (receipt?.status === "rejected" || receipt?.status === "not_accepted") return "not-admitted";
                  return "unknown";
                },
              });
              if (!admission.admitted || !admission.result.accepted) return { decision: "stale-or-held" };
              return { ...result, delivery: admission.result.delivery };
            }
            const delivery = await this.options.deliver(input, result.next_goal, `agent-herder:auto:${fingerprint}`);
            return { ...result, delivery };
          } finally { this.queued--; this.releaseTarget(target); release(); }
        },
      });
    } catch (error) { this.queued--; this.releaseTarget(target); release(); throw error; }
  }
  private releaseTarget(target: string): void {
    const count = this.pending.get(target) ?? 1;
    if (count <= 1) this.pending.delete(target); else this.pending.set(target, count - 1);
  }
  private async snapshot(adapter: HarnessAdapter, input: AutopilotRunnerInput) {
    // ZCode must bind the original workspace before its cold shared SDK read.
    const session = input.harness === "zcode"
      ? (await adapter.listSessions({ cwd: input.cwd })).find(s => s.id === input.sessionId)
      : await adapter.getSession(input.sessionId);
    if (!session || session.id !== input.sessionId || resolve(session.cwd) !== resolve(input.cwd) || session.needsPermission) return null;
    const messages = await adapter.getSessionMessages?.(session.id, 50);
    if (!messages || (!messages.length && !await autopilotGoalArmed(input))) return null;
    const fingerprint = createHash("sha256").update(JSON.stringify(messages.map(m => [m.id, m.role, m.text, m.parts]))).digest("hex");
    let nativeReportObservation = observeNativeReport(input, messages, fingerprint);
    if (nativeReportObservation.status === "observed" && !await autopilotGoalNativeReportAdmissible(input, messages, nativeReportObservation.messageId)) {
      nativeReportObservation = { status: "unavailable", nativeFingerprint: fingerprint, reason: "no matching current-goal continuation is linked to this assistant message" };
    }
    return { session, fingerprint, messages, nativeReportObservation, lastUser: [...messages].reverse().find(m => m.role === "user")?.text, lastAssistant: [...messages].reverse().find(m => m.role === "assistant")?.text };
  }
}

const MAX_NATIVE_REPORT_BYTES = 64 * 1024;
const CREDENTIAL_SHAPED_NATIVE_TEXT = /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*[^\s,;]{8,})/iu;
export function observeNativeReport(input: AutopilotRunnerInput, messages: import("../types/index.js").SessionMessageView[], nativeFingerprint: string): NativeReportObservation {
  const message = [...messages].reverse().find(item => item.role === "assistant");
  if (!message?.id?.trim()) return { status: "unavailable", nativeFingerprint, reason: "no identified assistant message in bounded native history" };
  const text = message.parts.filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text!).join("\n");
  if (!text.trim()) return { status: "unavailable", nativeFingerprint, reason: "assistant message has no visible text parts" };
  if (Buffer.byteLength(text, "utf8") > MAX_NATIVE_REPORT_BYTES) return { status: "unavailable", nativeFingerprint, reason: "visible assistant message exceeds the native report evidence limit" };
  if (CREDENTIAL_SHAPED_NATIVE_TEXT.test(text)) return { status: "unavailable", nativeFingerprint, reason: "visible assistant message contains credential-shaped text" };
  const version = createHash("sha256").update(JSON.stringify([input.harness, input.sessionId, resolve(input.cwd), nativeFingerprint, message.id, message.role, message.turnId ?? null, text])).digest("hex");
  const observedAt = new Date().toISOString();
  return { status: "observed", nativeFingerprint, messageId: message.id, ...(message.turnId ? { turnId: message.turnId } : {}), text, version, observedAt,
    freshUntil: new Date(Date.now() + 60_000).toISOString() };
}
