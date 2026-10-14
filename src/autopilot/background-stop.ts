import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { HerderJobRegistry } from "../herder-jobs.js";
import type { HarnessAdapter } from "../types/index.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

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
            progress(.1, "Программа уже отпущена; Автопилот проверяет следующий шаг");
            if (input.lastAssistantMessage && before.lastAssistant && input.lastAssistantMessage.trim() !== before.lastAssistant.trim()) return { decision: "stale" };
            const result = await this.options.evaluate({ ...input,
              lastUserMessage: before.lastUser ?? input.lastUserMessage,
              lastAssistantMessage: before.lastAssistant ?? input.lastAssistantMessage });
            if (result.decision !== "continue" || typeof result.next_goal !== "string") return result;
            const after = await this.snapshot(adapter, input);
            if (signal.aborted || !after || after.fingerprint !== before.fingerprint
              || after.session.status === "running" || after.session.status === "needs_input"
              || !await this.options.allowed(input) || await this.options.held(input.harness, input.sessionId)) return { decision: "stale-or-held" };
            // Hermes' supported plugin retains the gateway/CLI context and consumes this job result.
            if (input.harness === "hermes") return { ...result, local_delivery: true };
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
    const messages = await adapter.getSessionMessages?.(session.id, 4);
    if (!messages?.length) return null;
    const fingerprint = createHash("sha256").update(JSON.stringify(messages.map(m => [m.id, m.role, m.text, m.parts]))).digest("hex");
    return { session, fingerprint, lastUser: [...messages].reverse().find(m => m.role === "user")?.text, lastAssistant: [...messages].reverse().find(m => m.role === "assistant")?.text };
  }
}
