import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transformWithOxc } from "vite";

import { createWebServer, isAllowedRestrictedProviderLeaf } from "../src/web/server.js";
import { isLeafAllowedByOwnerRule } from "../src/model-launch-policy.js";
import {
  MODEL_VERDICT_LABELS,
  RESTRICTED_PROJECT_ROOTS,
  approvedModelId,
  isRestrictedProjectPath,
  modelCandidates,
  modelVerdict,
  routeStatusLabel,
  type LeafVerdictEntry,
} from "../src/web-ui/model-status.js";
import { checkProjectModelRoutes } from "../src/web-ui/projects-settings.js";
import type { LaunchPolicy, ProjectLaunchRoute } from "../src/web-ui/launch-policy-settings.js";
import type { HarnessAdapter } from "../src/types/index.js";

/**
 * The panel must not promise a launch the guard of the medium will revoke.
 *
 * The rule of the owner is about the provider behind the route, and only the
 * node that holds the proof of the route knows it. The panel therefore asks the
 * server and shows the word of the answer; the name of the model and the
 * catalog of the environment are never enough.
 */

const CLOSED_PROJECT = "/home/roomhacker/PycharmProjects/TelegramAuto";
const OPEN_PROJECT = "/home/roomhacker/agents-projects/agent-herder";

/** The route the live catalog confirms and the server proves. */
const PROVEN_ROUTE = "omniroute/minimax-combo-m3.1";
/** The route the catalog confirms, but the server cannot prove. */
const UNPROVEN_ROUTE = "omniroute/minimax-combo-m3.9";
/** The route of a provider the rule of the owner closes. */
const CLOSED_ROUTE = "codex/gpt-6.1-sol";
/** The route the name of which is innocent, but the provider behind it is not allowed. */
const REFUSED_ROUTE = "opencode/gpt-6.1-sol";

const CATALOG = [PROVEN_ROUTE, UNPROVEN_ROUTE, CLOSED_ROUTE, REFUSED_ROUTE, "minimax-coding-plan/MiniMax-M3.1-Flash"];

const policy: LaunchPolicy = {
  version: 1,
  allowedHarnesses: ["opencode"],
  preferredHarness: "opencode",
  models: { opencode: PROVEN_ROUTE },
  projectRoutes: {},
};

const route: ProjectLaunchRoute = { harnesses: ["opencode"], models: { opencode: UNPROVEN_ROUTE } };

/** The verdict of the server about one route. */
function leaf(verdict: "allowed" | "denied" | "unknown", reason: LeafVerdictEntry["reason"]): LeafVerdictEntry {
  return { verdict, reason };
}

describe("the panel shows what the server answered about the route", () => {
  it("calls a route the server proved working", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: PROVEN_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
      leafVerdict: leaf("allowed", "verified"),
    });
    expect(verdict.kind).toBe("works");
    expect(verdict.label).toBe(MODEL_VERDICT_LABELS.works);
    expect(verdict.tone).toBe("ok");
    expect(verdict.detail).toContain("Сервер подтвердил маршрут");
  });

  it("never calls a route the server could not prove working", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: UNPROVEN_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
      leafVerdict: leaf("unknown", "unverified"),
    });
    expect(verdict.kind).toBe("unverified");
    expect(verdict.label).toBe(MODEL_VERDICT_LABELS.unverified);
    expect(verdict.label).not.toBe(MODEL_VERDICT_LABELS.works);
    expect(verdict.tone).toBe("error");
    // The owner is told what happens and what to press.
    expect(verdict.label).toContain("запуск будет отозван");
    expect(verdict.reason).toContain("запуск будет отозван");
    expect(verdict.action).toContain("Поставить рабочую модель");
    expect(verdict.action).toContain(PROVEN_ROUTE);
  });

  it("refuses a route the server rejected, and says why", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: REFUSED_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
      leafVerdict: leaf("denied", "not-allowed"),
    });
    expect(verdict.kind).toBe("refused");
    expect(verdict.label).toBe(MODEL_VERDICT_LABELS.refused);
    expect(verdict.tone).toBe("error");
    expect(verdict.reason).toContain("список разрешённых");
    expect(verdict.action).toContain("Поставить рабочую модель");
  });

  it("keeps the block of the rule of the owner on a closed provider", () => {
    // The name of a closed provider is closed before anything else is asked:
    // the block of the rule of the owner stays the same.
    const verdict = modelVerdict({
      harness: "opencode",
      model: CLOSED_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
      leafVerdict: leaf("denied", "closed-provider"),
    });
    expect(verdict.kind).toBe("closed");
    expect(verdict.tone).toBe("error");
    expect(verdict.label).not.toBe(MODEL_VERDICT_LABELS.works);
  });

  it("says that the route of a closed project is not checked while the server is silent", () => {
    // The catalog confirms the model, so the old check would have called it
    // working. Without the word of the server the panel says nothing of that
    // kind.
    const verdict = modelVerdict({
      harness: "opencode",
      model: UNPROVEN_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
    });
    const status = routeStatusLabel({ restricted: true, verdict });
    expect(status.label).not.toBe(MODEL_VERDICT_LABELS.works);
    expect(status.label).toBe("проверяем маршрут…");
    expect(status.tone).toBe("unknown");
  });

  it("shows the word of the server about the route of a closed project", () => {
    const proven = modelVerdict({
      harness: "opencode",
      model: PROVEN_ROUTE,
      confirmed: CATALOG,
      restricted: true,
      workingModel: PROVEN_ROUTE,
      leafVerdict: leaf("allowed", "verified"),
    });
    expect(routeStatusLabel({ restricted: true, leaf: leaf("allowed", "verified"), verdict: proven }).label)
      .toBe(MODEL_VERDICT_LABELS.works);
  });
});

