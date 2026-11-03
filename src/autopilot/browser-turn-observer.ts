import { createHash } from "node:crypto";
import type { AgentSession, HarnessAdapter } from "../types/index.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";
import { liveHarnessPollingEnabled } from "../harness-runtime-settings.js";

/**
 * Turn bridge for browser chat harnesses (Z.ai, ChatGPT).
 *
 * Browser providers publish no native Stop hook and no turn events, so their
 * turn ends never reach the durable Autopilot Stop consumer through a hook or
 * an event stream. This observer watches the adapters' own inventory: a
 * session that was observed running and is now idle has finished exactly one
 * remote turn, and the fingerprint of its newest messages becomes the
 * immutable turn identity of the Stop submission. The consumer re-verifies
 * status, human stops, policy and staleness exactly as it does for
 * hook-driven harnesses; repeated submissions of the same identity dedupe on
 * the durable job fingerprint, so a flapping inventory cannot double-judge.
 *
 * The same observer owns the browser autocontinue watchdog. A running turn
 * whose remote update timestamp has not advanced for a long window is
 * stalled (the provider cut the connection while the page keeps spinning):
 * one bounded continuation nudge per stalled burst goes through the normal
 * automation send path, so human stops and the automation admission apply
 * unchanged. Sessions without a real remote update timestamp carry no honest
 * stall evidence and are never nudged.
 */

const STALL_NUDGE = "[Agent Herder] Автопродолжение: генерация в этом чате, похоже, прервалась (страница показывает генерацию, но контент давно не обновлялся). Продолжи с места обрыва: коротко сверься с уже сделанным, затем доведи ответ до конца, не повторяя уже отправленные шаги.";

export interface BrowserTurnObserverSupervisor {
  sendMessage(harness: string, sessionId: string, options: {
    message: string;
    inputId?: string;
    origin?: "human" | "automation";
    queue?: boolean;
  }): Promise<{ ok: boolean; error?: string } | undefined>;
}

export interface BrowserTurnObserverOptions {
  harnesses: readonly string[];
  adapters: Map<string, HarnessAdapter>;
  supervisor: BrowserTurnObserverSupervisor;
  /** The durable Stop consumer; it deduplicates by the immutable turn identity. */
  submit: (input: AutopilotRunnerInput) => unknown;
  /** Cheap enablement probe: a disabled session must never create a job. */
  enabled: (input: AutopilotRunnerInput) => Promise<boolean>;
  held: (harness: string, sessionId: string) => Promise<boolean>;
  /** A running turn without remote progress for this long counts as stalled. */
  stallMs: number;
  /** The watchdog can be switched off while turn judging stays on. */
  autoContinue: boolean;
  tickMs?: number;
  onError?: (message: string) => void;
}

interface TrackedTurn {
  running: boolean;
  activity: string;
  runningSince: number;
  stallBaseline?: number;
  nudgedActivity?: string;
}

export class BrowserTurnAutopilotObserver {
  private readonly tracked = new Map<string, TrackedTurn>();
  private readonly probed = new Map<string, { at: number; enabled: boolean }>();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  private readonly pauseAnnounced = new Map<string, boolean>();

  constructor(private readonly options: BrowserTurnObserverOptions) {}

