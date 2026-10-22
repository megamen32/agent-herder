import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { AutomationDisarmStore } from "../src/automation-disarm/state.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const TOKEN = "owner-disarm-secret-for-node-tests";
const cleanups: string[] = [];

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-disarm-node-"));
  cleanups.push(root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", root);
  vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", TOKEN);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** The registered tool handlers of a fleet node, without a live MCP server. */
function nodeTools(): Map<string, (request: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>> {
  const tools = new Map<string, (request: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>>();
  const server = {
    registerTool(name: string, _definition: unknown, handler: (request: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }>) {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerFleetNodeTools(server, { adapters: new Map() });
  return tools;
}

describe("the owner lever on a fleet node", () => {
  it("moves the lever for a caller that holds the secret and states an owner action", async () => {
    const tool = nodeTools().get("automation_disarm")!;
    const result = await tool({ disarmed: true, source: "owner", token: TOKEN, reason: "остановка" });
    const payload = result.structuredContent as { ok: boolean; state: { disarmed: boolean }; summary: string };
    expect(payload.ok).toBe(true);
    expect(payload.state.disarmed).toBe(true);
    expect(payload.summary).toContain("new launches forbidden (saved)");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(true);
  });

  it("is not callable without the secret", async () => {
    const tool = nodeTools().get("automation_disarm")!;
    const result = await tool({ disarmed: true, source: "owner" });
    const payload = result.structuredContent as { ok: boolean; code: string; reason: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("unauthorized");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("is not callable with a wrong secret", async () => {
    const tool = nodeTools().get("automation_disarm")!;
    const result = await tool({ disarmed: true, source: "owner", token: "not-the-owner-secret" });
    const payload = result.structuredContent as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("unauthorized");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("is not callable without an explicit owner action", async () => {
    const tool = nodeTools().get("automation_disarm")!;
    const result = await tool({ disarmed: true, token: TOKEN });
    const payload = result.structuredContent as { ok: boolean; code: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("not_owner_action");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });

  it("fails closed on a node without a configured secret", async () => {
    vi.stubEnv("AGENT_HERDER_DISARM_TOKEN", "");
    const tool = nodeTools().get("automation_disarm")!;
    const result = await tool({ disarmed: true, source: "owner", token: TOKEN });
    const payload = result.structuredContent as { ok: boolean; code: string; reason: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("disarm_token_not_configured");
    expect(payload.reason).toContain("AGENT_HERDER_DISARM_TOKEN");
    expect((await AutomationDisarmStore.forRuntime().read()).disarmed).toBe(false);
  });
});
