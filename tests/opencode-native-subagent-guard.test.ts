import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../integrations/opencode/agent-herder-autopilot.js";

const TELEGRAM_ROOT = "/home/roomhacker/PycharmProjects/TelegramAuto";
const VIDEO_ROOT = "/home/roomhacker/PycharmProjects/video_watching";

function session(id: string, directory: string, parentID?: string, model: unknown = { providerID: "minimax", id: "MiniMax-M3.1-Flash" }) {
  return { id, directory, ...(parentID ? { parentID } : {}), model };
}

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function makeContext(options: {
  sessions?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  models?: Array<{ providerID: string; id: string }>;
} = {}) {
  let permissionHook: ((event: any) => Promise<void> | void) | undefined;
  let modelHook: ((event: any) => Promise<void> | void) | undefined;
  const sessions = options.sessions || { root: session("root", TELEGRAM_ROOT) };
  const agents = options.agents || { child: { id: "child", model: { providerID: "anthropic", id: "claude-sonnet" } } };
  const models = options.models || [
    { providerID: "anthropic", id: "claude-sonnet" },
    { providerID: "minimax", id: "MiniMax-M3.1-Flash" },
    { providerID: "omniroute", id: "outer" },
    { providerID: "openai-codex", id: "codex-mini" },
  ];
  const ctx = {
    event: { subscribe: () => (async function* () {})() },
    permission: { hook: vi.fn(async (_name, callback) => { permissionHook = callback; return { dispose: vi.fn() }; }) },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] })),
      hook: vi.fn(async (_name, callback) => { modelHook = callback; return { dispose: vi.fn() }; }),
    },
    agent: { get: vi.fn(async ({ agentID }: { agentID: string }) => ({ data: agents[agentID] })) },
    model: { list: vi.fn(async () => ({ data: models })) },
  };
  return {
    ctx,
    get permissionHook() { return permissionHook!; },
    get modelHook() { return modelHook!; },
  };
}

async function setup(context: ReturnType<typeof makeContext>) {
  return (plugin as any).setup(context.ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenCode V2 restricted native child admission", () => {
  it("registers supported permission/model hooks and blocks a Claude child from a restricted descendant", async () => {
    const context = makeContext({
      sessions: {
        root: session("root", TELEGRAM_ROOT),
        childSession: session("childSession", TELEGRAM_ROOT, "root"),
      },
    });
    const cleanup = await setup(context);
    expect(context.ctx.permission.hook).toHaveBeenCalledWith("evaluate", expect.any(Function));
    expect(context.ctx.session.hook).toHaveBeenCalledWith("model.request", expect.any(Function));

    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "childSession" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    expect(decision.message).toContain("complete native provider route");
    await cleanup();
  });

  it("expands nested OmniRoute combos and denies a hidden Claude leaf", async () => {
    vi.stubEnv("OMNIROUTE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) return response({ data: [
        { id: "outer", owned_by: "combo", root: "outer", parent: null },
        { id: "inner", owned_by: "combo", root: "inner", parent: "outer" },
        { id: "claude-sonnet", owned_by: "anthropic", root: "claude-sonnet", parent: null },
      ] });
      if (url.endsWith("/model-combo-mappings")) return response({ mappings: [], total: 0 });
      if (url.endsWith("/models/alias")) return response({ aliases: [] });
      if (url.endsWith("/combos")) return response({ total: 2, combos: [
        { id: "combo-outer", name: "outer", models: [{ providerId: "combo", model: "inner" }] },
        { id: "combo-inner", name: "inner", models: [{ providerId: "anthropic", model: "claude-sonnet" }] },
      ] });
      return new Response(null, { status: 404 });
    }));
    const context = makeContext({
      agents: { child: { id: "child", model: "omniroute/outer" } },
      models: [{ providerID: "omniroute", id: "outer" }],
    });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    expect(fetch).toHaveBeenCalledTimes(4);
    await cleanup();
  });

  it("fails closed when a selected child model is missing from the native model catalog", async () => {
    const context = makeContext({
      agents: { child: { id: "child", model: "unknown-provider/model" } },
      models: [],
    });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    await cleanup();
  });

  it("allows a completely resolved safe model for a restricted project", async () => {
    const context = makeContext({ agents: { child: { id: "child", model: "minimax/MiniMax-M3.1-Flash" } } });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBeUndefined();
    await cleanup();
  });

  it("blocks a forbidden model request made by the root itself", async () => {
    const context = makeContext();
    const cleanup = await setup(context);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "openai-codex", id: "codex-mini" } }))
      .rejects.toThrow("Agent Herder blocked this model request");
    await cleanup();
  });

  it("keeps ordinary projects outside the restricted roots unchanged", async () => {
    const context = makeContext({ sessions: { ordinary: session("ordinary", "/projects/ordinary") } });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "ordinary" };
    await context.permissionHook(decision);
    expect(decision.effect).toBeUndefined();
    expect(context.ctx.agent.get).not.toHaveBeenCalled();
    await cleanup();
  });

  it("fails closed when native project lineage cannot be read", async () => {
    const context = makeContext({ sessions: {} });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "missing" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    await cleanup();
  });

  it("applies the same root restriction to the video_watching project", async () => {
    const context = makeContext({ sessions: { root: session("root", VIDEO_ROOT) } });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    await cleanup();
  });
});