  start(): () => void {
    this.stop();
    const tick = () => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.observeOnce()
        .catch((error) => this.options.onError?.(`browser turn bridge failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.inFlight = false; });
    };
    this.timer = setInterval(tick, Math.max(5_000, this.options.tickMs ?? 10_000));
    this.timer.unref?.();
    tick();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tracked.clear();
    this.probed.clear();
    this.pauseAnnounced.clear();
  }

  /** Say the pause and the resume of one harness once, in the log. */
  private announcePause(harness: string, paused: boolean): void {
    if ((this.pauseAnnounced.get(harness) ?? false) === paused) return;
    this.pauseAnnounced.set(harness, paused);
    console.error(`[agent-herder] browser polling ${paused ? "paused" : "resumed"} for ${harness} (harness runtime settings${paused ? "; passive observation only" : ""})`);
  }

  /** One bounded observation pass over every bridged browser harness. */
  async observeOnce(): Promise<void> {
    for (const harness of this.options.harnesses) {
      // The runtime switch of the owner governs the requests the herder
      // initiates, not the observation itself: a paused harness is still
      // observed through whatever reaches the adapter without a request of
      // the herder's own. The ChatGPT intercept hook keeps feeding the
      // inventory through the pause, so running→idle transitions still
      // arrive and the Stop consumer still judges them; a harness without a
      // passive path simply serves its frozen inventory and no transition is
      // ever seen. The stall watchdog alone stays dark until the resume: a
      // nudge sends a message, and a message is a site action the owner
      // paused.
      this.announcePause(harness, !liveHarnessPollingEnabled(harness));
      const adapter = this.options.adapters.get(harness);
      if (!adapter?.listSessions) continue;
      let sessions: AgentSession[];
      try {
        sessions = await adapter.listSessions();
      } catch (error) {
        this.options.onError?.(`${harness} browser inventory failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const seen = new Set<string>();
      for (const session of sessions) {
        if (!session.id || session.status === "needs_input") continue;
        seen.add(session.id);
        await this.track(harness, adapter, session);
      }
      for (const [key] of this.tracked) {
        if (key.startsWith(`${harness}:`) && !seen.has(key.slice(harness.length + 1))) this.tracked.delete(key);
      }
    }
  }

  private async track(harness: string, adapter: HarnessAdapter, session: AgentSession): Promise<void> {
    const key = `${harness}:${session.id}`;
    const previous = this.tracked.get(key);
    const running = session.status === "running";

    // One remote turn finished: the observed running→idle transition.
    if (previous?.running && !running) {
      this.tracked.set(key, { running, activity: session.lastActivity, runningSince: 0 });
      await this.submitStop(harness, adapter, session);
      return;
    }

    const state: TrackedTurn = previous ?? { running, activity: session.lastActivity, runningSince: running ? Date.now() : 0 };
    state.running = running;
    state.activity = session.lastActivity;

    // Autocontinue watchdog: only a real remote update timestamp is stall
    // evidence; sidebar-order timestamps change on every poll and prove nothing.
    const semantics = (session.meta as { timestampSemantics?: string } | undefined)?.timestampSemantics;
    // A native-API running chat (ZAI last_run.status, ChatGPT async_status)
    // freezes its remote timestamps for the whole run: a long honest turn
    // must never be nudged as stalled on that frozen evidence. Only a
    // DOM-observed page proves a stall through missing remote progress.
    const evidence = (session.meta as { runningEvidence?: string } | undefined)?.runningEvidence;
    const updatedAt = typeof session.lastActivity === "string" && Number.isFinite(Date.parse(session.lastActivity))
      ? Date.parse(session.lastActivity)
      : undefined;
    if (running && liveHarnessPollingEnabled(harness) && this.options.autoContinue && semantics === "remote-update-time" && updatedAt !== undefined
      && !(evidence && evidence.startsWith("native-"))) {
      if (state.stallBaseline !== updatedAt) {
        state.stallBaseline = updatedAt;
        state.nudgedActivity = undefined;
      }
      if (state.nudgedActivity === undefined && Date.now() - updatedAt > this.options.stallMs) {
        await this.nudgeStalled(harness, session, state);
      }
    }
    this.tracked.set(key, state);
  }

  private async submitStop(harness: string, adapter: HarnessAdapter, session: AgentSession): Promise<void> {
    if (typeof session.cwd !== "string" || !session.cwd.startsWith("/")) return;
    // A finished remote turn changed the conversation history. Drop the
    // adapter's cached copy for this chat BEFORE fingerprinting, so the
    // fingerprint of the new turn differs from the already-judged one even
    // when the prewarm pipeline is paused and no revision signal arrives.
    try { await adapter.invalidateHistory?.(session.id); } catch { /* cache invalidation must never block the Stop submission */ }
    // Fingerprint first: it warms the same history cache the consumer reads.
    let fingerprint: string | undefined;
    try {
      fingerprint = await this.turnFingerprint(adapter, session.id);
    } catch (error) {
      this.options.onError?.(`${harness} turn fingerprint failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!fingerprint) return;
    const input: AutopilotRunnerInput = {
      harness: harness as AutopilotRunnerInput["harness"],
      sessionId: session.id,
      cwd: session.cwd,
      turnId: `browser:${fingerprint}`,
    };
    try {
      if (await this.options.held(harness, session.id)) return;
      if (!await this.isEnabled(input)) return;
      this.options.submit(input);
    } catch (error) {
      this.options.onError?.(`Autopilot browser Stop submission failed for ${harness}/${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async turnFingerprint(adapter: HarnessAdapter, sessionId: string): Promise<string | undefined> {
    const messages = await adapter.getSessionMessages?.(sessionId, 8);
    if (!messages || !messages.length) return undefined;
    return createHash("sha256")
      .update(JSON.stringify(messages.map((message) => [message.id, message.role, (message.text ?? "").slice(-1200)])))
      .digest("hex")
      .slice(0, 32);
  }

  private async isEnabled(input: AutopilotRunnerInput): Promise<boolean> {
    const key = `${input.harness}:${input.sessionId}`;
    const cached = this.probed.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.enabled;
    let enabled = false;
    try {
      enabled = await this.options.enabled(input);
    } catch (error) {
      this.options.onError?.(`Autopilot status probe failed for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.probed.set(key, { at: Date.now(), enabled });
    return enabled;
  }

  private async nudgeStalled(harness: string, session: AgentSession, state: TrackedTurn): Promise<void> {
    if (await this.options.held(harness, session.id)) return;
    if (!await this.isEnabled({ harness: harness as AutopilotRunnerInput["harness"], sessionId: session.id, cwd: session.cwd || "/" })) return;
    state.nudgedActivity = session.lastActivity;
    const burst = createHash("sha256").update(`${harness}:${session.id}:${session.lastActivity}`).digest("hex").slice(0, 12);
    try {
      const result = await this.options.supervisor.sendMessage(harness, session.id, {
        message: STALL_NUDGE,
        inputId: `autocontinue-${harness}-${session.id}-${burst}`,
        origin: "automation",
        queue: true,
      });
      if (result && result.ok === false) {
        this.options.onError?.(`autocontinue nudge refused for ${harness}/${session.id}: ${String(result.error ?? "unknown refusal")}`);
      }
    } catch (error) {
      this.options.onError?.(`autocontinue nudge failed for ${harness}/${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
