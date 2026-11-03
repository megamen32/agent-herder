import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatCommandPipeline, parseChatCommand } from "./chat-commands.js";

describe("parseChatCommand", () => {
  it("recognizes the plain word and the explicit forms", () => {
    expect(parseChatCommand("/pilot")).toEqual({ kind: "pilot", action: "toggle" });
    expect(parseChatCommand("  /pilot on ")).toEqual({ kind: "pilot", action: "on" });
    expect(parseChatCommand("/Pilot OFF")).toEqual({ kind: "pilot", action: "off" });
    expect(parseChatCommand("/автопилот вкл")).toEqual({ kind: "pilot", action: "on" });
    expect(parseChatCommand("/autopilot выкл")).toEqual({ kind: "pilot", action: "off" });
    expect(parseChatCommand("/pilot статус")).toEqual({ kind: "pilot", action: "status" });
    expect(parseChatCommand("/pilot status?")).toEqual({ kind: "pilot", action: "status" });
  });

  it("leaves normal messages and unknown arguments alone", () => {
    expect(parseChatCommand("/pilot сделай то-то")).toBeNull();
    expect(parseChatCommand("продолжи работу")).toBeNull();
    expect(parseChatCommand("проверь /pilot в тексте")).toBeNull();
    expect(parseChatCommand("")).toBeNull();
    expect(parseChatCommand("   ")).toBeNull();
  });
});

function makePipeline(
  run: (input: { command: string }) => Promise<Record<string, unknown>>,
  ledgerPath: string,
  notify?: (input: { harness: string; sessionId: string; action: "on" | "off"; enabled: boolean; reply: string }) => void,
) {
  const reply = vi.fn(async (_harness: string, _sessionId: string, _text: string, _inputId?: string) => ({ ok: true }));
  const pipeline = new ChatCommandPipeline({
    run: run as never,
    reply,
    ledgerPath,
    onError: () => undefined,
    ...(notify ? { notify } : {}),
  });
  return { pipeline, reply };
}

describe("ChatCommandPipeline", () => {
  it("toggles a disabled session on and answers in the chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async (input: { command: string }) =>
        input.command === "status"
          ? { ok: true, enabled: false, source: "session" }
          : { ok: true, enabled: true, source: "session" });
      const { pipeline, reply } = makePipeline(run, join(dir, "ledger.json"));
      const outcome = await pipeline.handleDirect({ kind: "pilot", action: "toggle" }, "zai", "s1", "/w");
      expect(outcome.ok).toBe(true);
      expect(outcome.enabled).toBe(true);
      expect(outcome.reply).toContain("включён");
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0]![0]).toBe("zai");
      expect(reply.mock.calls[0]![1]).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a held human stop instead of pretending the autopilot is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async () => ({ ok: true, enabled: false, human_stop_held: true }));
      const { pipeline, reply } = makePipeline(run, join(dir, "ledger.json"));
      const outcome = await pipeline.handleDirect({ kind: "pilot", action: "on" }, "chatgpt", "s2", "/w");
      expect(outcome.ok).toBe(true);
      expect(outcome.enabled).toBe(false);
      expect(outcome.humanStopHeld).toBe(true);
      expect(outcome.reply).toContain("явная остановка человека");
      expect(reply).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes a command turn once: the ledger stops the re-read of the same message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async (input: { command: string }) =>
        input.command === "status"
          ? { ok: true, enabled: false }
          : { ok: true, enabled: true });
      const { pipeline, reply } = makePipeline(run, join(dir, "ledger.json"));
      const messages = [
        { id: "u1", role: "user", text: "/pilot on" },
        { id: "a1", role: "assistant", text: "готово" },
      ];
      await expect(pipeline.handleTurnMessages("zai", "s3", "/w", messages)).resolves.toBe(true);
      await expect(pipeline.handleTurnMessages("zai", "s3", "/w", messages)).resolves.toBe(false);
      expect(reply).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a turn whose newest user message is not a command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async () => ({ ok: true, enabled: false }));
      const { pipeline, reply } = makePipeline(run, join(dir, "ledger.json"));
      const messages = [
        { id: "u1", role: "user", text: "/pilot" },
        { id: "a1", role: "assistant", text: "готово" },
        { id: "u2", role: "user", text: "теперь просто работай" },
        { id: "a2", role: "assistant", text: "ок" },
      ];
      await expect(pipeline.handleTurnMessages("zai", "s4", "/w", messages)).resolves.toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a command message without an id: no honest dedupe, no toggle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async () => ({ ok: true, enabled: false }));
      const { pipeline } = makePipeline(run, join(dir, "ledger.json"));
      const messages = [{ role: "user", text: "/pilot on" }];
      await expect(pipeline.handleTurnMessages("zai", "s5", "/w", messages)).resolves.toBe(false);
      expect(run).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires a push notification on a real state change (on/off/toggle) but not on status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async (input: { command: string }) =>
        input.command === "status"
          ? { ok: true, enabled: false, source: "session" }
          : { ok: true, enabled: input.command === "on", source: "session" });
      const notify = vi.fn(async () => undefined);
      const { pipeline } = makePipeline(run, join(dir, "ledger.json"), notify);

      // toggle: disabled -> enabled, fires notify with action derived from the
      // resulting state (action "on" because the toggle turned it on).
      const toggleOutcome = await pipeline.handleDirect({ kind: "pilot", action: "toggle" }, "chatgpt", "6ae91a92", "/w");
      expect(toggleOutcome.enabled).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        harness: "chatgpt",
        sessionId: "6ae91a92",
        action: "on",
        enabled: true,
      }));
      const toggleArg = (notify.mock.calls[0] as unknown as Array<Record<string, unknown>>)[0];
      expect(typeof toggleArg?.reply === "string" && (toggleArg.reply as string).includes("включён")).toBe(true);

      // explicit off: notify fires again with action "off" and enabled=false.
      notify.mockClear();
      const offOutcome = await pipeline.handleDirect({ kind: "pilot", action: "off" }, "chatgpt", "6ae91a92", "/w");
      expect(offOutcome.enabled).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({
        harness: "chatgpt",
        sessionId: "6ae91a92",
        action: "off",
        enabled: false,
      }));

      // status: read-only query, notify must NOT fire.
      notify.mockClear();
      await pipeline.handleDirect({ kind: "pilot", action: "status" }, "chatgpt", "6ae91a92", "/w");
      expect(notify).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swallows a notify error so the chat reply still lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatcmds-"));
    try {
      const run = vi.fn(async (input: { command: string }) =>
        input.command === "status"
          ? { ok: true, enabled: false, source: "session" }
          : { ok: true, enabled: true, source: "session" });
      const notify = vi.fn(async () => { throw new Error("network down"); });
      const onError = vi.fn();
      const reply = vi.fn(async () => ({ ok: true }));
      const pipeline = new ChatCommandPipeline({
        run: run as never,
        reply,
        ledgerPath: join(dir, "ledger.json"),
        onError,
        notify,
      });
      const outcome = await pipeline.handleDirect({ kind: "pilot", action: "on" }, "zai", "s7", "/w");
      // The toggle itself succeeded even though the push failed.
      expect(outcome.ok).toBe(true);
      expect(outcome.enabled).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]![0]).toContain("chat command push notify failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