describe("the client cannot decide the route by itself", () => {
  it("blocks a closed project whose route the server did not prove", () => {
    const checks = checkProjectModelRoutes(
      CLOSED_PROJECT,
      route,
      policy,
      { opencode: CATALOG },
      { [UNPROVEN_ROUTE]: leaf("unknown", "unverified"), [PROVEN_ROUTE]: leaf("allowed", "verified") },
    );
    expect(checks[0]?.state).toBe("blocked");
    expect(checks[0]?.verdict.kind).toBe("unverified");
    expect(checks[0]?.reason).toContain("запуск будет отозван");
    // The fix of the block is the route the server confirmed, and nothing else.
    expect(checks[0]?.working).toBe(PROVEN_ROUTE);
  });

  it("writes only the route the server allowed, never one it picked by name", () => {
    const candidates = modelCandidates("opencode", { confirmed: [PROVEN_ROUTE, UNPROVEN_ROUTE] });
    expect(candidates).toContain(PROVEN_ROUTE);
    // The server did not allow the first candidate: the panel writes nothing.
    expect(approvedModelId(candidates, { [PROVEN_ROUTE]: leaf("unknown", "unverified") })).toBe("");
    // The second one is allowed: the panel writes it.
    expect(approvedModelId(candidates, {
      [PROVEN_ROUTE]: leaf("unknown", "unverified"),
      [UNPROVEN_ROUTE]: leaf("allowed", "verified"),
    })).toBe(UNPROVEN_ROUTE);
    // Without an answer of the server there is nothing to write.
    expect(approvedModelId(candidates, undefined)).toBe("");
  });

  it("keeps the promise of the catalog for a project the rule of the owner does not close", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: PROVEN_ROUTE,
      confirmed: CATALOG,
      restricted: false,
      workingModel: PROVEN_ROUTE,
    });
    expect(verdict.kind).toBe("works");
    expect(verdict.label).toBe(MODEL_VERDICT_LABELS.works);
  });

  it("knows the closed projects of the rule of the owner", () => {
    expect(isRestrictedProjectPath(CLOSED_PROJECT)).toBe(true);
    expect(isRestrictedProjectPath("/home/roomhacker/PycharmProjects/video_watching")).toBe(true);
    expect(isRestrictedProjectPath("/home/roomhacker/PycharmProjects/video_watching/sub")).toBe(true);
    expect(isRestrictedProjectPath(OPEN_PROJECT)).toBe(false);
  });
});

