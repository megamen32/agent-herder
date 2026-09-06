import type { HarnessEventSourceHealth } from "./types/index.js";

export class HarnessEventHealthRegistry {
  private readonly entries = new Map<string, HarnessEventSourceHealth>();

  setMode(harness: string, mode: HarnessEventSourceHealth["mode"]): void {
    const current = this.entries.get(harness);
    this.entries.set(harness, current ? { ...current, mode } : { mode, connected: mode === "polling", reconnects: 0 });
  }

  connected(harness: string): void {
    const current = this.entries.get(harness) ?? { mode: "native" as const, connected: false, reconnects: 0 };
    this.entries.set(harness, {
      ...current,
      mode: "native",
      connected: true,
      reconnects: current.connected ? current.reconnects : current.reconnects + (current.lastEventAt ? 1 : 0),
      lastEventAt: new Date().toISOString(),
      lastError: undefined,
    });
  }

  event(harness: string, at = new Date().toISOString()): void {
    const current = this.entries.get(harness) ?? { mode: "native" as const, connected: true, reconnects: 0 };
    this.entries.set(harness, { ...current, mode: "native", connected: true, lastEventAt: at, lastError: undefined });
  }

  disconnected(harness: string, error?: string): void {
    const current = this.entries.get(harness) ?? { mode: "native" as const, connected: false, reconnects: 0 };
    this.entries.set(harness, { ...current, mode: "native", connected: false, ...(error ? { lastError: error } : {}) });
  }

  get(harness: string): HarnessEventSourceHealth {
    return { ...(this.entries.get(harness) ?? { mode: "polling", connected: true, reconnects: 0 }) };
  }

  list(): Array<{ harness: string } & HarnessEventSourceHealth> {
    return [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([harness, health]) => ({ harness, ...health }));
  }
}

export const harnessEventHealth = new HarnessEventHealthRegistry();
