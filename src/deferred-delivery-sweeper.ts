import { deferredMessages, type DeferredMessage } from "./deferred-messages.js";
import { automaticDeliveryHeld } from "./human-stop-actions.js";
import type { HarnessAdapter } from "./types/index.js";

/**
 * Deferred delivery sweeper.
 *
 * A parked deferred message used to be delivered only when the hooks runtime
 * polled `/api/coordination/context` from inside a running session, or when a
 * later explicit send piggy-backed it. With the optional hooks runtime off
 * (and for any target that is not running at all) parked messages waited
 * forever: `deferredMessages.take()` had no caller.
 *
 * This sweeper closes that gap without re-enabling hooks: every interval it
 * reads the durable deferred store and, for each target that is verifiably
 * idle (not running, not awaiting permission, not held by a manual stop, and
 * quiet for the idle grace period), delivers the parked messages through the
 * normal adapter send path with a stable `deferred-<id>` input identity.
 *
 * Safety rules inherited from the delivery doctrine:
 *  - an admitted or receipt-unknown input is never replayed: the message is
 *    removed from the store exactly like an explicit send removes it;
 *  - a refused/not-submitted delivery keeps the message parked for a later
 *    cycle (e.g. the Codex quota guard may refuse for days);
 *  - manual stops, permission prompts and busy targets are never touched;
 *  - the idle grace period keeps the sweeper away from sessions that just
 *    finished, so an in-flight delivery job still wins the race.
 *
 * Configuration (environment):
 *  - AGENT_HERDER_DEFERRED_SWEEP_INTERVAL_MS (default 30000, 0 disables)
 *  - AGENT_HERDER_DEFERRED_SWEEP_IDLE_GRACE_MS (default 60000)
 *  - AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE (default 8)
 *  - AGENT_HERDER_DEFERRED_SWEEP_HARNESSES (default "opencode,codex")
 */
export interface DeferredSweepOutcome {
  delivered: number;
  kept: number;
  skipped: number;
}

const DEFAULT_SWEEP_HARNESSES = ["opencode", "codex"];

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class DeferredDeliverySweeper {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private readonly harnesses: ReadonlySet<string>;
  private readonly intervalMs: number;
  private readonly idleGraceMs: number;
  private readonly maxSessionsPerCycle: number;

  constructor(private readonly adapters: Map<string, HarnessAdapter>) {
    const configured = (process.env.AGENT_HERDER_DEFERRED_SWEEP_HARNESSES ?? DEFAULT_SWEEP_HARNESSES.join(","))
      .split(",").map(value => value.trim()).filter(Boolean);
    this.harnesses = new Set(configured.length ? configured : DEFAULT_SWEEP_HARNESSES);
    this.intervalMs = parseEnvInt("AGENT_HERDER_DEFERRED_SWEEP_INTERVAL_MS", 30_000);
    this.idleGraceMs = parseEnvInt("AGENT_HERDER_DEFERRED_SWEEP_IDLE_GRACE_MS", 60_000);
    this.maxSessionsPerCycle = parseEnvInt("AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE", 8);
  }

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** The adapter of one parked session. Legacy parks made before the harness
   * tag existed are never swept: waking sessions with weeks-old automatic
   * handoffs is a decision for the owner, not a background reconciliation. */
  private async adapterFor(message: DeferredMessage): Promise<HarnessAdapter | undefined> {
    if (!message.harness) return undefined;
    const adapter = this.adapters.get(message.harness);
    return adapter?.getSession ? adapter : undefined;
  }

  async sweep(now = Date.now()): Promise<DeferredSweepOutcome> {
    const outcome: DeferredSweepOutcome = { delivered: 0, kept: 0, skipped: 0 };
    if (this.sweeping) return outcome;
    this.sweeping = true;
    try {
      const parked = await deferredMessages.listAll();
      if (!parked.length) return outcome;
      const bySession = new Map<string, DeferredMessage[]>();
      for (const message of parked) {
        const list = bySession.get(message.sessionId) ?? [];
        list.push(message);
        bySession.set(message.sessionId, list);
      }
      let budget = this.maxSessionsPerCycle;
      for (const [sessionId, messages] of bySession) {
        messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const adapter = await this.adapterFor(messages[0]!);
        // Ineligible sessions (legacy parks without a harness tag) never
        // consume the cycle budget: hundreds of them would otherwise starve
        // every eligible park behind them forever.
        if (!adapter || !this.harnesses.has(adapter.type)) { outcome.skipped += messages.length; continue; }
        if (budget <= 0) break;
        budget--;
        let session;
        try { session = await adapter.getSession(sessionId); } catch { session = null; }
        if (!session || session.id !== sessionId || session.harness !== adapter.type) { outcome.skipped += messages.length; continue; }
        if (session.status === "running" || session.status === "needs_input" || session.needsPermission) { outcome.skipped += messages.length; continue; }
        if (await automaticDeliveryHeld(session, false, adapter)) { outcome.skipped += messages.length; continue; }
        const lastActivity = Date.parse(session.lastActivity ?? "");
        if (Number.isFinite(lastActivity) && now - lastActivity < this.idleGraceMs) { outcome.skipped += messages.length; continue; }
        for (const message of messages) {
          let receipt;
          try {
            receipt = await adapter.sendMessage(sessionId, {
              message: message.message, queue: true, origin: "automation", inputId: `deferred-${message.id}`,
            });
          } catch (error) {
            console.error(`[agent-herder] deferred sweep could not address ${adapter.type}:${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            outcome.kept++;
            continue;
          }
          // Admitted or receipt-unknown inputs are never replayed; a refusal
          // keeps the message parked for a later cycle.
          if (receipt.ok || receipt.admitted === true || receipt.admissionUnknown === true) {
            await deferredMessages.remove([message.id]).catch(() => undefined);
            outcome.delivered++;
          } else {
            outcome.kept++;
          }
        }
      }
      return outcome;
    } finally {
      this.sweeping = false;
    }
  }
}
