import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { createAutopilotCore, loadReceiptStore, persistReceiptStore, type JudgeClient } from "../autopilot/index.js";
import { acquireLock } from "../autopilot-hook.js";
import { AutopilotSessionStore, type NoticeAttempt } from "../autopilot/session-store.js";
import { parseNoticeIncident, type NoticeIncidentBinding } from "../autopilot/notice-incident.js";
import type { HerderJobRegistry } from "../herder-jobs.js";

export const V1_NOTICEPLACE_ROUTE = { provider: "minimax-coding-plan", model: "MiniMax-M3.1-Flash" } as const;
const MODEL = `${V1_NOTICEPLACE_ROUTE.provider}/${V1_NOTICEPLACE_ROUTE.model}`;

/** Supplied by the existing event stream, never synthesized from a timer. */
export type V1Completion = { sessionRef: string; nativeSessionId: string; turnId: string };
export type V1AutopilotSessionRow = {
  session_ref: string;
  address: { native_session_id: string; [key: string]: unknown };
  native: { harness: string; cwd: string } | null;
};
/** Fresh, complete authoritative read through the shared Rust session port. */
export type V1AutopilotSnapshot = {
  sessionRef: string; nativeSessionId: string; cwd: string;
  status: "idle" | "running" | "needs_input" | "stopped" | "error";
  humanStopHeld: boolean; turnId: string; revision: string; model: string;
  messages: Array<{ role: string; text?: string }>;
};
export type V1AutopilotRustPort = {
  /** Existing sessions(list) output, scoped to the configured OpenCode instance. */
  listSessions(): Promise<V1AutopilotSessionRow[]>;
  /** No adapter reads/stale fallback; HumanStop/status unknown must fail closed. */
  snapshot(sessionRef: string): Promise<V1AutopilotSnapshot>;
  /** Rust enforces its own HumanStop/admission; UNKNOWN must never be resent. */
  deliver(input: {
    sessionRef: string; nativeSessionId: string; message: string; requestKey: string;
    model: string; expectedRevision: string; turnId: string;
  }): Promise<unknown>;
};
type Registration = { isActive(): boolean; close(): void };
type CoreOptions = Parameters<typeof createAutopilotCore>[0];
export type V1NoticePlaceAutopilotPorts = {
  store: AutopilotSessionStore;
  /** Must have persistencePath; durableOnce pins UNKNOWN/completed events across restart. */
  jobs: HerderJobRegistry;
  stateDir: string;
  rust: V1AutopilotRustPort;
  /** Register against the existing native completion stream, not a new poller. */
  registerCompletion(sessionRef: string, callback: (event: V1Completion) => Promise<unknown>): Promise<Registration>;
  /** Reuse the configured existing judge client; no credential/env mutation here. */
  createJudge(route: typeof V1_NOTICEPLACE_ROUTE): JudgeClient;
  core: Pick<CoreOptions, "notify" | "deliverHumanQuestion" | "humanRequests" | "choiceRegistry" | "notification" | "maxContinuationsPerSession">
    & { incidentUpdates: NonNullable<CoreOptions["incidentUpdates"]>; pendingQuestions: NonNullable<CoreOptions["pendingQuestions"]> };
};
export type V1AutopilotArm = {
  sessionRef: string; enabled: boolean; noticeIncident?: NoticeIncidentBinding; noticeAttempt?: NoticeAttempt;
};

/**
 * Thin event consumer for the V1 facade. The existing semantic core decides;
 * the existing jobs ledger owns no-replay; every native read/write uses Rust.
 * Store keys remain exact native IDs for existing incident/judge consumers.
 * Call restore() once after wiring the event stream; no loop is created here.
 */
export class V1NoticePlaceAutopilot {
  private readonly registrations = new Map<string, { nativeId: string; value: Registration }>();
  constructor(private readonly ports: V1NoticePlaceAutopilotPorts) {}

  private async row(sessionRef: string) {
    if (!sessionRef?.trim()) throw new Error("invalid_session_ref");
    const matches = (await this.ports.rust.listSessions()).filter(row => row.session_ref === sessionRef);
    if (matches.length !== 1) throw new Error("exact_rust_session_unavailable");
    const row = matches[0]!;
    if (!row.address?.native_session_id?.trim() || row.native?.harness !== "opencode" || !isAbsolute(row.native.cwd)) {
      throw new Error("exact_native_identity_unavailable");
    }
    return row as V1AutopilotSessionRow & { native: { harness: "opencode"; cwd: string } };
  }

