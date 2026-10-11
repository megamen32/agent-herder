import { runInNewContext } from "node:vm";
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
  it("clears an answer selected after the current playback moment", () => {
    const base = details("opencode");
    const html = renderSessionGraph({ ...base, session: { ...base.session, lastActivity: "2026-08-18T12:02:00.000Z" }, messages: [
      { id: "m1", role: "user", timestamp: "2026-08-18T12:00:00.000Z", text: "Start", parts: [] },
      { id: "m2", role: "assistant", timestamp: "2026-08-18T12:01:00.000Z", text: "Future answer", parts: [] },
    ] });
    const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)![1];
    const nodes = new Map<string, any>();
    const document = { getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", innerHTML: "", style: {},
        setAttribute() {}, querySelectorAll: () => [], classList: { toggle() {} } });
      return nodes.get(id);
    } };
    document.getElementById("session-data").textContent = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)![1];
    const state = runInNewContext(script + '\nshowMessage("m2"); $("time").value=0; render(); ({selectedMessage, detail:$("inspect").innerHTML, summary:$("summary").innerHTML});', { document, setInterval, clearInterval });
    expect(state.selectedMessage).toBeNull();
    expect(state.detail).not.toContain("Future answer");
    expect(state.detail).toContain("Выберите запись");
    expect(state.summary).toContain("1</b> сообщение");
    expect(state.summary).toContain("1 сессия");
    const steps = runInNewContext(script + '\n$("back").onclick(); const first=selectedTs; $("back").onclick(); const second=selectedTs; $("forward").onclick(); ({first,second,next:selectedTs,detail:$("inspect").innerHTML});', { document, setInterval, clearInterval });
    expect(steps.first).toBe(Date.parse("2026-08-18T12:01:00.000Z"));
    expect(steps.second).toBe(Date.parse("2026-08-18T12:00:00.000Z"));
    expect(steps.next).toBe(steps.first);
    expect(steps.detail).toContain("2 сообщения до выбранного момента");
  });

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

  it("renders a FROM/NOW graph and codex subagent links", () => {
    const graph = renderSessionGraph({
      ...details("codex"),
      messages: [
        { id: "m1", role: "user", timestamp: "2026-08-18T12:00:00.000Z", text: "Start", parts: [] },
        { id: "m2", role: "assistant", timestamp: "2026-08-18T12:01:01.000Z", text: "Done", parts: [] },
      ],
      children: [{ id: "child-1", harness: "codex", status: "stopped", title: "Worker", cwd: "/tmp/project", lastActivity: "2026-08-18T12:00:30.000Z", needsPermission: false, meta: { agentRole: "worker" } }],
    });
    expect(graph).toContain("НАЧАЛО");
    expect(graph).toContain("ПОСЛЕДНЕЕ НАБЛЮДЕНИЕ");
    expect(graph).toContain("duration-marker");
    expect(graph).toContain("subagent-node");
    expect(graph).toContain("codex://threads/");
    expect(graph).toContain("child-1");
  });

  it("restores the interactive message and file-change graph with playback", () => {
    const graph = renderSessionGraph({
      ...details("codex"),
      messages: [
        { id: "m1", role: "user", timestamp: "2026-08-18T12:00:00.000Z", text: "Start", parts: [] },
        {
          id: "m2",
          role: "assistant",
          timestamp: "2026-08-18T12:01:01.000Z",
          text: "Editing",
          parts: [{ type: "tool_call", name: "apply_patch", input: { command: "apply_patch src/app.ts" } }],
        },
      ],
    });
    expect(graph).toContain('id="play"');
    expect(graph).toContain('id="time"');
    expect(graph).toContain("rotate");
    expect(graph).toContain("line-mode");
    expect(graph).toContain("message-node");
    expect(graph).toContain("file-node");
    expect(graph).toContain("duration-marker");
    expect(graph).toContain("src/app.ts");
    expect(graph).toContain("subagent-node");
    expect(graph).toContain("codex://threads/");
  });
});
