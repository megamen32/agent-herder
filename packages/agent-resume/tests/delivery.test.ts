import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReceiptLedger } from "../src/resume/receipts.js";
import { buildResumeCommand, resolveBoundTarget, resumeBoundTarget } from "../src/resume/delivery.js";

// Focused unit: bound delivery through the durable ledger.
// Expected <1s/max 15s. No provider, harness or native session; the launcher is
// injected, so nothing is spawned.
function deps(state: { launches: number; fail?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "herder-delivery-"));
  return {
    ledger: new ReceiptLedger({ path: join(dir, "state", "receipts.json") }),
    logDir: join(dir, "runs"),
    launch: async (command: string[], options: { cwd: string; logFile: string }) => {
      state.launches++;
      if (state.fail) return { returncode: 1, stdout: "", stderr: "launch refused", pid: null };
      return { returncode: 0, stdout: "4242\n", stderr: "", pid: 4242 };
    },
  };
}

const target = { agent: "claude", session_id: "ses_abc", cwd: "/tmp" };

it("refuses a target that is not complete and complete at once", () => {
  expect(() => resolveBoundTarget({ agent: "claude", cwd: "/tmp" })).toThrow(/session_id is required/);
  expect(() => resolveBoundTarget({ agent: "claude", session_id: "s" })).toThrow(/cwd is required/);
  expect(() => resolveBoundTarget({ agent: "claude", session_id: "s", cwd: "relative" })).toThrow(/absolute/);
  expect(() => resolveBoundTarget({ agent: "claude", harness: "codex", session_id: "s", cwd: "/tmp" })).toThrow(/aliases must agree/);
  expect(() => resolveBoundTarget({ agent: "claude", session_id: "a", threadId: "b", cwd: "/tmp" })).toThrow(/session aliases must agree/);
  expect(() => resolveBoundTarget({ agent: "claude", session_id: "s", cwd: "/tmp", use_last: true })).toThrow(/use_last/);
  expect(() => resolveBoundTarget({ agent: "nope", session_id: "s", cwd: "/tmp" })).toThrow(/unsupported/);
  expect(resolveBoundTarget({ agent: "claude", sessionId: "ses_abc", cwd: "/tmp" })).toMatchObject({ agent: "claude", session_id: "ses_abc" });
});

it("builds the harness command for a bound session", () => {
  const claude = resolveBoundTarget({ agent: "claude", session_id: "ses_abc", cwd: "/tmp" });
  expect(buildResumeCommand(claude, "дальше")).toEqual(["claude", "--print", "--resume", "ses_abc", "дальше"]);
  const codex = resolveBoundTarget({ agent: "codex", session_id: "th_1", cwd: "/tmp", model: "gpt-6.1-sol" });
  expect(buildResumeCommand(codex, "дальше")).toEqual(["codex", "exec", "resume", "--model", "gpt-6.1-sol", "th_1", "дальше"]);
  const opencode = resolveBoundTarget({ agent: "opencode", session_id: "ses_1", cwd: "/tmp" });
  expect(buildResumeCommand(opencode, "дальше")).toEqual(["opencode", "run", "--session", "ses_1", "--", "дальше"]);
  expect(() => buildResumeCommand(claude, "x", { useLast: true })).toThrow(/unsafe/);
});

it("delivers once and replays the receipt for the same key", async () => {
  const state = { launches: 0 };
  const context = deps(state);
  const first = await resumeBoundTarget({ target, prompt: "дальше", resultRef: "result://1", idempotencyKey: "k1" }, context);
  const replay = await resumeBoundTarget({ target, prompt: "дальше", resultRef: "result://1", idempotencyKey: "k1" }, context);

  expect(first.status).toBe("accepted");
  expect(first.pid).toBe(4242);
  expect(replay.receipt_id).toBe(first.receipt_id);
  expect(state.launches).toBe(1);
});

it("records a rejected launch and never retries it for the same key", async () => {
  const state = { launches: 0, fail: true };
  const context = deps(state);
  const failed = await resumeBoundTarget({ target, prompt: "дальше", resultRef: "result://1", idempotencyKey: "k2" }, context);
  const replay = await resumeBoundTarget({ target, prompt: "дальше", resultRef: "result://1", idempotencyKey: "k2" }, context);
  expect(failed).toMatchObject({ status: "failed", reason: "launch_failed" });
  expect(replay).toMatchObject({ status: "failed", reason: "launch_failed" });
  expect(state.launches).toBe(1);
});

it("prepares without launching when execution is not requested", async () => {
  const state = { launches: 0 };
  const context = deps(state);
  const receipt = await resumeBoundTarget({ target, prompt: "дальше", resultRef: "result://1", idempotencyKey: "k3", execute: false }, context);
  expect(receipt).toMatchObject({ status: "accepted", reason: "prepared", executed: false });
  expect(state.launches).toBe(0);
});

it("rejects an invalid request with a receipt, not an exception", async () => {
  const state = { launches: 0 };
  const context = deps(state);
  const missingRef = await resumeBoundTarget({ target, prompt: "дальше", idempotencyKey: "k4" }, context);
  const missingPrompt = await resumeBoundTarget({ target, resultRef: "result://1", idempotencyKey: "k5" }, context);
  const missingTarget = await resumeBoundTarget({ prompt: "дальше", resultRef: "result://1", idempotencyKey: "k6" } as never, context);
  expect(missingRef).toMatchObject({ status: "rejected", reason: "invalid_request" });
  expect(missingPrompt).toMatchObject({ status: "rejected", reason: "invalid_request" });
  expect(missingTarget).toMatchObject({ status: "rejected", reason: "invalid_request" });
  expect(state.launches).toBe(0);
});

it("gives an OpenCode target to the native client instead of a CLI process", async () => {
  const state = { launches: 0 };
  const context = deps(state);
  const sent: Array<{ id: string; delivery: string }> = [];
  const nativeClient = { send: async (id: string, request: { delivery: string }) => { sent.push({ id, delivery: request.delivery }); return { ok: true, admitted: true }; } };
  const receipt = await resumeBoundTarget({
    target: { agent: "opencode", session_id: "ses_native", cwd: "/tmp" },
    prompt: "дальше", resultRef: "result://1", idempotencyKey: "k7",
  }, { ...context, nativeClient: nativeClient as never });

  expect(receipt).toMatchObject({ status: "accepted", executed: true });
  expect(sent).toEqual([{ id: "ses_native", delivery: "queue" }]);
  expect(state.launches).toBe(0);
});

it("treats a refused native admission for OpenCode as terminal, not a CLI retry", async () => {
  const state = { launches: 0 };
  const context = deps(state);
  const nativeClient = { send: async () => ({ ok: false, error: "HTTP 409" }) };
  const receipt = await resumeBoundTarget({
    target: { agent: "opencode", session_id: "ses_native", cwd: "/tmp" },
    prompt: "дальше", resultRef: "result://1", idempotencyKey: "k8",
  }, { ...context, nativeClient: nativeClient as never });
  // The standalone CLI answers "Session not found" for an OpenCode 2 session, so
  // a second, blind attempt would only produce a misleading error.
  expect(receipt).toMatchObject({ status: "failed", reason: "native_admission_refused", executed: true });
  expect(state.launches).toBe(0);
});