import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEAF_LAUNCH_POLICY,
  LEAF_LAUNCH_REFUSAL_MESSAGES,
  isClosedProviderLeaf,
  isLeafAllowedByOwnerRule,
  leafLaunchVerdict,
  type ProviderLeaf,
} from "../src/model-launch-policy.js";
import {
  openCodeLeafLaunchVerdict,
  openCodeRouteLeaf,
  openCodeRouteVerdict,
} from "../packages/agent-resume/src/harness/opencode/client.js";
import {
  POLICY_BLOCK_BEGIN,
  POLICY_BLOCK_END,
  driftedArtifacts,
} from "../scripts/generate-leaf-launch-policy.mjs";

const PLUGIN_PATH = new URL("../integrations/opencode/agent-herder-autopilot.js", import.meta.url);
const LAUNCHER_PATH = new URL("../src/autopilot/unfinished-session-launcher.ts", import.meta.url);
const pluginSource = readFileSync(PLUGIN_PATH, "utf8");
const launcherSource = readFileSync(LAUNCHER_PATH, "utf8");

/** The copy of the rule inside the guard, taken from the guard itself. */
function pluginRule() {
  const begin = pluginSource.indexOf(POLICY_BLOCK_BEGIN);
  const end = pluginSource.indexOf(POLICY_BLOCK_END);
  expect(begin, "the guard must keep the generated copy of the rule").toBeGreaterThan(-1);
  expect(end, "the guard must keep the generated copy of the rule").toBeGreaterThan(begin);
  const code = pluginSource.slice(begin + POLICY_BLOCK_BEGIN.length, end);
  const factory = new Function(`${code}
    return { isClosedProviderLeaf, isLeafAllowedByOwnerRule, leafLaunchVerdict, LEAF_LAUNCH_REFUSAL_MESSAGES };`) as () => {
      isClosedProviderLeaf: (leaf: ProviderLeaf) => boolean;
      isLeafAllowedByOwnerRule: (leaf: ProviderLeaf) => boolean;
      leafLaunchVerdict: (leaf: ProviderLeaf, options: { prohibitionsEnabled: boolean }) => string;
      LEAF_LAUNCH_REFUSAL_MESSAGES: typeof LEAF_LAUNCH_REFUSAL_MESSAGES;
    };
  return factory();
}

