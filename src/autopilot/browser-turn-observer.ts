import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /** Read the exact submitted job; unavailable or uncertain jobs are never replayed. */
  readJob?: (id: string) => { state: string; result?: unknown } | null | undefined;
  /** Cheap enablement probe: a disabled session must never create a job. */
  enabled: (input: AutopilotRunnerInput) => Promise<boolean>;
  held: (harness: string, sessionId: string) => Promise<boolean>;
  /** Chat commands of a finished turn (/pilot): returns true when a new
   * command ran and was answered, so the Stop of that turn is skipped. */
  handleTurnCommands?: (harness: string, sessionId: string, cwd: string, messages: ReadonlyArray<{ id?: string; role?: string; text?: string }>) => Promise<boolean>;
  /** A running turn without remote progress for this long counts as stalled. */
  stallMs: number;
  /** The watchdog can be switched off while turn judging stays on. */
  autoContinue: boolean;
  /** A running turn whose inventory stopped advancing gets one bounded
   * driver-side refresh per this interval; 0 disables it. Default 5 min. */
  staleRefreshMs?: number;
  /** Durable file of the tracked turns: a herder restart mid-run still
   * observes the running->idle transition of the turn that spanned it. */
  turnsFile?: string;
  tickMs?: number;
  onError?: (message: string) => void;
}

interface TrackedTurn {
  running: boolean;
  activity: string;
  runningSince: number;
  stallBaseline?: number;
  nudgedActivity?: string;
  lastStaleRefreshAt?: number;
  pendingJobId?: string;
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

  private get staleRefreshMs(): number {
    return this.options.staleRefreshMs ?? 300_000;
  }

