import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAgentActivityStatistics, withSessionPortfolioStatistics } from "../src/session-statistics.js";

const baseMs = Date.now() - 60_000;
const iso = (seconds: number) => new Date(baseMs + seconds * 1000).toISOString();

describe("session activity statistics", () => {
  it("measures tool gaps and same-path write revisits from Codex apply_patch events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-stats-"));
    const day = join(root, "2026", "09", "05");
    await mkdir(day, { recursive: true });
    const rows = [
      { timestamp: iso(0), type: "turn_context", payload: { cwd: "/repo", model: "gpt-test" } },
      { timestamp: iso(0), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" } },
      { timestamp: iso(20), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ command: "npm test" }) } },
      { timestamp: iso(60), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: ./src/a.ts\n*** End Patch" } },
      { timestamp: iso(120), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 123456 } } } },
      { timestamp: iso(180), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: /repo/src/a.ts\n*** Add File: src/b.ts\n*** End Patch" } },
    ];
    await writeFile(join(day, "session.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const stats = await computeAgentActivityStatistics(30, root);
    expect(stats.sample.sessionFiles).toBe(1);
    expect(stats.sample.patchCalls).toBe(3);
    expect(stats.sample.pathWriteEvents).toBe(4);
    expect(stats.sameFileRevisits.count).toBe(2);
    expect(stats.sameFileRevisits.percentilesSec.p50).toBeCloseTo(90, 1);
    expect(stats.sameFileRevisits.coverage.find((item) => item.seconds === 60)?.percent).toBe(50);
    expect(stats.activityGaps.count).toBe(3);
    expect(stats.source.confidence).toBe("high");
    expect(stats.schemaVersion).toBe(2);
    expect(stats.codexDeep.tokens.count).toBe(1);
    expect(stats.codexDeep.tokens.median).toBe(123456);
    expect(stats.codexDeep.durationSec.median).toBeCloseTo(180, 1);
    expect(stats.codexDeep.models[0]).toMatchObject({ name: "gpt-test", count: 1 });
  });

  it("adds cheap cross-harness portfolio statistics from the session snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-stats-"));
    const base = await computeAgentActivityStatistics(30, root);
    const now = new Date().toISOString();
    const earlier = new Date(Date.now() - 120_000).toISOString();
    const enriched = withSessionPortfolioStatistics(base, [
      { id: "c1", harness: "codex", status: "stopped", title: "c", cwd: "/repo", lastActivity: now, model: "gpt-a", needsPermission: false, meta: { total_tokens: 1000 } },
      { id: "o1", harness: "opencode", status: "idle", title: "o", cwd: "/repo", lastActivity: now, model: "model-b", needsPermission: false, meta: { createdAt: earlier, total_tokens: 3000 } },
    ] as any, 30);
    expect(enriched.portfolio?.observedSessions).toBe(2);
    expect(enriched.portfolio?.harnesses[0]).toMatchObject({ name: "codex", count: 1 });
    expect(enriched.portfolio?.tokens.mean).toBe(2000);
    expect(enriched.portfolio?.tokenCoveragePercent).toBe(100);
    expect(enriched.portfolio?.durationSec.count).toBe(1);
  });
});
