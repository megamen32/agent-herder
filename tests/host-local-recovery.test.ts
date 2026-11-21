import { hostname } from "node:os";
import { expect, it, vi } from "vitest";
import { configuredLocalRecovery, HostLocalRecovery, nativeHandoff } from "../src/host-local-recovery.js";
import { createProcessWaitGate, processWaitBlocks, type ProcessWaitDecision } from "../src/process-wait-gate.js";

it("uses the native owner at the previous scheduler fence for the exact transfer", async () => {
  const legacy = vi.fn(async () => ({ blocked: false, reason: "process_wait_unconfigured" }));
  const native = vi.fn(async (): Promise<ProcessWaitDecision> => ({ blocked: true, reason: "rust_recovery_handoff", recoveryOwner: "rust" }));
  const gate = createProcessWaitGate({ query: legacy, localRecovery: {
    nodeRef: "server-44", scope: { nativeId: "exact" }, decision: native,
  } });
  expect(await processWaitBlocks(gate, "codex", "exact")).toBe(true);
  expect(await processWaitBlocks(gate, "codex", "foreign")).toBe(false);
  expect(await processWaitBlocks(gate, "opencode", "exact")).toBe(false);
  expect(native).toHaveBeenCalledTimes(1);
  expect(legacy).toHaveBeenCalledTimes(2);
});

it("keeps a failed or unbound owner from claiming a session, preserves other native wait rules", async () => {
  const local = new HostLocalRecovery({ nativeId: "exact" }, "server-44", {});
  const legacy = vi.fn(async ({nativeSessionId}) => ({
    blocked: nativeSessionId === "previously-held", reason: "legacy-decision",
  }));
  const gate = createProcessWaitGate({ query: legacy, localRecovery: local });
  const target = {harness: "codex", nativeSessionId: "exact", nodeRef: "server-44"};
  expect(await gate.decision(target)).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  expect(await gate.decision({...target, nodeRef: "other"})).toEqual({ blocked: false, reason: "legacy-decision" });
  local.start();
  expect(await gate.decision(target)).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  expect(await gate.blocks("opencode", "exact")).toBe(false);
  expect(await gate.blocks("codex", "previously-held")).toBe(true);
  expect(legacy).toHaveBeenCalledTimes(3);
  await local.close();
});

it("hands existing and newly encountered Codex IDs on this instance to the same Rust owner", async () => {
  const legacy = vi.fn(async () => ({ blocked: false, reason: "process_wait_unconfigured" }));
  const native = vi.fn(async (id: string): Promise<ProcessWaitDecision | undefined> => {
    if (id === "absent") return undefined;
    if (id === "unreadable") throw new Error("owner unavailable");
    return { blocked: true, recoveryOwner: "rust", reason: id === "stopped" ? "native_recovery_held" : "rust_recovery_handoff" };
  });
  const gate = createProcessWaitGate({ localRecovery: { nodeRef: "fixture-node", scope: "instance", decision: native }, query: legacy });
  for (const id of ["existing", "brand-new"]) {
    expect(await gate.decision({ harness: "codex", nativeSessionId: id, nodeRef: "fixture-node" }))
      .toEqual({ blocked: true, reason: "rust_recovery_handoff", recoveryOwner: "rust" });
  }
  expect((await gate.decision({ harness: "codex", nativeSessionId: "stopped" })).reason).toBe("native_recovery_held");
  expect(await gate.decision({ harness: "codex", nativeSessionId: "unreadable" }))
    .toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  expect(await gate.blocks("codex", "absent")).toBe(false);
  expect(await gate.blocks("opencode", "brand-new")).toBe(false);
  expect((await gate.decision({ harness: "codex", nativeSessionId: "brand-new", nodeRef: "other" })).blocked).toBe(false);
  expect(native.mock.calls.map(([id]) => id)).toEqual(["existing", "brand-new", "stopped", "unreadable", "absent"]);
  expect(legacy).toHaveBeenCalledTimes(3);
});

