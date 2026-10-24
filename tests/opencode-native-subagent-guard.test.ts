import { afterEach, describe, expect, it, vi } from "vitest";

const TELEGRAM_ROOT = "/home/roomhacker/PycharmProjects/TelegramAuto";
const VIDEO_ROOT = "/home/roomhacker/PycharmProjects/video_watching";

/**
 * The state of the switch of the owner, as the panel leaves it.
 *
 * Every test names the state it runs under: the guard must answer the same
 * way whatever the live service of the node happens to answer, and the
 * contract of the owner says which of the three states may change the answer.
 */
type SwitchState = "enabled" | "disabled" | "unavailable";

const SWITCH_STATES: readonly SwitchState[] = ["enabled", "disabled", "unavailable"];

/** The proof of the route, as the local service of the Herder answers it. */
interface RouteProof {
  nativeModelId?: string;
  leaves?: Array<{ providerId: string; modelId: string }>;
  status?: number;
  malformed?: boolean;
}

function session(id: string, directory: string, parentID?: string, model: unknown = { providerID: "minimax", id: "MiniMax-M3.1-Flash" }) {
  return { id, directory, ...(parentID ? { parentID } : {}), model };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The network of the guard: the switch of the owner and the proof of the route.
 *
 * The two answers are stubbed apart, so a test can name the state of the
 * switch and the state of the proof without touching the live service.
 */
function installNetwork(options: { switch?: SwitchState; proof?: RouteProof; endpoint?: string } = {}) {
  const state = options.switch ?? "enabled";
  vi.stubEnv("OMNIROUTE_API_KEY", "");
  if (options.endpoint) vi.stubEnv("AGENT_HERDER_URL", options.endpoint);
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/hooks/prohibitions") {
      if (state === "unavailable") throw new Error("the service of the panel does not answer");
      return response({ ok: true, known: true, prohibitionsEnabled: state !== "disabled" });
    }
    if (url.pathname === "/api/native-model-route-proof") {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (options.proof?.status) return new Response(null, { status: options.proof.status });
      if (options.proof?.malformed) return response({ thisIsNotAProof: true });
      return response({
        nativeHarness: "opencode",
        nativeModelId: options.proof?.nativeModelId ?? "omniroute/minimax-combo-m3.1",
        resolvedProviderLeaves: options.proof?.leaves ?? [],
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The guard, loaded fresh.
 *
 * The guard remembers the state of the switch for two seconds, so a test that
 * names its own state must start with an empty memory of the guard.
 */
async function loadGuard() {
  vi.resetModules();
  const module = await import("../integrations/opencode/agent-herder-autopilot.js");
  return (module as any).default as { setup: (ctx: unknown) => Promise<() => Promise<void>> };
}

function makeContext(options: {
  sessions?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  models?: Array<{ providerID: string; id: string; modelID?: string }>;
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenCode V2 restricted native child admission", () => {
  it("registers supported permission/model hooks and blocks a Claude child from a restricted descendant", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state });
      const context = makeContext({
        sessions: {
          root: session("root", TELEGRAM_ROOT),
          childSession: session("childSession", TELEGRAM_ROOT, "root"),
        },
      });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      expect(context.ctx.permission.hook).toHaveBeenCalledWith("evaluate", expect.any(Function));
      expect(context.ctx.session.hook).toHaveBeenCalledWith("model.request", expect.any(Function));

      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "childSession" };
      await context.permissionHook(decision);
      expect(decision.effect).toBe("deny");
      // The closed provider is named apart from a route that is merely forbidden.
      expect(decision.message).toContain("closed by the rule of the owner");
      expect(decision.message).not.toContain("complete native provider route");
      await cleanup();
    }
  });

  it("denies a hidden Claude leaf returned by the local Herder route resolver", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({
        switch: state,
        proof: { nativeModelId: "omniroute/outer", leaves: [{ providerId: "anthropic", modelId: "claude-sonnet" }] },
      });
      const context = makeContext({
        agents: { child: { id: "child", model: "omniroute/outer" } },
        models: [{ providerID: "omniroute", id: "outer" }],
      });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
      await context.permissionHook(decision);
      expect(decision.effect).toBe("deny");
      expect(decision.message).toContain("closed by the rule of the owner");
      await cleanup();
    }
  });

  it("refuses a leaf that is not confirmed while the prohibitions are on, and lets it pass when the owner switches them off", async () => {
    // The model is not in the native catalog: the leaf is not confirmed.
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state });
      const context = makeContext({
        agents: { child: { id: "child", model: "unknown-provider/model" } },
        models: [],
      });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
      await context.permissionHook(decision);
      if (state === "disabled") {
        // The owner switched the prohibitions off: the work of the session continues.
        expect(decision.effect).toBeUndefined();
      } else {
        // The prohibitions are on, and the service of the panel does not
        // answer: the state of the switch is "the prohibitions are on".
        expect(decision.effect).toBe("deny");
        expect(decision.message).toContain("complete native provider route");
        expect(decision.message).not.toContain("closed by the rule of the owner");
      }
      await cleanup();
    }
  });

  it("allows a completely resolved safe model for a restricted project", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state });
      const context = makeContext({ agents: { child: { id: "child", model: "minimax/MiniMax-M3.1-Flash" } } });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
      await context.permissionHook(decision);
      expect(decision.effect).toBeUndefined();
      await cleanup();
    }
  });

  it("blocks a forbidden model request made by the root itself", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state });
      const context = makeContext();
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      await expect(context.modelHook({ sessionID: "root", model: { providerID: "openai-codex", id: "codex-mini" } }))
        .rejects.toThrow("the provider of this route is closed by the rule of the owner");
      await cleanup();
    }
  });

  it("allows the exact MiniMax combo on root model.request with unrelated active mappings and aliases", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({
        switch: state,
        proof: { leaves: [
          { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
          { providerId: "minimax", modelId: "minimax/MiniMax-M3.1-Flash" },
        ] },
      });
      const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      await expect(context.modelHook({
        sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
      })).resolves.toBeUndefined();
      expect(process.env.OMNIROUTE_API_KEY).toBe("");
      await cleanup();
    }
  });

  it("asks the route proof about the provider-facing model id of the catalog entry", async () => {
    installNetwork({
      switch: "enabled",
      proof: {
        nativeModelId: "omniroute/minimax-combo-m3",
        leaves: [
          { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3" },
          { providerId: "minimax", modelId: "minimax/MiniMax-M3" },
        ],
      },
    });
    const context = makeContext({
      models: [{ providerID: "omniroute", id: "minimax/MiniMax-M3", modelID: "minimax-combo-m3" }],
    });
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({
      sessionID: "root", model: { providerID: "omniroute", id: "minimax/MiniMax-M3" },
    })).resolves.toBeUndefined();
    const [input] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(new URL(String(input)).searchParams.get("modelId")).toBe("omniroute/minimax-combo-m3");
    await cleanup();
  });

  it("uses the configured Agent Herder endpoint without forwarding credentials", async () => {
    installNetwork({
      switch: "enabled",
      endpoint: "http://127.0.0.1:19876",
      proof: { leaves: [{ providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" }] },
    });
    const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({
      sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
    })).resolves.toBeUndefined();
    const [input, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(new URL(String(input)).origin).toBe("http://127.0.0.1:19876");
    expect(new URL(String(input)).pathname).toBe("/api/native-model-route-proof");
    expect(new Headers((init as RequestInit).headers).has("authorization")).toBe(false);
    await cleanup();
  });

  it.each([
    ["anthropic", "anthropic/MiniMax-M3.1-Flash"],
    ["openai-codex", "openai-codex/MiniMax-M3.1-Flash"],
  ])("denies a combo root request when its resolved leaf is forbidden (%s)", async (providerId, model) => {
    for (const state of SWITCH_STATES) {
      installNetwork({
        switch: state,
        proof: { leaves: [
          { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
          { providerId, modelId: model },
        ] },
      });
      const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      await expect(context.modelHook({
        sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
      })).rejects.toThrow("the provider of this route is closed by the rule of the owner");
      await cleanup();
    }
  });

  it("refuses a broken local route proof whatever the switch of the owner says", async () => {
    // A broken proof is a broken integrity, not a prohibition: the switch of
    // the owner does not repair it.
    const brokenProofs: RouteProof[] = [
      { status: 503 },
      { malformed: true },
      { nativeModelId: "omniroute/another-model", leaves: [{ providerId: "minimax-code", modelId: "safe" }] },
      { nativeModelId: "omniroute/minimax-combo-m3.1", leaves: [] },
      { nativeModelId: "omniroute/minimax-combo-m3.1", leaves: [
        { providerId: "minimax", modelId: "duplicate" }, { providerId: "minimax", modelId: "duplicate" },
      ] },
    ];
    for (const state of SWITCH_STATES) {
      for (const proof of brokenProofs) {
        installNetwork({ switch: state, proof });
        const context = makeContext({ models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }] });
        const guard = await loadGuard();
        const cleanup = await guard.setup(context.ctx);
        await expect(context.modelHook({
          sessionID: "root", model: { providerID: "omniroute", id: "minimax-combo-m3.1" },
        })).rejects.toThrow("the complete native provider route is forbidden");
        await cleanup();
      }
    }
  });

  it("refuses a child of a restricted project when the local route proof is broken, whatever the switch says", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state, proof: { status: 503 } });
      const context = makeContext({
        agents: { child: { id: "child", model: "omniroute/minimax-combo-m3.1" } },
        models: [{ providerID: "omniroute", id: "minimax-combo-m3.1" }],
      });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
      await context.permissionHook(decision);
      expect(decision.effect).toBe("deny");
      expect(decision.message).toContain("complete native provider route");
      expect(decision.message).not.toContain("closed by the rule of the owner");
      await cleanup();
    }
  });

  it("names the closed provider apart from the forbidden route", async () => {
    installNetwork({ switch: "enabled" });
    const context = makeContext();
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    const closed = await context.modelHook({ sessionID: "root", model: { providerID: "anthropic", id: "claude-sonnet" } })
      .then(() => undefined, (error: Error) => error.message);
    const forbidden = await context.modelHook({ sessionID: "root", model: { providerID: "opencode", id: "gpt-6.1-sol" } })
      .then(() => undefined, (error: Error) => error.message);
    expect(closed).toContain("closed by the rule of the owner");
    expect(closed).not.toContain("complete native provider route");
    expect(forbidden).toContain("complete native provider route");
    expect(forbidden).not.toContain("closed by the rule of the owner");
    expect(closed).not.toBe(forbidden);
    await cleanup();
  });

  it("keeps ordinary projects outside the restricted roots unchanged", async () => {
    installNetwork({ switch: "enabled" });
    const context = makeContext({ sessions: { ordinary: session("ordinary", "/projects/ordinary") } });
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "ordinary" };
    await context.permissionHook(decision);
    expect(decision.effect).toBeUndefined();
    expect(context.ctx.agent.get).not.toHaveBeenCalled();
    await cleanup();
  });

  it("fails closed when native project lineage cannot be read", async () => {
    for (const state of SWITCH_STATES) {
      installNetwork({ switch: state });
      const context = makeContext({ sessions: {} });
      const guard = await loadGuard();
      const cleanup = await guard.setup(context.ctx);
      const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "missing" };
      await context.permissionHook(decision);
      expect(decision.effect).toBe("deny");
      await cleanup();
    }
  });

  it("applies the same root restriction to the video_watching project", async () => {
    installNetwork({ switch: "enabled" });
    const context = makeContext({ sessions: { root: session("root", VIDEO_ROOT) } });
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    const decision: Record<string, unknown> = { action: "subagent", resources: ["child"], sessionID: "root" };
    await context.permissionHook(decision);
    expect(decision.effect).toBe("deny");
    await cleanup();
  });
});
