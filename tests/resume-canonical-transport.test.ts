import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { receiptFingerprint } from "agent-resume-mcp";
import { AgentResumeClient, type ResumeTransportRequest } from "../src/resume-transport.js";
import { unwrapCanonicalResult, type CanonicalAutomationClient, type CanonicalSessionRef } from "../src/canonical-herder.js";
import { canonicalResumeKey, canonicalResumeMessage, canonicalResumePayloadHash, createCanonicalResumeTransport } from "../src/resume/canonical-transport.js";
import { readRetainedResumeReceipts } from "../src/resume/canonical-receipts.js";

// Contract seam over real sealed migration files. The authority is in-memory;
// native acceptance remains a separate real-harness gate. Expected <2s/max15s.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await fs.chmod(path.join(root, "waits"), 0o700).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); } });
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const request: ResumeTransportRequest = { target: { agent: "codex", session_id: "thread-qa", cwd: "/qa" },
  prompt: "Continue the saved task.", goal: "Saved goal", result_ref: "result://qa/1", idempotency_key: "choice:qa:1" };

async function fixture(records: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "herder-canonical-resume-")); roots.push(root); await fs.chmod(root, 0o700);
  const epoch = "test-cutover-1"; const now = new Date().toISOString();
  const privateJson = async (name: string, value: unknown, mode = 0o600) => {
    const filename = path.join(root, name); const bytes = JSON.stringify(value); await fs.writeFile(filename, bytes, { mode });
    return { path: filename, sha256: digest(bytes) };
  };
  const waits = path.join(root, "waits"); await fs.mkdir(waits, { mode: 0o500 }); const di = await fs.stat(waits);
  const waitSnapshot = await privateJson("waits-seal.json", { version: 1, kind: "herder-resume-after-retained", epoch,
    directory: waits, directory_identity: { device: String(di.dev), inode: String(di.ino) }, sealed_at: now, records: [] });
  const ledger = await privateJson("receipts.json", { version: 1, receipts: records }, 0o400); const li = await fs.stat(ledger.path);
  const receiptSnapshot = await privateJson("receipts-seal.json", { version: 1, kind: "herder-resume-receipts-retained", epoch,
    path: ledger.path, sha256: ledger.sha256, file_identity: { device: String(li.dev), inode: String(li.ino) }, sealed_at: now });
  const sources = [waits, ledger.path];
  const drain = await privateJson("drain.json", { version: 1, kind: "herder-legacy-writer-drain", epoch, platform: "linux",
    hostname: hostname(), node_ref: "qa-node", completed_at: now, sources,
    writers: [{ pid: 2147483647, boot_id: "00000000-0000-0000-0000-000000000000", start_ticks: "1",
      executable_sha256: "0".repeat(64), sources,
      observation: { observed_at: now, result: "identity_absent", provider_operation_id: "qa:drain:1", target: "qa-node", method: "fixture-previous-boot" } }] });
  const target: CanonicalSessionRef = { sessionRef: "session:qa", harness: "codex", nativeSessionId: "thread-qa", nodeRef: "qa-node", instanceRef: "qa-instance" };
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const state = { nativeEffects: 0, loseAck: false, proofAvailable: false, held: false, automatic: true,
    row: undefined as Record<string, unknown> | undefined, corruptRead: false, reads: 0 };
  const base = (key: unknown): Record<string, unknown> => ({ version: 1, complete: true, found: false,
    session_ref: target.sessionRef, request_key: key, task_ref: "mcp-delivery-task:qa",
    target: { node_ref: target.nodeRef, instance_ref: target.instanceRef, native_session_id: target.nativeSessionId },
    delivery_mode: "start", automatic_continuation: state.automatic });
  const proof = () => ({ native_id: 'ahap-receipt:v1:{"kind":"message","native_id":"msg-qa"}',
    target: { instance: { node: target.nodeRef, instance_id: target.instanceRef }, native_session_id: target.nativeSessionId } });
  const client: CanonicalAutomationClient = { mode: "canonical", epoch,
    config: { version: 1, mode: "canonical", epoch, authority: "mcp:shell:qa:AgentHerder", node_ref: "qa-node", writer_drain: drain,
      resume_after: { directory: waits, snapshot: waitSnapshot.path, sha256: waitSnapshot.sha256 },
      resume_receipts: { path: ledger.path, snapshot: receiptSnapshot.path, sha256: receiptSnapshot.sha256 } },
    async assertCurrent() {},
    async resolveNative(harness, nativeSessionId) { return { ...target, harness, nativeSessionId,
      sessionRef: nativeSessionId === target.nativeSessionId ? target.sessionRef : "session:" + nativeSessionId }; },
    async call(tool, args) {
      calls.push({ tool, args });
      if (tool === "deliver" && args.action === "receipt") {
        state.reads++;
        if (state.row && args.session_ref !== target.sessionRef) return unwrapCanonicalResult({
          isError: true, content: [], structuredContent: { code: "idempotency_conflict", effect: "none" },
        });
        const row = structuredClone(state.row ?? base(args.request_key));
        if (state.corruptRead) row.target = { node_ref: "other", instance_ref: target.instanceRef, native_session_id: target.nativeSessionId };
        return row;
      }
      if (tool === "deliver" && args.action === "session") {
        if (state.held) throw new Error("human_stop_active: effect none");
        if (!state.row) {
          state.nativeEffects++;
          state.row = { ...base(args.request_key), found: true, state: state.loseAck ? "unknown" : "confirmed",
            payload_hash: canonicalResumePayloadHash(target, "start", String(args.message)), task_status: "completed",
            native_receipt: state.loseAck ? null : proof() };
        }
        if (state.loseAck) throw new Error("ACK lost after admission");
        return { task_ref: "mcp-delivery-task:qa" };
      }
      if (tool === "compat_task" && args.action === "get") {
        expect(args.task_ref).toBe("mcp-delivery-task:qa");
        if (state.row && state.proofAvailable) Object.assign(state.row, { state: "confirmed", native_receipt: proof() });
        return { status: "completed" };
      }
      throw new Error("unexpected effect " + tool + ":" + String(args.action));
    },
  };
  return { root, client, state, calls, target, ledger: ledger.path, transport: createCanonicalResumeTransport({ client }) };
}