it("requires a fresh complete native ownership decision", () => {
  const now = Date.now();
  const value = { version: 1, configured: true, complete: true, mapped: false, blocked: true,
    recoveryOwner: "rust", reason: "rust_recovery_handoff", observedAt: new Date(now).toISOString(),
    sessionRefs: [], ruleRefs: [] };
  const proof = (v: Record<string, unknown>) => nativeHandoff({structuredContent: v}, now, now, "instance");
  expect(proof(value)).toEqual({ blocked: true, reason: "rust_recovery_handoff", recoveryOwner: "rust" });
  for (const malformed of [{complete:false},{configured:false},{blocked:false},{mapped:null},{version:2},
    {observedAt:new Date(now - 10000).toISOString()},{reason:null},{recoveryOwner:undefined},{ruleRefs:["ambiguous"]}]) {
    expect(proof({...value,...malformed})).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  }
  expect(nativeHandoff({isError: true, structuredContent:value},now,now,"instance")?.recoveryOwner).toBeUndefined();
});

it("falls through only for a fresh definitive absence on the whole instance", () => {
  const now = Date.now();
  const absent = { version: 1, configured: true, complete: true, mapped: false, blocked: false,
    reason: "native_session_not_registered", observedAt: new Date(now).toISOString(), sessionRefs: [], ruleRefs: [] };
  const read = (changes: Record<string, unknown>, scope: "instance" | { nativeId: string } = "instance") =>
    nativeHandoff({ structuredContent: { ...absent, ...changes } }, now, now, scope);
  expect(read({})).toBeUndefined();
  for (const change of [{ complete: false }, { configured: false }, { mapped: true }, { blocked: true },
    { recoveryOwner: "rust" }, { reason: "native_recovery_ownership_unavailable" }, { ruleRefs: ["wait"] }]) {
    expect(read(change)).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  }
  expect(read({}, { nativeId: "exact" })).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
});

it("requires an explicit exclusive scope and defers an invalid binding", async () => {
  const wide = { AGENT_HERDER_LOCAL_RECOVERY_INSTANCE_WIDE: "true" };
  const exact = { AGENT_HERDER_LOCAL_RECOVERY_NATIVE_ID: "exact" };
  expect(configuredLocalRecovery({})).toBeUndefined();
  expect(configuredLocalRecovery(exact)?.scope).toEqual({ nativeId: "exact" });
  expect(configuredLocalRecovery(wide)?.scope).toBe("instance");
  for (const env of [{ ...exact, ...wide }, { AGENT_HERDER_LOCAL_RECOVERY_INSTANCE_WIDE: "false" },
    { AGENT_HERDER_LOCAL_RECOVERY_NATIVE_ID: "" }]) {
    const owner = configuredLocalRecovery(env)!;
    expect(owner.scope).toBe("invalid");
    const legacy = vi.fn();
    const gate = createProcessWaitGate({ localRecovery: owner, query: legacy });
    expect((await gate.decision({ harness: "codex", nativeSessionId: "new" })).reason).toBe("native_recovery_ownership_unavailable");
    expect(legacy).not.toHaveBeenCalled();
  }
});

it("defers a local request when the configured node is wrong", async () => {
  const local = configuredLocalRecovery({ AGENT_HERDER_LOCAL_RECOVERY_INSTANCE_WIDE: "true",
    AGENT_HERDER_LOCAL_RECOVERY_NODE: "different-node" })!;
  const legacy = vi.fn(async () => ({ blocked: false, reason: "legacy" }));
  const gate = createProcessWaitGate({ localRecovery: local, query: legacy });
  local.start();
  try {
    const target = { harness: "codex", nativeSessionId: "new", nodeRef: hostname() };
    expect(await gate.decision(target)).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
    expect(await gate.decision({ ...target, nodeRef: "different-node" })).toEqual({ blocked: false, reason: "legacy" });
  } finally { await local.close(); }
});
