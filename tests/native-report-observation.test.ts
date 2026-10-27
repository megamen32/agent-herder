import { describe, expect, it } from "vitest";
import { observeNativeReport } from "../src/autopilot/background-stop.js";

const input = { harness: "codex" as const, sessionId: "qa-session", cwd: "/qa/project" };

describe("native report observation", () => {
  it("captures only the latest assistant text parts and binds identity plus native fingerprint", () => {
    const messages = [
      { id: "old", role: "assistant" as const, parts: [{ type: "text" as const, text: "Older text" }] },
      { id: "report-17", role: "assistant" as const, turnId: "turn-17", text: "includes adapter summary", parts: [
        { type: "thinking" as const, text: "private reasoning must not enter proof" },
        { type: "text" as const, text: "ALPHA-READY" },
        { type: "text" as const, text: "BETA-FINAL" },
      ] },
    ];
    const observed = observeNativeReport(input, messages, "native-fingerprint-a");
    expect(observed).toMatchObject({ status: "observed", messageId: "report-17", turnId: "turn-17", text: "ALPHA-READY\nBETA-FINAL", nativeFingerprint: "native-fingerprint-a" });
    if (observed.status !== "observed") return;
    expect(observed.text).not.toContain("private reasoning");
    expect(observeNativeReport(input, messages, "native-fingerprint-b")).toMatchObject({ status: "observed", version: expect.not.stringMatching(observed.version) });
    expect(observeNativeReport({ ...input, sessionId: "other-session" }, messages, "native-fingerprint-a")).toMatchObject({ status: "observed", version: expect.not.stringMatching(observed.version) });
  });

  it("fails closed for oversized visible text without truncating it", () => {
    const tooLarge = "x".repeat(65 * 1024);
    const observed = observeNativeReport(input, [{ id: "oversized", role: "assistant", parts: [{ type: "text", text: tooLarge }] }], "native-fingerprint");
    expect(observed).toMatchObject({ status: "unavailable", reason: expect.stringContaining("exceeds") });
    expect(JSON.stringify(observed)).not.toContain(tooLarge);
  });

  it("fails closed when an assistant message has no visible text part", () => {
    expect(observeNativeReport(input, [{ id: "thinking-only", role: "assistant", parts: [{ type: "thinking", text: "hidden" }] }], "native-fingerprint"))
      .toMatchObject({ status: "unavailable", reason: expect.stringContaining("no visible text") });
  });

  it("refuses credential-shaped report text without exposing it as proof", () => {
    const secretShaped = "Bearer " + "a".repeat(28);
    const observed = observeNativeReport(input, [{ id: "credential-shaped", role: "assistant", parts: [{ type: "text", text: secretShaped }] }], "native-fingerprint");
    expect(observed).toMatchObject({ status: "unavailable", reason: expect.stringContaining("credential-shaped") });
    expect(JSON.stringify(observed)).not.toContain(secretShaped);
  });
});