describe("canonical direct resume", () => {
  it("matches the Rust dispatch binding golden vector including Unicode and escaping", () => {
    const target: CanonicalSessionRef = { sessionRef: "session:qa", harness: "codex", nativeSessionId: "thread-qa", nodeRef: "qa-node", instanceRef: "qa-instance" };
    expect(canonicalResumePayloadHash(target, "start", 'Привет "QA"\nline\\path'))
      .toBe("sha256-dispatch-v1:e894ba7ab624401b386b68164016c11265b68e7493ccfc4c9e60096bcc364589");
  });
  it("stores one native effect, replays the canonical receipt, and creates no legacy ledger writes", async () => {
    const f = await fixture(); const before = await fs.readFile(f.ledger);
    const first = await f.transport.resume(request); const replay = await f.transport.resume(request);
    expect(first).toMatchObject({ status: "accepted", receipt_ref: "mcp-delivery-task:qa", idempotency_key: request.idempotency_key });
    expect(replay).toEqual(first); expect(f.state.nativeEffects).toBe(1);
    expect(f.calls.filter(c => c.args.action === "session")).toHaveLength(1);
    expect(await fs.readFile(f.ledger)).toEqual(before); expect(await fs.readdir(f.root)).not.toContain("receipts.json.lock");
  });
  it("preserves UNKNOWN after lost ACK, then reads exact native proof without another send", async () => {
    const f = await fixture(); f.state.loseAck = true;
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "ambiguous", reason: "canonical_delivery_unknown" });
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "ambiguous" });
    f.state.proofAvailable = true; f.state.held = true;
    await expect(f.transport.queryReceipt(request)).resolves.toMatchObject({ status: "accepted" });
    expect(f.state.nativeEffects).toBe(1); expect(f.calls.filter(c => c.args.action === "session")).toHaveLength(1);
  });
  it.each(["prompt", "result_ref", "goal"] as const)("binds changed %s to an idempotency conflict", async field => {
    const f = await fixture(); await f.transport.resume(request);
    await expect(f.transport.resume({ ...request, [field]: "changed" })).resolves.toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
    expect(f.state.nativeEffects).toBe(1);
  });
  it("never submits from a receipt query or trusts a different native target", async () => {
    const f = await fixture(); await expect(f.transport.queryReceipt(request)).resolves.toMatchObject({ status: "ambiguous", reason: "receipt_not_found" });
    f.state.corruptRead = true;
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "rejected", detail: "canonical_receipt_binding_invalid" });
    expect(f.state.nativeEffects).toBe(0);
  });
  it("preserves a principal-wide key when a caller changes the selected session", async () => {
    const f = await fixture(); await f.transport.resume(request);
    const changed = { ...request, target: { agent: "codex" as const, session_id: "another-thread", cwd: "/qa" } };
    await expect(f.transport.resume(changed)).resolves.toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
    expect(f.state.nativeEffects).toBe(1); expect(f.calls.filter(c => c.args.action === "session")).toHaveLength(1);
  });
  it("does not turn a bare confirmed state into acceptance", async () => {
    const f = await fixture(); await f.transport.resume(request); f.state.row!.native_receipt = null;
    await expect(f.transport.queryReceipt(request)).resolves.toMatchObject({ status: "ambiguous", reason: "canonical_native_receipt_invalid" });
    expect(f.state.nativeEffects).toBe(1);
  });
  it("refuses unsupported automatic continuation before an effect", async () => {
    const f = await fixture(); f.state.automatic = false;
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "rejected", reason: "canonical_automatic_continuation_unsupported" });
    expect(f.state.nativeEffects).toBe(0);
  });
  it("does not clear HumanStop using a supplied human timestamp", async () => {
    const f = await fixture(); f.state.held = true;
    await expect(f.transport.resume({ ...request, human_requested_at: Date.now() })).resolves.toMatchObject({ status: "ambiguous" });
    expect(f.state.nativeEffects).toBe(0); expect(f.calls.every(c => c.tool !== "humanstop")).toBe(true);
  });
  it("routes canonical mode for non-OpenCode harnesses and never invokes old ports", async () => {
    const f = await fixture(); let oldCalls = 0;
    const client = new AgentResumeClient({ env: { AGENT_HERDER_CANONICAL_MODE: "canonical" }, canonical: { client: f.client },
      coreLedgerPath: path.join(f.root, "forbidden.json"), coreTransport: { resume: async () => { oldCalls++; throw new Error("old core"); } },
      invoke: async () => { oldCalls++; }, query: async () => { oldCalls++; } });
    await expect(client.resume(request)).resolves.toMatchObject({ status: "accepted" });
    await expect(client.queryReceipt(request)).resolves.toMatchObject({ status: "accepted" });
    expect(oldCalls).toBe(0); await expect(fs.access(path.join(f.root, "forbidden.json"))).rejects.toThrow();
  });
  it("does not fall back when canonical configuration is broken", async () => {
    let fallback = 0; const client = new AgentResumeClient({ env: { AGENT_HERDER_CANONICAL_MODE: "canonical" }, invoke: async () => { fallback++; } });
    await expect(client.resume(request)).resolves.toMatchObject({ status: "rejected", detail: "canonical_config_required" });
    expect(fallback).toBe(0);
  });
  it("keeps Claude disabled in canonical mode", async () => {
    const f = await fixture(); await expect(f.transport.resume({ ...request, target: { ...request.target, agent: "claude" } as ResumeTransportRequest["target"] }))
      .resolves.toMatchObject({ status: "rejected", reason: "harness_disabled" }); expect(f.state.nativeEffects).toBe(0);
  });
});