const LEAVES: ProviderLeaf[] = [
  { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
  { providerId: "minimax", modelId: "minimax/MiniMax-M3" },
  { providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash" },
  { providerId: "zai", modelId: "glm-5.3-flash" },
  { providerId: "zai-coding-plan", modelId: "glm-5.3-flash" },
  { providerId: "zhipu", modelId: "glm-4.6" },
  { providerId: "opencode", modelId: "gpt-6.1-sol" },
  { providerId: "opencode", modelId: "glm-5.3" },
  { providerId: "openai", modelId: "gpt-4o" },
  { providerId: "google", modelId: "gemini-2.5-pro" },
  { providerId: "codex", modelId: "gpt-6.1-sol" },
  { providerId: "anthropic", modelId: "claude-opus-5-5" },
  { providerId: "minimax-code", modelId: "mmcode/codex/gpt-6.1-sol" },
  { providerId: "minimax", modelId: "" },
  { providerId: "", modelId: "minimax" },
  { providerId: "MINIMAX-CODE", modelId: "MMCode/MiniMax-M3.1-Flash" },
];

const ALLOWED_FAMILY_LEAVES = LEAVES.filter((leaf) => isLeafAllowedByOwnerRule(leaf));
const CLOSED_LEAVES = LEAVES.filter((leaf) => isClosedProviderLeaf(leaf));
const OTHER_LEAVES = LEAVES.filter((leaf) => !isLeafAllowedByOwnerRule(leaf) && !isClosedProviderLeaf(leaf));

describe("the rule of the owner about leaves is written once", () => {
  it("keeps the generated copies of the rule equal to the source", () => {
    expect(driftedArtifacts().map((artifact) => artifact.path)).toEqual([]);
  });

  it("keeps the rule of the launcher in the one module, not beside it", () => {
    expect(launcherSource).toContain('from "../model-launch-policy.js"');
    expect(launcherSource).not.toMatch(/allowedMiniMax/);
    expect(launcherSource).not.toMatch(/allowedGlm/);
    expect(launcherSource).not.toMatch(/function isAllowedRestrictedProviderLeaf/);
  });

  it("names the closed providers and the allowed families once", () => {
    expect(LEAF_LAUNCH_POLICY.closedProviderPattern).toBe("codex|claude|anthropic");
    expect(LEAF_LAUNCH_POLICY.allowedFamilies.map((family) => family.providers)).toEqual([
      ["minimax", "minimax-code", "minimax-coding-plan"],
      ["glm", "zai", "zai-coding-plan", "zhipu"],
    ]);
  });
});

describe("the guard of the OpenCode integration answers with the rule of the owner", () => {
  it("answers exactly like the source for every leaf", () => {
    const guard = pluginRule();
    for (const leaf of LEAVES) {
      expect(guard.isClosedProviderLeaf(leaf), `${leaf.providerId}/${leaf.modelId}`).toBe(isClosedProviderLeaf(leaf));
      expect(guard.isLeafAllowedByOwnerRule(leaf), `${leaf.providerId}/${leaf.modelId}`).toBe(isLeafAllowedByOwnerRule(leaf));
    }
  });

  it("answers exactly like the source for every leaf and every switch of the owner", () => {
    const guard = pluginRule();
    for (const leaf of LEAVES) {
      for (const prohibitionsEnabled of [true, false]) {
        expect(guard.leafLaunchVerdict(leaf, { prohibitionsEnabled }), `${leaf.providerId}/${leaf.modelId}`).toBe(
          leafLaunchVerdict(leaf, { prohibitionsEnabled }),
        );
      }
    }
  });

  it("says the same words as the source when it refuses", () => {
    expect(pluginRule().LEAF_LAUNCH_REFUSAL_MESSAGES).toEqual(LEAF_LAUNCH_REFUSAL_MESSAGES);
  });

  it("stays one self-contained file", () => {
    expect(() => execFileSync(process.execPath, ["--check", PLUGIN_PATH.pathname], { stdio: "pipe" })).not.toThrow();
    expect(pluginSource).not.toMatch(/^\s*import\s+[^\s(]/m);
    expect(pluginSource).not.toMatch(/\brequire\s*\(/);
    expect(pluginSource).not.toMatch(/\bfrom\s+["'][^"']+["']/);
  });
});

describe("the resume client answers like the guard", () => {
  it("gives the same verdict on the same leaf", () => {
    const guard = pluginRule();
    for (const leaf of LEAVES) {
      for (const prohibitionsEnabled of [true, false]) {
        expect(openCodeLeafLaunchVerdict(leaf, { prohibitionsEnabled }), `${leaf.providerId}/${leaf.modelId}`).toBe(
          guard.leafLaunchVerdict(leaf, { prohibitionsEnabled }),
        );
      }
    }
  });

  it("gives the same verdict on the route of the catalog", () => {
    const guard = pluginRule();
    for (const route of ["minimax-code/mmcode/MiniMax-M3.1-Flash", "opencode/gpt-6.1-sol", "codex/gpt-6.1-sol", "zai/glm-5.3-flash"]) {
      const leaf = openCodeRouteLeaf(route);
      expect(leaf, route).toBeDefined();
      for (const prohibitionsEnabled of [true, false]) {
        expect(openCodeRouteVerdict(route, { prohibitionsEnabled }), route).toBe(
          guard.leafLaunchVerdict(leaf!, { prohibitionsEnabled }),
        );
      }
    }
  });

  it("refuses an incomplete route", () => {
    expect(openCodeRouteLeaf("minimax")).toBeUndefined();
    expect(openCodeRouteVerdict("minimax", { prohibitionsEnabled: false })).toBe("denied");
  });
});

describe("the behaviour of the rule is fixed", () => {
  it("refuses a closed provider whatever the switch says", () => {
    expect(CLOSED_LEAVES.length).toBeGreaterThan(0);
    for (const leaf of CLOSED_LEAVES) {
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: true }), `${leaf.providerId}/${leaf.modelId}`).toBe("denied");
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: false }), `${leaf.providerId}/${leaf.modelId}`).toBe("denied");
    }
  });

  it("refuses a route outside the allowed families while the prohibitions are on", () => {
    expect(OTHER_LEAVES.length).toBeGreaterThan(0);
    for (const leaf of OTHER_LEAVES) {
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: true }), `${leaf.providerId}/${leaf.modelId}`).toBe("denied");
    }
  });

  it("lets a route outside the allowed families pass when the owner switches the prohibitions off", () => {
    for (const leaf of OTHER_LEAVES) {
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: false }), `${leaf.providerId}/${leaf.modelId}`).toBe("allowed");
    }
  });

  it("lets a confirmed leaf of an allowed family pass", () => {
    expect(ALLOWED_FAMILY_LEAVES.length).toBeGreaterThan(0);
    for (const leaf of ALLOWED_FAMILY_LEAVES) {
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: true }), `${leaf.providerId}/${leaf.modelId}`).toBe("allowed");
      expect(leafLaunchVerdict(leaf, { prohibitionsEnabled: false }), `${leaf.providerId}/${leaf.modelId}`).toBe("allowed");
    }
  });

  it("does not offer a closed provider in the last resort catalog of the client", () => {
    const closed = ["anthropic/claude-sonnet-4-20250514"];
    for (const route of closed) {
      expect(openCodeRouteVerdict(route, { prohibitionsEnabled: false }), route).toBe("denied");
    }
  });
});

