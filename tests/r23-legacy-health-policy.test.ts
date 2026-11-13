import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebServer } from "../src/web/server.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";

const direct = {
  runtime: "opencode" as const,
  provider: "minimax-coding-plan" as const,
  model: "MiniMax-M3.1-Flash",
  reasoning: "default" as const,
  topic: "health" as const,
};

describe("legacy health endpoint policy", () => {
  it("admits the direct incident route before native execution", async () => {
    const res = await probe("valid");
    expect(res.status).toBe(200);
    expect(res.selected).toBe("minimax-coding-plan/MiniMax-M3.1-Flash");
  });

  it("denies an explicit forbidden model before native execution", async () => {
    const res = await probe("valid", "omniroute/cx/gpt-6-luna");
    expect(res.status).toBe(409);
    expect(res.selected).toBeUndefined();
  });

  it.each(["absent", "invalid"] as const)("fails closed for %s policy", async state => {
    const res = await probe(state);
    expect(res.status).toBe(503);
    expect(res.selected).toBeUndefined();
  });
});

async function probe(state: "valid" | "absent" | "invalid", explicitModel?: string) {
  const dir = await mkdtemp(join(tmpdir(), "r23-legacy-"));
  const policy = {
    version: 1 as const,
    allowedHarnesses: ["opencode" as const],
    preferredHarness: "opencode" as const,
    models: { opencode: "vendor/general" },
    incidentExecution: direct,
    projectRoutes: {
      "/workspace/exception": {
        harnesses: ["opencode" as const],
        models: { opencode: direct.provider + "/" + direct.model },
        deniedModels: ["*gpt*", "*claude*", "*codex*", "*anthropic*"],
      },
    },
  };
  let selected: string | undefined;
  const log = new ProjectLaunchAttemptLog(join(dir, "attempts.json"));
  const run = vi.fn(async (request) => {
    selected = request.model;
    return { ok: true, created: true, harness: "opencode" as const, name: "test", cwd: request.cwd, model: request.model, sessionId: "fixture", delivery: "accepted" as const };
  });
  const store = {
    load: async () => state === "valid" ? { kind: "valid", policy } : state === "absent" ? { kind: "absent" } : { kind: "invalid", error: "bad" },
  };
  const server = createWebServer({
    adapters: new Map(),
    converter: { async convert() { throw Error("unused"); } },
    sessionObservationManagedExternally: true,
    automationLaunchPolicyStore: store as never,
    projectLaunchDispatch: request => dispatchProjectLaunch({ ...request, policy }, log, run),
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("bind");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        incident_id: "legacy-incident",
        plan_id: "repair",
        harness: "opencode",
        name: "legacy",
        cwd: "/workspace/exception",
        message: "fixture",
        execution: direct,
        ...(explicitModel ? { model: explicitModel } : {}),
      }),
    });
    return { status: response.status, selected };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}
