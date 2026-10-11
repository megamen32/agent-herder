import { normalize } from "node:path";

import type { ChoiceRegistry, PendingChoice } from "./choice-registry.js";
import type { HumanRequestRecord, HumanRequestRegistry } from "../human-request/registry.js";

export interface PendingQuestionSources {
  humanRequests?: Pick<HumanRequestRegistry, "list">;
  choices?: Pick<ChoiceRegistry, "list">;
}

export interface PendingQuestionGateOptions {
  /** How long a loaded snapshot is trusted before the registries are read again. */
  ttlMs?: number;
  /** Bound on the pending choice records inspected per refresh. */
  pendingChoiceLimit?: number;
}

/** A question blocks work only while it is unanswered; an applied answer must continue. */
const BLOCKING_CHOICE_STATUSES = new Set<PendingChoice["status"]>(["pending"]);
const DEFAULT_TTL_MS = 15_000;
const DEFAULT_PENDING_CHOICE_LIMIT = 200;

/**
 * Durable answer-pending gate over the existing registries.
 *
 * A pending Human Request or a pending Autopilot choice means the exact native
 * session is waiting for a human. Reconcile and Autopilot must not continue
 * such a session, and a stale native status must not talk them past the
 * question. The gate only reads existing registries; it stores no new state
 * and never pauses any other session.
 */
export class PendingQuestionGate {
  private snapshot: Map<string, Set<string>> | undefined;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private inFlight?: Promise<Map<string, Set<string>>>;

  constructor(
    private readonly sources: PendingQuestionSources,
    private readonly options: PendingQuestionGateOptions = {},
  ) {}

  /** True while a human answer is still pending for this exact session. */
  async blocks(harness: string, sessionId: string, cwd?: string): Promise<boolean> {
    if (!this.sources.humanRequests && !this.sources.choices) return false;
    const snapshot = await this.load();
    const candidates = snapshot.get(sessionKey(harness, sessionId));
    if (!candidates || candidates.size === 0) return false;
    if (candidates.has("")) return true;
    if (!cwd) return false;
    const normalizedCwd = normalizeWorkspace(cwd);
    for (const candidate of candidates) {
      if (candidate === "" || normalizeWorkspace(candidate) === normalizedCwd) return true;
    }
    return false;
  }

  /** Sorted session keys currently waiting for a human answer. */
  async pendingKeys(): Promise<string[]> {
    return [...(await this.load()).keys()].sort();
  }

  /** Force the next read to hit the registries. */
  invalidate(): void {
    this.loadedAt = Number.NEGATIVE_INFINITY;
    this.snapshot = undefined;
  }

  private async load(): Promise<Map<string, Set<string>>> {
    const ttlMs = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.snapshot && Date.now() - this.loadedAt < ttlMs) return this.snapshot;
    this.inFlight ??= this.refresh().finally(() => { this.inFlight = undefined; });
    const loaded = await this.inFlight;
    this.snapshot = loaded;
    this.loadedAt = Date.now();
    return loaded;
  }

  private async refresh(): Promise<Map<string, Set<string>>> {
    const index = new Map<string, Set<string>>();
    const add = (harness: string | undefined, sessionId: string, cwd: string | undefined): void => {
      if (!sessionId) return;
      const key = sessionKey(harness ?? "codex", sessionId);
      const workspaces = index.get(key) ?? new Set<string>();
      workspaces.add(cwd ? normalizeWorkspace(cwd) : "");
      index.set(key, workspaces);
    };
    const humanRequests = this.sources.humanRequests;
    if (humanRequests) {
      for (const record of (await humanRequests.list("pending")) as HumanRequestRecord[]) {
        add(record.target.agent ?? record.target.harness, record.target.sessionId, record.target.cwd);
      }
    }
    const choices = this.sources.choices;
    if (choices) {
      // Filter by status before the bound is applied: a long-lived registry holds
      // hundreds of later terminal records, and an unanswered question can be
      // older than every one of them.
      const limit = this.options.pendingChoiceLimit ?? DEFAULT_PENDING_CHOICE_LIMIT;
      for (const status of BLOCKING_CHOICE_STATUSES) {
        for (const choice of await choices.list({ status, limit })) {
          add(choice.harness, choice.sessionId, choice.cwd);
        }
      }
    }
    return index;
  }
}

function sessionKey(harness: string, sessionId: string): string {
  return `${harness}\u0000${sessionId}`;
}

function normalizeWorkspace(cwd: string): string {
  try {
    const normalized = normalize(cwd);
    return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return cwd;
  }
}