const RESTRICTED_ROOT = "/home/roomhacker/PycharmProjects/TelegramAuto";

/** The guard, loaded fresh so that its cache of the switch starts empty. */
async function loadGuard() {
  vi.resetModules();
  const module = await import("../integrations/opencode/agent-herder-autopilot.js");
  return (module as any).default as {
    setup: (ctx: unknown) => Promise<() => Promise<void>>;
  };
}

/** The context of OpenCode with one session in a closed project. */
function guardContext(model: { providerID: string; id: string }) {
  let modelHook: ((event: unknown) => Promise<void> | void) | undefined;
  const ctx = {
    event: { subscribe: () => (async function* () {})() },
    permission: { hook: vi.fn(async () => ({ dispose: vi.fn() })) },
    session: {
      get: vi.fn(async () => ({ data: { id: "root", directory: RESTRICTED_ROOT } })),
      hook: vi.fn(async (_name: string, callback: (event: unknown) => Promise<void> | void) => {
        modelHook = callback;
        return { dispose: vi.fn() };
      }),
    },
    agent: { get: vi.fn(async () => ({ data: {} })) },
    model: { list: vi.fn(async () => ({ data: [model] })) },
  };
  return {
    ctx,
    get modelHook() {
      return modelHook!;
    },
  };
}

/** The switch of the owner, as the service of the panel answers it. */
function stubProhibitions(enabled: boolean) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/hooks/prohibitions") {
      return new Response(JSON.stringify({ ok: true, known: true, prohibitionsEnabled: enabled }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the guard of the OpenCode integration keeps the behaviour of the rule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a closed provider whatever the switch of the owner says", async () => {
    for (const prohibitionsEnabled of [true, false]) {
      const guard = await loadGuard();
      stubProhibitions(prohibitionsEnabled);
      const context = guardContext({ providerID: "anthropic", id: "claude-sonnet" });
      const cleanup = await guard.setup(context.ctx);
      await expect(context.modelHook({ sessionID: "root", model: { providerID: "anthropic", id: "claude-sonnet" } }))
        .rejects.toThrow("the provider of this route is closed by the rule of the owner");
      await cleanup();
    }
  });

  it("refuses a route outside the allowed families while the prohibitions are on", async () => {
    const guard = await loadGuard();
    stubProhibitions(true);
    const context = guardContext({ providerID: "opencode", id: "gpt-6.1-sol" });
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "opencode", id: "gpt-6.1-sol" } }))
      .rejects.toThrow("the complete native provider route is forbidden");
    await cleanup();
  });

  it("lets a route outside the allowed families pass when the owner switches the prohibitions off", async () => {
    const guard = await loadGuard();
    stubProhibitions(false);
    const context = guardContext({ providerID: "opencode", id: "gpt-6.1-sol" });
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "opencode", id: "gpt-6.1-sol" } })).resolves
      .toBeUndefined();
    await cleanup();
  });

  it("lets a confirmed leaf of an allowed family pass", async () => {
    const guard = await loadGuard();
    stubProhibitions(true);
    const context = guardContext({ providerID: "minimax", id: "MiniMax-M3.1-Flash" });
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "minimax", id: "MiniMax-M3.1-Flash" } })).resolves
      .toBeUndefined();
    await cleanup();
  });

  it("reads the switch of the owner from the service of the panel, and remembers it for two seconds", async () => {
    const guard = await loadGuard();
    const fetchMock = stubProhibitions(true);
    const context = guardContext({ providerID: "opencode", id: "gpt-6.1-sol" });
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "opencode", id: "gpt-6.1-sol" } })).rejects
      .toThrow("the complete native provider route is forbidden");
    const asked = fetchMock.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(asked.filter((path) => path === "/api/hooks/prohibitions").length).toBe(1);
    expect(asked[0]).toBe("/api/hooks/prohibitions");
    await cleanup();
  });

  it("keeps the prohibitions as they were when the service of the panel does not answer", async () => {
    const guard = await loadGuard();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("the service of the panel is unreachable");
    }));
    const context = guardContext({ providerID: "opencode", id: "gpt-6.1-sol" });
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: { providerID: "opencode", id: "gpt-6.1-sol" } })).rejects
      .toThrow("the complete native provider route is forbidden");
    await cleanup();
  });
});
