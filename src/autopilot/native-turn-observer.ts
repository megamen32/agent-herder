import { resolve } from "node:path";
import type { HarnessAdapter, HarnessEvent } from "../types/index.js";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

export interface NativeTurnAutopilotOptions {
  harness: string;
  adapter: HarnessAdapter;
  /** Cheap enablement probe; a disabled session must never create a job. */
  enabled: (input: AutopilotRunnerInput) => Promise<boolean>;
  submit: (input: AutopilotRunnerInput) => unknown;
  /** Fallback working directory when the native frame carries none. */
  resolveCwd?: (sessionId: string) => Promise<string | undefined>;
  onError?: (message: string) => void;
  /** Re-probe a session at most this often (ms). */
  statusCacheMs?: number;
}

/**
 * Native turn-end Autopilot bridge for harnesses that publish their own event
 * stream (OpenCode 2 `/api/event`).
 *
 * The v1 OpenCode plugin called the Stop hook from `session.idle`; a v2 server
 * publishes `session.execution.*` instead and no longer loads that plugin
 * contract. Herder already owns the durable Stop consumer
 * (`BackgroundAutopilotStop`), so this observer only turns a native turn end
 * into the same submission a hook would make — no judge, policy or delivery
 * logic is duplicated here.
 */
export class NativeTurnAutopilotObserver {
  private readonly cache = new Map<string, { at: number; enabled: boolean }>();
  private unsubscribe?: () => void;

  constructor(private readonly options: NativeTurnAutopilotOptions) {}

  start(): () => void {
    if (!this.options.adapter.subscribeEvents) {
      this.options.onError?.(`${this.options.harness} does not publish native events; Autopilot turn bridge is idle`);
      return () => {};
    }
    this.unsubscribe = this.options.adapter.subscribeEvents((event) => { void this.handle(event); });
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cache.clear();
  }

  private async handle(event: HarnessEvent): Promise<void> {
    if (event.kind !== "turn.completed" || !event.sessionId) return;
    const sessionId = event.sessionId;
    const directory = typeof event.data?.directory === "string"
      ? event.data.directory
      : await this.options.resolveCwd?.(sessionId);
    if (!directory || !directory.startsWith("/")) return;
    // The native event identity is stable per turn, so a reconnecting stream
    // cannot produce a second Stop for the same turn.
    const turnId = typeof event.data?.nativeEventId === "string" && event.data.nativeEventId
      ? `opencode:${event.data.nativeEventId}`
      : `turn-${Date.now()}`;
    const input: AutopilotRunnerInput = { harness: this.options.harness as AutopilotRunnerInput["harness"], sessionId, cwd: resolve(directory), turnId };
    if (!await this.isEnabled(input)) return;
    try {
      this.options.submit(input);
    } catch (error) {
      this.options.onError?.(`Autopilot Stop submission failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async isEnabled(input: AutopilotRunnerInput): Promise<boolean> {
    const key = `${input.harness}:${input.sessionId}`;
    const cached = this.cache.get(key);
    const ttl = this.options.statusCacheMs ?? 5_000;
    if (cached && Date.now() - cached.at < ttl) return cached.enabled;
    let enabled = false;
    try {
      enabled = await this.options.enabled(input);
    } catch (error) {
      this.options.onError?.(`Autopilot status probe failed for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      enabled = false;
    }
    this.cache.set(key, { at: Date.now(), enabled });
    return enabled;
  }
}