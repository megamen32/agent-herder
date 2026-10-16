import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReceiptLedger } from "agent-resume-mcp";
import { coreCanDeliver, createCoreResumeTransport, defaultResumeLedgerPath } from "../src/resume/core-transport.js";

// Focused unit: Herder's in-process admission over the shared core.
// Expected <1s/max 15s. No provider, harness or spawned process: delivery is
// refused or answered from the ledger, never executed against a real session.
function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "herder-core-transport-")), "state", "receipts.json");
}

it("defaults to the same ledger the previous Agent Resume service wrote", () => {
  expect(defaultResumeLedgerPath({})).toMatch(/\.local\/state\/agent-resume\/receipts\.json$/);
  expect(defaultResumeLedgerPath({ AGENT_RESUME_STATE_DIR: "/tmp/somewhere" })).toBe("/tmp/somewhere/receipts.json");
});

it("admits natively only where the core can reach the target", () => {
  const opencode = { agent: "opencode" as const, session_id: "ses_1", cwd: "/tmp" };
  const codex = { agent: "codex" as const, session_id: "th_1", cwd: "/tmp" };
  expect(coreCanDeliver(opencode, "http://127.0.0.1:4095")).toBe(true);
  expect(coreCanDeliver(opencode, undefined)).toBe(false);
  expect(coreCanDeliver(codex, "http://127.0.0.1:4095")).toBe(false);
});

it("replays a receipt the core stored, without touching the harness", async () => {
  const path = tempLedger();
  const target = { agent: "opencode" as const, session_id: "ses_1", cwd: "/tmp" };
  const request = { target, result_ref: "result://1", goal: "дальше", prompt: "дальше", idempotency_key: "k1" };
  const first = await createCoreResumeTransport({ ledgerPath: path, opencodeUrl: "http://127.0.0.1:1" }).resume(request);
  // Point 1 is closed, so the core records a refusal rather than pretending.
  expect(first.status).not.toBe("accepted");

  const ledger = new ReceiptLedger({ path });
  const stored = ledger.read("k1");
  expect(stored?.status).toBe(first.status);

  // A second identical request reads the stored answer back.
  const replay = await createCoreResumeTransport({ ledgerPath: path, opencodeUrl: "http://127.0.0.1:1" }).resume(request);
  expect(replay.status).toBe(first.status);
});

it("refuses a request without an idempotency key instead of risking a double delivery", async () => {
  const transport = createCoreResumeTransport({ ledgerPath: tempLedger(), opencodeUrl: "http://127.0.0.1:4095" });
  const receipt = await transport.resume({ target: { agent: "opencode", session_id: "ses_1", cwd: "/tmp" }, result_ref: "result://1", goal: "дальше" });
  expect(receipt).toMatchObject({ status: "rejected", reason: "idempotency_key_required" });
});

it("declines a target it cannot deliver natively", async () => {
  const transport = createCoreResumeTransport({ ledgerPath: tempLedger(), opencodeUrl: "http://127.0.0.1:4095" });
  const receipt = await transport.resume({
    target: { agent: "claude", session_id: "ses_1", cwd: "/tmp" },
    result_ref: "result://1", goal: "дальше", idempotency_key: "k2",
  });
  expect(receipt).toMatchObject({ status: "failed", reason: "unsupported" });
});