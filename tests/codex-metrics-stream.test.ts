import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/adapters/codex.js";

// Fast units: local JSONL aggregation and source-I/O errors only; no native
// model, daemon, database or delivery. Expected1s, hard maximum10s.
const readMetrics = (adapter: CodexAdapter, path: string) =>
  (adapter as unknown as { readSessionMetrics(path: string): Promise<Record<string, unknown>> }).readSessionMetrics(path);

describe("Codex streaming metrics", () => {
  it("keeps exact counts, latest usage and duration across records and a final line without newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-metrics-"));
    try {
      const path = join(root, "native.jsonl");
      const row = (type: string, payload: unknown, timestamp: string) => JSON.stringify({ type, payload, timestamp });
      await writeFile(path, [
        row("turn_context", { model: "test-model" }, "2026-10-10T00:00:00Z"),
        row("response_item", { type: "message", role: "user", content: [] }, "2026-10-10T00:00:01Z"),
        "incomplete-json", "",
        row("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 3 } } }, "2026-10-10T00:00:02Z"),
        row("response_item", { type: "message", role: "assistant", content: [] }, "2026-10-10T00:00:03Z"),
        row("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 8, input_tokens: 5, output_tokens: 3, cached_input_tokens: 2 } } }, "2026-10-10T00:00:10Z"),
      ].join("\r\n"));
      const result = await readMetrics(new CodexAdapter(), path);
      expect(result).toEqual({ model: "test-model", messageCount: 2, durationSec: 10, totalTokens: 8, inputTokens: 5, outputTokens: 3, cachedInputTokens: 2 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("closes a failed source stream and preserves the existing missing-file result", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-metrics-missing-"));
    try {
      await expect(readMetrics(new CodexAdapter(), join(root, "missing.jsonl"))).resolves.toEqual({ messageCount: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