  async get(sessionRef: string) {
    const row = await this.row(sessionRef);
    const record = await this.ports.store.get("opencode", row.address.native_session_id);
    const subscription = this.registrations.get(sessionRef);
    const snapshot = await this.ports.rust.snapshot(sessionRef);
    this.validateSnapshot(snapshot, row);
    const enabled = record?.enabled === true;
    return { sessionId: sessionRef, sessionRef, nativeSessionId: row.address.native_session_id, harness: "opencode" as const,
      enabled, armed: enabled && record.cwd === row.native.cwd && subscription?.nativeId === row.address.native_session_id
        && subscription.value.isActive() && !snapshot.humanStopHeld,
      humanStopHeld: snapshot.humanStopHeld, status: snapshot.status,
      noticeIncident: record?.noticeIncident, noticeAttempt: record?.noticeAttempt };
  }

  async arm(input: V1AutopilotArm) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled_must_be_boolean");
    const row = await this.row(input.sessionRef);
    const nativeId = row.address.native_session_id;
    const target = { harness: "opencode" as const, sessionId: nativeId, cwd: row.native.cwd,
      ...(input.noticeIncident ? { noticeIncident: input.noticeIncident } : {}),
      ...(input.noticeAttempt ? { noticeAttempt: input.noticeAttempt } : {}) };
    if (!input.enabled) {
      await this.ports.store.set(target, false);
      this.registrations.get(input.sessionRef)?.value.close();
      this.registrations.delete(input.sessionRef);
      return this.get(input.sessionRef);
    }
    if (!this.ports.jobs.supportsDurableOnce()) throw new Error("durable_jobs_required");
    if (!this.ports.core.incidentUpdates || !this.ports.core.pendingQuestions) throw new Error("incident_runtime_ports_required");
    const previous = await this.ports.store.get("opencode", nativeId);
    parseNoticeIncident(input.noticeIncident ?? previous?.noticeIncident);
    const snapshot = await this.ports.rust.snapshot(input.sessionRef);
    this.validateSnapshot(snapshot, row);
    if (snapshot.humanStopHeld || snapshot.status === "stopped") throw new Error("human_stop_held");
    let subscription = this.registrations.get(input.sessionRef);
    let created = false;
    if (!subscription || subscription.nativeId !== nativeId || !subscription.value.isActive()) {
      subscription?.value.close();
      this.registrations.delete(input.sessionRef);
      const value = await this.ports.registerCompletion(input.sessionRef, event => {
        if (event.sessionRef !== input.sessionRef) return Promise.reject(new Error("callback_session_mismatch"));
        return this.reconcile(event);
      });
      if (!value?.isActive()) { value?.close(); throw new Error("completion_callback_unavailable"); }
      subscription = { nativeId, value }; created = true;
    }
    try {
      await this.ports.store.set(target, true);
      if (!subscription.value.isActive()) throw new Error("completion_callback_unavailable");
      this.registrations.set(input.sessionRef, subscription);
      return await this.get(input.sessionRef);
    } catch (error) {
      if (created) subscription.value.close();
      throw error;
    }
  }

  /** Reattach durable enabled native records after the facade/runtime restarts. */
  async restore() {
    const restored = [];
    for (const row of await this.ports.rust.listSessions()) {
      if (row.native?.harness !== "opencode") continue;
      const record = await this.ports.store.get("opencode", row.address.native_session_id);
      if (record?.enabled && record.noticeIncident && record.cwd === row.native.cwd) {
        restored.push(await this.arm({ sessionRef: row.session_ref, enabled: true }));
      }
    }
    return restored;
  }

  async reconcile(event: V1Completion) {
    const row = await this.row(event.sessionRef);
    if (row.address.native_session_id !== event.nativeSessionId) throw new Error("native_identity_mismatch");
    if (!event.turnId?.trim()) throw new Error("native_turn_required");
    const key = `v1-notice-auto:${createHash("sha256").update(JSON.stringify([event.sessionRef, event.nativeSessionId, event.turnId])).digest("hex")}`;
    return this.ports.jobs.start({ kind: "Продолжение исправления NoticePlace", ownerSessionId: event.nativeSessionId,
      idempotencyKey: key, requestFingerprint: key, durableOnce: true,
      run: async ({ signal }) => {
        const file = join(this.ports.stateDir, `v1-notice-${createHash("sha256").update(event.nativeSessionId).digest("hex")}`);
        const release = await acquireLock(`${file}.lock`, { waitMs: 0, staleMs: 10 * 60_000 });
        if (!release) return { decision: "session_busy" };
        try {
          const before = await this.ports.rust.snapshot(event.sessionRef);
          this.validateSnapshot(before, row);
          const record = await this.ports.store.get("opencode", event.nativeSessionId);
          const subscription = this.registrations.get(event.sessionRef);
          if (!record?.enabled || !record.noticeIncident || record.cwd !== before.cwd
            || !subscription?.value.isActive() || subscription.nativeId !== event.nativeSessionId
            || before.status !== "idle" || before.humanStopHeld || signal.aborted || before.turnId !== event.turnId) return { decision: "held_or_stale" };
          if (before.model !== MODEL) return { decision: "unsupported_model_route" };
          const fence = async () => {
            if (signal.aborted || !subscription.value.isActive()) return false;
            if (await this.ports.core.pendingQuestions.blocks("opencode", event.nativeSessionId, before.cwd)) return false;
            const latest = await this.row(event.sessionRef);
            if (JSON.stringify(latest.address) !== JSON.stringify(row.address)) return false;
            const current = await this.ports.rust.snapshot(event.sessionRef);
            this.validateSnapshot(current, latest);
            const saved = await this.ports.store.get("opencode", event.nativeSessionId);
            return saved?.enabled === true && saved.cwd === before.cwd && saved.updatedAt === record.updatedAt
              && JSON.stringify(saved.noticeAttempt) === JSON.stringify(record.noticeAttempt)
              && current.status === "idle" && !current.humanStopHeld && JSON.stringify(current) === JSON.stringify(before);
          };
          const receipts = await loadReceiptStore(`${file}.json`);
          const judge = this.ports.createJudge(V1_NOTICEPLACE_ROUTE);
          const core = createAutopilotCore({ ...this.ports.core,
            judge: { decide: async input => {
              if (!await fence()) throw new Error("continuation_fenced");
              const decision = await judge.decide(input);
              if (!await fence()) throw new Error("continuation_fenced");
              return decision;
            } },
            allowSessions: new Set([event.nativeSessionId]), receiptStore: receipts, harness: "opencode",
            noticeIncident: record.noticeIncident, checkpointReceipts: () => persistReceiptStore(`${file}.json`, receipts) });
          const result = await core.handleStop({ hook_event_name: "Stop", harness: "opencode", session_id: event.nativeSessionId,
            cwd: before.cwd, turn_id: event.turnId, model: before.model, transcript_path: null, stop_hook_active: false,
            last_user_message: before.messages.filter(m => m.role === "user").at(-1)?.text ?? null,
            last_assistant_message: before.messages.filter(m => m.role === "assistant").at(-1)?.text ?? null });
          await persistReceiptStore(`${file}.json`, receipts);
          if (!("decision" in result) || result.decision !== "block") return { decision: "terminal_or_pending" };
          if (!await fence()) return { decision: "held_or_stale" };
          const delivery = await this.ports.rust.deliver({ sessionRef: event.sessionRef, nativeSessionId: event.nativeSessionId,
            message: result.reason, requestKey: key, model: MODEL, expectedRevision: before.revision, turnId: event.turnId });
          return { decision: "continue", delivery };
        } catch { throw new Error("v1_notice_autopilot_unavailable_or_unknown"); }
        finally { await release(); }
      } });
  }

  private validateSnapshot(snapshot: V1AutopilotSnapshot, row: V1AutopilotSessionRow) {
    if (snapshot.sessionRef !== row.session_ref || snapshot.nativeSessionId !== row.address.native_session_id
      || snapshot.cwd !== row.native?.cwd || typeof snapshot.humanStopHeld !== "boolean" || !snapshot.revision
      || !Array.isArray(snapshot.messages)) throw new Error("authoritative_snapshot_mismatch");
  }
}
