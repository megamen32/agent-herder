import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog, type ProjectLaunchRunner, type ProjectLaunchDispatcher } from "../src/automation/project-launch-dispatch.js";
import { NOTICEPLACE_HEALTH_AUTHORIZED } from "../src/automation/noticeplace-health-launch.js";
import type { AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";

const purpose = "noticeplace.health-analysis";
const model = "omniroute/minimax-combo-m3.1";
const token = "test-only-health-launch-token";
let directory: string;
let servers: Server[];

beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), ".tmp/noticeplace-test-"));
  servers = [];
  vi.stubEnv("NOTICEPLACE_HEALTH_LAUNCH_TOKEN", token);
});
afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function policy(harnesses: Array<"opencode" | "codex"> = ["opencode", "codex"]): AutomationLaunchPolicy {
  return { version: 1, allowedHarnesses: ["codex", "opencode"], preferredHarness: "codex",
    models: { codex: "ordinary-codex", opencode: "ordinary-opencode" },
    projectRoutes: { "/canonical/project": { harnesses, aliases: ["project"], models: { [harnesses[0]!]: "route-model" } } } };
}

async function fixture(selectedPolicy = policy(), outcome: "accepted" | "unknown" | "rejected" = "accepted") {
  const run = vi.fn<ProjectLaunchRunner>(async request => ({
    ok: outcome === "accepted", created: outcome !== "rejected", harness: request.harness,
    name: "health-test", cwd: request.cwd, model: request.model, sessionId: "test-session",
    ...(outcome === "unknown" ? { admissionUnknown: true } : {}),
    delivery: outcome === "rejected" ? "not_attempted" : "completed",
  }));
  const log = new ProjectLaunchAttemptLog(join(directory, "attempts.json"));
  const dispatch = vi.fn<ProjectLaunchDispatcher>(async request => dispatchProjectLaunch({ policy: selectedPolicy, ...request }, log, run));
  const policyStore = new AutomationLaunchPolicyStore(join(directory, "policy.json"));
  const replace = vi.spyOn(policyStore, "replace");
  const server = createWebServer({ adapters: new Map(), converter: { async convert() { throw new Error("unused"); } },
    mcpAuthToken: "test-global-token", projectLaunchDispatch: dispatch, automationLaunchPolicyStore: policyStore,
    sessionObservationManagedExternally: true });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  const post = (body: Record<string, unknown> = {}, bearer: string | undefined = token, path = "/api/automation/project-launch", method = "POST") => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ purpose, harness: "opencode", model, project: "project", cwd: "/untrusted/cwd", message: "Analyze incident", operation_id: "health-operation", ...body }),
  });
  return { run, dispatch, log, post, replace };
}

describe("Notice Place health-launch HTTP admission", () => {
  it.each([undefined, "wrong", "test-global-token"])("rejects missing/incorrect/different-purpose token %s", async bearer => {
    const { post, run, dispatch } = await fixture();
    const response = await post({}, bearer ?? "");
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("fails closed without the dedicated verifier env var", async () => {
    vi.stubEnv("NOTICEPLACE_HEALTH_LAUNCH_TOKEN", "");
    const { post, run } = await fixture();
    expect((await post()).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["other/model", `${model} `, "omniroute/minimax/MiniMax-M3.1-Flash", "omniroute/glm-5.3-flash-minimax-m3.1"])("rejects non-allowlisted exact model %s", async invalid => {
    const { post, run } = await fixture();
    expect((await post({ model: invalid })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects another harness and missing stable operation identity", async () => {
    const { post, run } = await fixture();
    expect((await post({ harness: "codex" })).status).toBe(400);
    expect((await post({ operation_id: " " })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([model])("overrides the model only, retaining route CWD for %s", async approved => {
    const { post, run } = await fixture(policy(["codex", "opencode"]));
    const response = await post({ model: approved });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "accepted", selectedHarness: "opencode", model: approved });
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: "opencode", model: approved, cwd: "/canonical/project" }));
  });
  it("rejects a project excluding OpenCode without calling any runner", async () => {
    const { post, run } = await fixture(policy(["codex"]));
    expect((await post()).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects OpenCode excluded globally even if the project route allows it", async () => {
    const selected = policy();
    selected.allowedHarnesses = ["codex"];
    const { post, run } = await fixture(selected);
    expect((await post()).status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });
  it("allows the exact pair for an unconfigured project", async () => {
    const { post, run } = await fixture();
    expect((await post({ project: "unconfigured" })).status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: "opencode", model, cwd: "/untrusted/cwd" }));
  });
  it("the dedicated bearer cannot launch an ordinary purpose", async () => {
    const { post, run, dispatch } = await fixture();
    expect((await post({ purpose: "ordinary" })).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves ordinary route precedence despite forged JSON authorization", async () => {
    const { post, run } = await fixture(policy(["codex", "opencode"]));
    expect((await post({ purpose: "ordinary", noticeplaceHealthAuthorized: true }, "")).status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: "codex", model: "route-model", cwd: "/canonical/project" }));
  });
  it("preserves ordinary unconfigured model input", async () => {
    const { post, run } = await fixture();
    expect((await post({ purpose: "ordinary", project: "unconfigured", model: "custom/model" }, "")).status).toBe(200);
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: "opencode", model: "custom/model", cwd: "/untrusted/cwd" }));
  });
  it.each(["accepted", "unknown"] as const)("replays %s receipt without another executor", async outcome => {
    const { post, run } = await fixture(policy(), outcome);
    const first = await (await post()).json();
    const replay = await (await post({ model })).json();
    expect(replay).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("never falls back on a definite health launch failure, including replay", async () => {
    const { post, run } = await fixture(policy(), "rejected");
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not retry a rejected unconfigured health operation", async () => {
    const { post, run } = await fixture(policy(), "rejected");
    expect((await post({ project: "unconfigured" })).status).toBe(409);
    expect((await post({ project: "unconfigured" })).status).toBe(409);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("revalidates the approved pair at the dispatch boundary", async () => {
    const { log, run } = await fixture();
    const result = await dispatchProjectLaunch({ policy: policy(), project: "project", message: "Analyze",
      harness: "opencode", model: "invalid/model", operationId: "internal-invalid", [NOTICEPLACE_HEALTH_AUTHORIZED]: true }, log, run);
    expect(result.outcome).toBe("no_harness");
    expect(run).not.toHaveBeenCalled();
  });
  it("retains the in-flight reservation across concurrent HTTP requests", async () => {
    const { post, run } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    run.mockImplementationOnce(async request => {
      entered();
      await pending;
      return { ok: true, created: true, harness: request.harness, name: "concurrent", cwd: request.cwd, delivery: "completed" };
    });
    const first = post();
    try {
      await started;
      const replay = await post();
      expect(await replay.json()).toMatchObject({ outcome: "in_flight" });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await first;
    }
  });
  it("cannot use the narrow token to mutate launch policy", async () => {
    const { post, run, replace } = await fixture();
    expect((await post({}, token, "/api/automation/launch-policy", "PUT")).status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
