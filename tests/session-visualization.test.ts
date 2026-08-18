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
  });
});
