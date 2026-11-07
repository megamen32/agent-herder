import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

const MIN_INTERVAL_MS = 300_000;
type State = { version: 1; nextAt: number; strikes: number; last429: string; seen429?: string[] };

/** Persistent budget for browser actions that may make the site issue requests.
 * The caller reserves before acting, including on uncertain action outcomes. */
export class ChatGptBackgroundBudget {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  private read(): State | null {
    try {
      const state = JSON.parse(readFileSync(this.path, "utf8")) as State;
      if (state.version !== 1 || !Number.isFinite(state.nextAt) || state.nextAt < 0
        || !Number.isInteger(state.strikes) || state.strikes < 0 || typeof state.last429 !== "string"
        || (state.seen429 !== undefined && (!Array.isArray(state.seen429) || state.seen429.length > 512
          || state.seen429.some(id => typeof id !== "string" || !id || id.length > 256)))) return null;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextAt: 0, strikes: 0, last429: "" };
      return null;
    }
  }

  private write(state: State): boolean {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
      return true;
    } catch {
      try { unlinkSync(temporary); } catch { /* no temporary file */ }
      return false;
    }
  }

  reserve(): boolean {
    const state = this.read(); const now = this.now();
    if (!state || !Number.isFinite(now) || now < state.nextAt) return false;
    return this.write({ ...state, nextAt: now + MIN_INTERVAL_MS });
  }

  observe429(id: string, retryUntil: number): boolean {
    const state = this.read(); const now = this.now();
    if (!state || !id || id.length > 256 || !Number.isFinite(now)) return false;
    const seen = state.seen429 ?? (state.last429 ? [state.last429] : []);
    if (seen.includes(id)) return true;
    const strikes = Math.min(10, state.strikes + 1);
    const serverUntil = Number.isFinite(retryUntil) ? retryUntil : 0;
    return this.write({ ...state, strikes, last429: id, seen429: [...seen, id].slice(-512),
      nextAt: Math.max(state.nextAt, serverUntil, now + MIN_INTERVAL_MS * 2 ** (strikes - 1)) });
  }
}
