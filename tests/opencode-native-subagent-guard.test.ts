import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../integrations/opencode/agent-herder-autopilot.js";

const TELEGRAM_ROOT = "/home/roomhacker/PycharmProjects/TelegramAuto";
const VIDEO_ROOT = "/home/roomhacker/PycharmProjects/video_watching";

function session(id: string, directory: string, parentID?: string, model: unknown = { providerID: "minimax", id: "MiniMax-M3.1-Flash" }) {
  return { id, directory, ...(parentID ? { parentID } : {}), model };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installRouteProof(options: {
  nativeModelId?: string;
  leaves: Array<{ providerId: string; modelId: string }>;
  status?: number;
}) {
  vi.stubEnv("OMNIROUTE_API_KEY", "");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== "http://127.0.0.1:18787" || url.pathname !== "/api/native-model-route-proof") {
      return new Response(null, { status: 404 });
    }
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    return response({
      nativeHarness: "opencode",
      nativeModelId: options.nativeModelId ?? "omniroute/minimax-combo-m3.1",
      resolvedProviderLeaves: options.leaves,
    }, options.status ?? 200);
  }));
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

  it("denies a hidden Claude leaf returned by the local Herder route resolver", async () => {
    installRouteProof({ nativeModelId: "omniroute/outer", leaves: [
      { providerId: "anthropic", modelId: "claude-sonnet" },
    ] });
    const context = makeContext({
      agents: { child: { id: "child", model: "omniroute/outer" } },
      models: [{ providerID: "omniroute", id: "outer" }],
    });
    const cleanup = await setup(context);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it("allows the exact MiniMax combo on root model.request with unrelated active mappings and aliases", async () => {
    installRouteProof({ leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
    ] });
    const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
    const cleanup = await setup(context);
    await expect(context.modelHook({
      sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
    })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(process.env.OMNIROUTE_API_KEY).toBe("");
    await cleanup();
  });

  it.each([
    ["anthropic", "anthropic/MiniMax-M3.1-Flash"],
    ["openai-codex", "openai-codex/MiniMax-M3.1-Flash"],
  ])("denies a combo root request when its resolved leaf is forbidden (%s)", async (providerId, model) => {
    installRouteProof({ leaves: [
      { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
      { providerId, modelId: model },
    ] });
    const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
    const cleanup = await setup(context);
    await expect(context.modelHook({
      sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
    })).rejects.toThrow("Agent Herder blocked this model request");
    await cleanup();
  });

  it("fails closed when the local route proof is unavailable, mismatched, or malformed", async () => {
    for (const proof of [
      { nativeModelId: "omniroute/another-model", leaves: [{ providerId: "minimax-code", modelId: "safe" }] },
      { nativeModelId: "omniroute/minimax-combo-m3.1", leaves: [] },
      { nativeModelId: "omniroute/minimax-combo-m3.1", leaves: [
        { providerId: "minimax", modelId: "duplicate" }, { providerId: "minimax", modelId: "duplicate" },
      ] },
    ]) {
      installRouteProof(proof);
      const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
      const cleanup = await setup(context);
      await expect(context.modelHook({
        sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
      })).rejects.toThrow("Agent Herder blocked this model request");
      await cleanup();
    }
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
