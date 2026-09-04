import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAgentActivityStatistics } from "../src/session-statistics.js";

const iso = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000).toISOString();

describe("session activity statistics", () => {
  it("measures tool gaps and same-path write revisits from Codex apply_patch events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-stats-"));
    const day = join(root, "2026", "09", "05");
    await mkdir(day, { recursive: true });
    const rows = [
      { timestamp: iso(0), type: "turn_context", payload: { cwd: "/repo" } },
      { timestamp: iso(0), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" } },
      { timestamp: iso(20), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ command: "npm test" }) } },
      { timestamp: iso(60), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: ./src/a.ts\n*** End Patch" } },
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
  });
});