describe("the endpoint of the panel holds the word of the verdict and nothing else", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  /** The leaves the node proves for the routes of the test. */
  const LEAVES: Record<string, Array<{ providerId: string; modelId: string }>> = {
    [PROVEN_ROUTE]: [{ providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" }],
    [CLOSED_ROUTE]: [{ providerId: "codex", modelId: "gpt-6.1-sol" }],
  };

  function fakeOpenCodeAdapter(): HarnessAdapter {
    return {
      type: "opencode",
      name: "Fake OpenCode",
      async init() {},
      async listSessions() { return []; },
      async listModels() { return Object.keys(LEAVES); },
      async getSession() { return null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: false, error: "cannot stop" }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
      async resolveModelProviderLeaves(modelId: string) {
        const resolved = LEAVES[modelId];
        if (!resolved) return null;
        return { nativeHarness: "opencode", nativeModelId: modelId, resolvedProviderLeaves: resolved };
      },
    } as unknown as HarnessAdapter;
  }

  async function startServer(): Promise<string> {
    const server = createWebServer({
      adapters: new Map([["opencode", fakeOpenCodeAdapter()]]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  it("answers with the word of the verdict of every route it was asked about", async () => {
    const base = await startServer();
    const asked = [PROVEN_ROUTE, UNPROVEN_ROUTE, CLOSED_ROUTE].join(",");
    const response = await fetch(`${base}/api/model-launch-verdict?harness=opencode&cwd=${encodeURIComponent(CLOSED_PROJECT)}&modelIds=${encodeURIComponent(asked)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { verdicts: Record<string, { verdict: string; reason: string }> };
    expect(body.verdicts[PROVEN_ROUTE]?.verdict).toBe("allowed");
    expect(body.verdicts[UNPROVEN_ROUTE]?.verdict).toBe("unknown");
    expect(body.verdicts[CLOSED_ROUTE]?.verdict).toBe("denied");
    expect(body.verdicts[CLOSED_ROUTE]?.reason).toBe("closed-provider");
    for (const entry of Object.values(body.verdicts)) {
      expect(["allowed", "denied", "unknown"]).toContain(entry.verdict);
    }
  });

  it("does not leak the provider behind the route", async () => {
    const base = await startServer();
    const response = await fetch(`${base}/api/model-launch-verdict?harness=opencode&cwd=${encodeURIComponent(CLOSED_PROJECT)}&modelIds=${encodeURIComponent(PROVEN_ROUTE)}`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    // The proof of the route stays on the node that holds it.
    expect(raw).not.toContain("minimax-code");
    expect(raw).not.toContain("MiniMax-M3.1-Flash");
    expect(raw).not.toContain("resolvedProviderLeaves");
    expect(raw).not.toContain("providerId");
  });

  it("refuses a question from another origin", async () => {
    const base = await startServer();
    const foreign = await fetch(`${base}/api/model-launch-verdict?harness=opencode&cwd=${encodeURIComponent(CLOSED_PROJECT)}&modelIds=${encodeURIComponent(PROVEN_ROUTE)}`, {
      headers: { origin: "http://another.example" },
    });
    expect(foreign.status).toBe(403);
    const crossSite = await fetch(`${base}/api/model-launch-verdict?harness=opencode&cwd=${encodeURIComponent(CLOSED_PROJECT)}&modelIds=${encodeURIComponent(PROVEN_ROUTE)}`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
  });

  it("asks for the route and the project of the question", async () => {
    const base = await startServer();
    expect((await fetch(`${base}/api/model-launch-verdict?cwd=${encodeURIComponent(CLOSED_PROJECT)}&modelIds=${PROVEN_ROUTE}`)).status).toBe(400);
    expect((await fetch(`${base}/api/model-launch-verdict?harness=opencode&modelIds=${PROVEN_ROUTE}`)).status).toBe(400);
    expect((await fetch(`${base}/api/model-launch-verdict?harness=opencode&cwd=${encodeURIComponent(CLOSED_PROJECT)}`)).status).toBe(400);
  });
});

describe("the rule of the server is the rule of the launcher", () => {
  const launcherSource = readFileSync(new URL("../src/autopilot/unfinished-session-launcher.ts", import.meta.url), "utf8");
  const pluginSource = readFileSync(new URL("../integrations/opencode/agent-herder-autopilot.js", import.meta.url), "utf8");

  /**
   * The rule of the launcher, taken from the one source of the rule.
   *
   * The launcher does not keep a copy of the rule any more: it asks the one
   * module (`src/model-launch-policy.ts`). The server keeps its own copy only
   * so the panel can answer with the word of the verdict, and this test is the
   * fence that keeps that copy equal to the rule of the launcher.
   */
  async function launcherRule(): Promise<(leaf: { providerId: string; modelId: string }) => boolean> {
    expect(launcherSource, "the launcher must ask the one source of the rule").toContain('from "../model-launch-policy.js"');
    return isLeafAllowedByOwnerRule;
  }

  /** The closed projects of the launcher, taken from its own source. */
  async function launcherRoots(): Promise<string[]> {
    const start = launcherSource.indexOf("const CODEX_CLAUDE_RESTRICTED_PROJECT_ROOTS");
    expect(start, "the launcher must keep the list of the closed projects").toBeGreaterThan(-1);
    const end = launcherSource.indexOf("]", start);
    expect(end, "the list of the closed projects must be a whole array").toBeGreaterThan(start);
    const snippet = launcherSource.slice(start, end + 1);
    const { code } = await transformWithOxc(snippet, "launcher-roots.ts", { lang: "ts" });
    const factory = new Function(`${code}\nreturn CODEX_CLAUDE_RESTRICTED_PROJECT_ROOTS;`) as () => string[];
    return [...factory()];
  }

  /** The closed projects of the guard of the OpenCode integration. */
  function pluginRoots(): string[] {
    const start = pluginSource.indexOf("const restrictedProjectRoots = new Set([");
    expect(start, "the guard must keep the list of the closed projects").toBeGreaterThan(-1);
    const open = pluginSource.indexOf("[", start);
    const close = pluginSource.indexOf("]", open);
    expect(close, "the list of the closed projects must be a whole array").toBeGreaterThan(open);
    const factory = new Function(`return ${pluginSource.slice(open, close + 1)};`) as () => string[];
    return [...factory()];
  }

  /** The check of the launcher, taken from its own source. */
  async function launcherProjectCheck(): Promise<(cwd: string) => boolean> {
    const roots = await launcherRoots();
    const start = launcherSource.indexOf("function isCodexClaudeRestrictedCohortProject");
    expect(start, "the launcher must keep the check of the closed project").toBeGreaterThan(-1);
    const end = launcherSource.indexOf("\n}\n", start);
    const snippet = launcherSource.slice(start, end + 3);
    const { code } = await transformWithOxc(snippet, "launcher-project.ts", { lang: "ts" });
    const factory = new Function("normalize", "ROOTS", `
      const CODEX_CLAUDE_RESTRICTED_PROJECT_ROOTS = ROOTS;
      ${code}
      return isCodexClaudeRestrictedCohortProject;
    `) as (normalize: (value: string) => string, roots: string[]) => (cwd: string) => boolean;
    return factory(normalize, roots);
  }

  const LEAVES = [
    { providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" },
    { providerId: "minimax", modelId: "minimax/MiniMax-M3" },
    { providerId: "minimax-coding-plan", modelId: "MiniMax-M3.1-Flash" },
    { providerId: "zai", modelId: "glm-5.3-flash" },
    { providerId: "zai-coding-plan", modelId: "glm-5.3-flash" },
    { providerId: "zhipu", modelId: "glm-4.6" },
    { providerId: "opencode", modelId: "gpt-6.1-sol" },
    { providerId: "opencode", modelId: "glm-5.3" },
    { providerId: "minimax-code", modelId: "mmcode/gpt-6.1-sol" },
    { providerId: "codex", modelId: "gpt-6.1-sol" },
    { providerId: "anthropic", modelId: "claude-opus-5-5" },
    { providerId: "minimax-code", modelId: "codex/gpt-6.1-sol" },
    { providerId: "", modelId: "minimax" },
    { providerId: "minimax", modelId: "" },
    { providerId: "MINIMAX-CODE", modelId: "MMCode/MiniMax-M3.1-Flash" },
  ];

  it("answers exactly like the launcher for every leaf", async () => {
    const rule = await launcherRule();
    for (const leaf of LEAVES) {
      expect(isAllowedRestrictedProviderLeaf(leaf), `${leaf.providerId}/${leaf.modelId}`).toBe(rule(leaf));
    }
  });

  it("allows the route the live catalog proves and refuses the closed ones", async () => {
    expect(isAllowedRestrictedProviderLeaf({ providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" })).toBe(true);
    expect(isAllowedRestrictedProviderLeaf({ providerId: "codex", modelId: "gpt-6.1-sol" })).toBe(false);
    expect(isAllowedRestrictedProviderLeaf({ providerId: "anthropic", modelId: "claude-opus-5-5" })).toBe(false);
  });

  it("names the same closed projects as the launcher and as the guard", async () => {
    const launcher = await launcherRoots();
    const guard = pluginRoots();
    const panel = [...RESTRICTED_PROJECT_ROOTS];
    expect([...panel].sort()).toEqual([...launcher].sort());
    expect([...panel].sort()).toEqual([...guard].sort());
  });

  it("finds the closed project exactly like the launcher", async () => {
    const launcherCheck = await launcherProjectCheck();
    const paths = [
      "/home/roomhacker/PycharmProjects/TelegramAuto",
      "/home/roomhacker/PycharmProjects/TelegramAuto/",
      "/home/roomhacker/PycharmProjects/TelegramAuto/sub",
      "/home/roomhacker/PycharmProjects/TelegramAuto/./sub",
      "/home/roomhacker/PycharmProjects/TelegramAuto/../TelegramAuto",
      "/home/roomhacker/pycharmprojects/telegramauto",
      "/home/roomhacker/PYCHARMPROJECTS/VIDEO_WATCHING",
      "/home/roomhacker/PycharmProjects/video_watching",
      "/home/roomhacker/PycharmProjects/video_watching/sub",
      "//home//roomhacker//PycharmProjects//TelegramAuto",
      "/home/roomhacker/PycharmProjects/TelegramAutoExtra",
      "/home/roomhacker/agents-projects/agent-herder",
      "/home/roomhacker/PycharmProjects",
      "",
    ];
    for (const path of paths) {
      expect(isRestrictedProjectPath(path), path).toBe(launcherCheck(path));
    }
  });
});
