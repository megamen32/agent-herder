import { expect, it, vi } from "vitest";
import { createProcessWaitGate, processWaitBlocks } from "../src/process-wait-gate.js";

it("uses the native owner at the previous scheduler fence for the exact transfer", async () => {
  const legacy = vi.fn(async () => ({ blocked: false, reason: "process_wait_unconfigured" }));
  const native = vi.fn(async () => ({ blocked: true, reason: "rust_recovery_handoff", recoveryOwner: "rust" }));
  const gate = createProcessWaitGate({ query: legacy, localRecovery: {
    nodeRef: "server-44", nativeId: "exact", decision: native,
  } });
  expect(await processWaitBlocks(gate, "codex", "exact")).toBe(true);
  expect(await processWaitBlocks(gate, "codex", "foreign")).toBe(false);
  expect(await processWaitBlocks(gate, "opencode", "exact")).toBe(false);
  expect(native).toHaveBeenCalledTimes(1);
  expect(legacy).toHaveBeenCalledTimes(2);
});

import { HostLocalRecovery, nativeHandoff } from "../src/host-local-recovery.js";

it("keeps a failed or unbound owner from claiming a session, preserves other native wait rules", async () => {
  const local = new HostLocalRecovery("exact", "server-44", {});
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

it("requires a fresh complete native ownership decision", () => {
  const now = Date.now();
  const value = { version: 1, configured: true, complete: true, mapped: false, blocked: true,
    recoveryOwner: "rust", reason: "rust_recovery_handoff", observedAt: new Date(now).toISOString(),
    sessionRefs: [], ruleRefs: [] };
  const proof = (v: Record<string, unknown>) => nativeHandoff({structuredContent: v}, now, now);
  expect(proof(value)).toEqual({ blocked: true, reason: "rust_recovery_handoff", recoveryOwner: "rust" });
  for (const malformed of [{complete:false},{configured:false},{blocked:false},{mapped:null},{version:2},
    {observedAt:new Date(now - 10000).toISOString()},{reason:null},{recoveryOwner:undefined},{ruleRefs:["ambiguous"]}]) {
    expect(proof({...value,...malformed})).toEqual({ blocked: true, reason: "native_recovery_ownership_unavailable" });
  }
  expect(nativeHandoff({isError: true, structuredContent:value},now,now).recoveryOwner).toBeUndefined();
});