  /** One bounded driver-side re-read of the turn state of one chat. */
  private async refreshStaleTurn(harness: string, session: AgentSession): Promise<void> {
    const adapter = this.options.adapters.get(harness) as HarnessAdapter & { refreshSession?: (id: string) => Promise<boolean> };
    if (typeof adapter?.refreshSession !== "function") return;
    try {
      await adapter.refreshSession(session.id);
    } catch (error) {
      this.options.onError?.(`stale turn refresh failed for ${harness}/${session.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Load the durable turns of the previous process: a restart mid-run
   * still observes the running->idle transition of the turn that spanned
   * it. A corrupt or missing file starts tracking from scratch. */
  private loadTurns(): void {
    const file = this.options.turnsFile;
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        version?: number;
        turns?: Record<string, { running?: boolean; activity?: string; runningSince?: number; lastStaleRefreshAt?: number; pendingJobId?: string }>;
      };
      if (parsed?.version !== 1 || !parsed.turns || typeof parsed.turns !== "object") return;
      for (const [key, entry] of Object.entries(parsed.turns)) {
        if (typeof entry?.running !== "boolean") continue;
        const runningSince = typeof entry.runningSince === "number" && Number.isFinite(entry.runningSince) ? entry.runningSince : 0;
        // A persisted running turn older than two hours is nonsense (the
        // stall watchdog and the provider cap a turn far earlier); never
        // let a stale file invent a transition that never happened.
        if (entry.running && Date.now() - runningSince > 2 * 60 * 60 * 1000) continue;
        this.tracked.set(key, {
          running: entry.running,
          activity: typeof entry.activity === "string" ? entry.activity : "",
          runningSince,
          ...(typeof entry.pendingJobId === "string" && entry.pendingJobId ? { pendingJobId: entry.pendingJobId } : {}),
          ...(typeof entry.lastStaleRefreshAt === "number" && Number.isFinite(entry.lastStaleRefreshAt) ? { lastStaleRefreshAt: entry.lastStaleRefreshAt } : {}),
        });
      }
    } catch { /* a missing or corrupt file starts from scratch */ }
  }

  /** Persist the tracked turns atomically (tmp + rename). */
  private saveTurns(): void {
    const file = this.options.turnsFile;
    if (!file) return;
    try {
      const turns: Record<string, { running: boolean; activity: string; runningSince: number; lastStaleRefreshAt?: number; pendingJobId?: string }> = {};
      for (const [key, state] of this.tracked) {
        turns[key] = {
          running: state.running,
          activity: state.activity,
          runningSince: state.runningSince,
          ...(state.pendingJobId ? { pendingJobId: state.pendingJobId } : {}),
          ...(state.lastStaleRefreshAt ? { lastStaleRefreshAt: state.lastStaleRefreshAt } : {}),
        };
      }
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, turns }));
      renameSync(temporary, file);
    } catch (error) {
      this.options.onError?.(`browser turn state save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /** Say the pause and the resume of one harness once, in the log. */
  private announcePause(harness: string, paused: boolean): void {
    if ((this.pauseAnnounced.get(harness) ?? false) === paused) return;
    this.pauseAnnounced.set(harness, paused);
    console.error(`[agent-herder] browser polling ${paused ? "paused" : "resumed"} for ${harness} (harness runtime settings${paused ? "; passive observation only" : ""})`);
  }

  /** One bounded observation pass over every bridged browser harness. */
  private turnsLoaded = false;

  async observeOnce(): Promise<void> {
    if (!this.turnsLoaded) { this.turnsLoaded = true; this.loadTurns(); }
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
      if (!adapter || (harness !== "chatgpt" && !adapter.listSessions)) continue;
      let sessions: AgentSession[];
      try {
        if (harness === "chatgpt") {
          const passive = adapter as HarnessAdapter & { listBackgroundSessions?: () => Promise<AgentSession[]> };
          sessions = await passive.listBackgroundSessions?.() ?? [];
        } else sessions = await adapter.listSessions();
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
      let pruned = false;
      if (sessions.length) for (const [key] of this.tracked) {
        if (key.startsWith(`${harness}:`) && !seen.has(key.slice(harness.length + 1))) { this.tracked.delete(key); pruned = true; }
      }
      if (pruned) this.saveTurns();
    }
  }

  private async track(harness: string, adapter: HarnessAdapter, session: AgentSession): Promise<void> {
    const key = `${harness}:${session.id}`;
    const previous = this.tracked.get(key);
    const running = session.status === "running";

    if (harness === "chatgpt" && previous?.pendingJobId && running) {
      previous.pendingJobId = undefined;
      this.saveTurns();
    }
    if (harness === "chatgpt" && previous?.pendingJobId && !running) {
      const job = this.options.readJob?.(previous.pendingJobId);
      if (!job || ["queued", "running", "waiting", "cancelling"].includes(job.state)) return;
      const result = job.result as { decision?: unknown; reason?: unknown } | undefined;
      if (job.state !== "completed" || result?.decision !== "deferred"
        || result.reason !== "passive-snapshot-unavailable-before-evaluation") {
        this.tracked.set(key, { running: false, activity: session.lastActivity, runningSince: 0 });
        this.saveTurns();
        return;
      }
      // A completed deferral occurs before evaluation or delivery; only that
      // exact outcome may be reconsidered. The Stop consumer enforces it too.
      previous.pendingJobId = undefined;
    }

    // One remote turn finished: the observed running→idle transition.
    if (previous?.running && !running) {
      if (harness === "chatgpt") {
        // Keep the durable running marker until passive history is available.
        // Otherwise a cooldown or a closed tab permanently loses this turn.
        const result = await this.submitStop(harness, adapter, session);
        if (!result) return;
        if (typeof result === "object") {
          this.tracked.set(key, { ...previous, pendingJobId: result.jobId });
          this.saveTurns();
          return;
        }
        this.tracked.set(key, { running, activity: session.lastActivity, runningSince: 0 });
        this.saveTurns();
        return;
      }
      this.tracked.set(key, { running, activity: session.lastActivity, runningSince: 0 });
      this.saveTurns();
      await this.submitStop(harness, adapter, session);
      return;
    }

    const state: TrackedTurn = previous ?? { running, activity: session.lastActivity, runningSince: running ? Date.now() : 0 };
    const wasRunning = previous?.running;
    state.running = running;
    state.activity = session.lastActivity;
    // A new running burst restarts the clock: the stale refresh and the
    // stall budget belong to one burst, not to the chat's lifetime.
    if (!wasRunning && running) {
      state.runningSince = Date.now();
      state.lastStaleRefreshAt = 0;
    }
    // Stale running state: the inventory can silently freeze on a running
    // turn (the page navigated away, the list revalidation stopped, or the
    // provider cut the stream while the page kept spinning). One bounded
    // driver-side refresh per staleRefreshMs re-reads the turn state from
    // the provider's own API, so the next tick observes the real state and
    // the finished turn still reaches the Stop consumer.
    if (harness !== "chatgpt" && running && this.staleRefreshMs > 0 && liveHarnessPollingEnabled(harness)
      && Date.now() - state.runningSince > this.staleRefreshMs
      && Date.now() - (state.lastStaleRefreshAt ?? 0) > this.staleRefreshMs) {
      state.lastStaleRefreshAt = Date.now();
      this.saveTurns();
      await this.refreshStaleTurn(harness, session);
    }

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
    if (wasRunning !== running) this.saveTurns();
  }

  private async submitStop(harness: string, adapter: HarnessAdapter, session: AgentSession): Promise<boolean | { jobId: string }> {
    if (typeof session.cwd !== "string" || !session.cwd.startsWith("/")) return true;
    // A finished remote turn changed the conversation history. Drop the
    // adapter's cached copy for this chat BEFORE fingerprinting, so the
    // fingerprint of the new turn differs from the already-judged one even
    // when the prewarm pipeline is paused and no revision signal arrives.
    if (harness !== "chatgpt") {
      try { await adapter.invalidateHistory?.(session.id); } catch { /* cache invalidation must never block the Stop submission */ }
    }
    // The messages of the finished turn, read once: its fingerprint and its
    // chat commands come from the same read.
    let messages: ReadonlyArray<{ id?: string; role: string; text?: string }> | undefined;
    try {
      if (harness === "chatgpt") {
        const passive = adapter as HarnessAdapter & { getBackgroundMessages?: (id:string) => Promise<ReadonlyArray<{id?:string;role:string;text?:string}> | null> };
        messages = (await passive.getBackgroundMessages?.(session.id)) ?? undefined;
      } else messages = (await adapter.getSessionMessages?.(session.id, 10)) ?? undefined;
    } catch (error) {
      this.options.onError?.(`${harness} turn read failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!messages || !messages.length) {
      if (harness === "chatgpt") {
        const target = { harness, sessionId: session.id, cwd: session.cwd } as AutopilotRunnerInput;
        const passive = adapter as HarnessAdapter & { requestBackgroundVisit?: (id: string) => Promise<unknown> };
        try {
          if (!await this.options.held(harness, session.id) && await this.isEnabled(target)) {
            await passive.requestBackgroundVisit?.(session.id);
          }
        } catch (error) {
          this.options.onError?.(`ChatGPT background visit failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return false;
    }
    // The owner may talk to the herder from the chat itself: a turn whose
    // newest user message is a chat command (/pilot) is that command
    // exchange, not work. The command runs, its answer lands in the chat,
    // and the Stop of this turn is skipped — there is nothing to judge.
    if (this.options.handleTurnCommands) {
      try {
        if (await this.options.handleTurnCommands(harness, session.id, session.cwd, messages)) return true;
      } catch (error) {
        this.options.onError?.(`chat command handling failed for ${harness}/${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const fingerprint = this.fingerprintOf(messages);
    if (!fingerprint) return false;
    const input: AutopilotRunnerInput = {
      harness: harness as AutopilotRunnerInput["harness"],
      sessionId: session.id,
      cwd: session.cwd,
      turnId: `browser:${fingerprint}`,
    };
    try {
      if (await this.options.held(harness, session.id)) return true;
      if (!await this.isEnabled(input)) return true;
      const submitted = this.options.submit(input);
      if (harness === "chatgpt" && this.options.readJob && submitted && typeof submitted === "object"
        && typeof (submitted as { id?: unknown }).id === "string") return { jobId: (submitted as { id: string }).id };
      if (harness === "chatgpt" && this.options.readJob) return false;
      return true;
    } catch (error) {
      this.options.onError?.(`Autopilot browser Stop submission failed for ${harness}/${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The immutable identity of a finished turn: the fingerprint of its newest
   * messages. The messages are already read — the same read scans the chat
   * commands of the turn. */
  private fingerprintOf(messages: ReadonlyArray<{ id?: string; role: string; text?: string }>): string | undefined {
    if (!messages.length) return undefined;
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
