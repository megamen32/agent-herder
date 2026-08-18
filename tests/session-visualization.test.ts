import { describe, expect, it } from "vitest";
import { renderSessionGraph } from "../src/session-visualization.js";
import type { SessionDetails } from "../src/types/index.js";

function details(harness: SessionDetails["session"]["harness"]): SessionDetails {
  return {
    session: { id: `${harness}-1`, harness, status: "stopped", title: `${harness} session`, cwd: "/tmp/project", lastActivity: "2026-08-18T12:00:00.000Z", needsPermission: false },
    lineage: { kind: "root" },
    children: [],
    messages: [{ id: "m1", role: "user", text: "Inspect", parts: [{ type: "text", text: "Inspect" }] }],
    history: { source: "acp-load", complete: false },
  };
}

describe("canonical session visualization", () => {
  it.each(["opencode", "claude", "codex", "hermes", "zcode", "fast-agent"] as const)("renders %s without a harness-specific reader", (harness) => {
    const html = renderSessionGraph(details(harness));
    expect(html).toContain("agent-herder-session-graph/v1");
    expect(html).toContain(`"harness":"${harness}"`);
    expect(html).toContain("CANONICAL Agent Herder SessionDetails");
    expect(html).toContain("Inspect");
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("renders a top-to-bottom FROM/NOW timeline and codex subagent links", () => {
    const graph = renderSessionGraph({
      ...details("codex"),
      messages: [
        { id: "m1", role: "user", timestamp: "2026-08-18T12:00:00.000Z", text: "Start", parts: [] },
        { id: "m2", role: "assistant", timestamp: "2026-08-18T12:01:01.000Z", text: "Done", parts: [] },
      ],
      children: [{ id: "child-1", harness: "codex", status: "stopped", title: "Worker", cwd: "/tmp/project", lastActivity: "2026-08-18T12:00:30.000Z", needsPermission: false, meta: { agentRole: "worker" } }],
    });
    expect(graph).toContain("FROM");
    expect(graph).toContain("NOW");
    expect(graph).toContain("duration-text");
    expect(graph).toContain("SESSION / SUBAGENTS");
    expect(graph).toContain("subagent-node");
    expect(graph).toContain("codex://threads/");
    expect(graph).toContain("child-1");
  });
});