describe("sealed legacy receipt reservation", () => {
  const old = () => ({ receipt_id: "legacy-1", receipt_ref: "legacy:receipt:1", status: "accepted", target: request.target,
    result_ref: request.result_ref, idempotency_key: request.idempotency_key,
    fingerprint: receiptFingerprint({ target: request.target as any, prompt: request.prompt!, goal: request.goal,
      resultRef: request.result_ref, idempotencyKey: request.idempotency_key! }) });
  it("returns an exact historical accepted receipt without canonical delivery", async () => {
    const f = await fixture({ [request.idempotency_key!]: old() });
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "accepted", receipt_ref: "legacy:receipt:1" });
    await expect(f.transport.resume({ ...request, prompt: "different" })).resolves.toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
    expect(f.calls).toHaveLength(0);
  });
  it("recognizes the exact retired OpenCode preflight refusal without releasing its key", async () => {
    const target = { ...request.target, agent: "opencode" as const, session_id: "ses_legacy" };
    const selected = { ...request, target };
    const row = { ...old(), target, status: "rejected", transport: "opencode-api", reason: "resume_rejected",
      error: "OpenCode v2 config has an invalid shape", executed: false, pending: false,
      admitted: false, admission_unknown: false,
      fingerprint: receiptFingerprint({ target: target as any, prompt: selected.prompt!, goal: selected.goal,
        resultRef: selected.result_ref, idempotencyKey: selected.idempotency_key! }) };
    const f = await fixture({ [selected.idempotency_key!]: row });
    const before = await fs.readFile(f.ledger);
    expect((await readRetainedResumeReceipts(f.client)).blockers).toEqual([]);
    await expect(f.transport.resume(selected)).resolves.toMatchObject({ status: "rejected", reason: "resume_rejected" });
    await expect(f.transport.resume({ ...selected, prompt: "changed" })).resolves.toMatchObject({ status: "rejected", reason: "idempotency_conflict" });
    expect(f.calls).toHaveLength(0);
    expect(await fs.readFile(f.ledger)).toEqual(before);
  });
  it.each([
    { admission_unknown: true }, { admission_unknown: undefined }, { admitted: true },
    { admissionUnknown: true }, { pending: undefined }, { executed: true },
    { error: "OpenCode connection failed (TimeoutError)" }, { transport: "unknown" },
  ])("keeps contradictory or incomplete legacy refusal evidence unresolved: %j", async changed => {
    const row = { ...old(), target: { ...request.target, agent: "opencode", session_id: "ses_legacy" },
      status: "rejected", transport: "opencode-api", error: "OpenCode v2 config has an invalid shape",
      executed: false, pending: false, admitted: false, admission_unknown: false, ...changed };
    const f = await fixture({ [request.idempotency_key!]: row });
    expect((await readRetainedResumeReceipts(f.client)).blockers).toEqual([request.idempotency_key]);
    expect(f.state.nativeEffects).toBe(0);
  });
  it("retains unknown keys and blocks new sends until they have reviewed evidence", async () => {
    const f = await fixture({ [request.idempotency_key!]: { ...old(), status: "ambiguous" } });
    await expect(f.transport.resume(request)).resolves.toMatchObject({ status: "ambiguous", reason: "retained_legacy_outcome_unknown" });
    await expect(f.transport.resume({ ...request, idempotency_key: "new-key" })).resolves.toMatchObject({ status: "rejected", reason: "canonical_legacy_receipts_unresolved" });
    expect(f.state.nativeEffects).toBe(0);
  });
  it("rejects a changed seal, writable ledger, and missing retained receipt mapping", async () => {
    const f = await fixture(); await fs.chmod(f.ledger, 0o600);
    await expect(readRetainedResumeReceipts(f.client)).rejects.toThrow("unsealed");
    await fs.writeFile(f.ledger, '{"version":1,"receipts":{"different":{}}}'); await fs.chmod(f.ledger, 0o400);
    await expect(readRetainedResumeReceipts(f.client)).rejects.toThrow("changed");
    const config = { ...f.client.config }; delete config.resume_receipts;
    await expect(readRetainedResumeReceipts({ ...f.client, config })).rejects.toThrow("required");
  });
  it("uses a namespaced bounded key while binding all selection context into the core payload", async () => {
    const f = await fixture(); const key = canonicalResumeKey("x".repeat(4096)); expect(key).toMatch(/^compat-resume:v1:[a-f0-9]{64}$/);
    const changed = { ...request, target: { ...request.target, marker: "other" } as ResumeTransportRequest["target"] };
    expect(canonicalResumePayloadHash(f.target, "start", canonicalResumeMessage(changed)))
      .not.toBe(canonicalResumePayloadHash(f.target, "start", canonicalResumeMessage(request)));
  });
});
