import { describe, expect, it } from "vitest";
import { modelMatchesEntry, modelPermittedForProject } from "../src/project-model-policy.js";
import { resolveProjectLaunch, type AutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import { assertModelAllowedForProjectRoute } from "../src/project-model-gate.js";
import { healthModelForHarness, INCIDENT_EXECUTION, normalizeIncidentExecution } from "../src/health-remediation.js";
import { validateNoticeplaceHealthLaunch } from "../src/automation/noticeplace-health-launch.js";
import { leafLaunchVerdict } from "../src/model-launch-policy.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { NOTICEPLACE_HEALTH_AUTHORIZED } from "../src/automation/noticeplace-health-launch.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { createWebServer } from "../src/web/server.js";

const route = { harnesses: ["opencode" as const], models: { opencode: "zai/GLM-new" }, deniedModels: ["gpt-*", "*/gpt-*", "claude*", "*/claude*"] };
const policy: AutomationLaunchPolicy = { version: 1, allowedHarnesses: ["opencode"], preferredHarness: "opencode", models: { opencode: "omniroute/cx/gpt-6-luna" }, projectRoutes: { "/workspace/TelegramAuto": route } };

describe("family blacklist without allowedModels", () => {
  it.each([['omniroute','cx/gpt-6-luna'], ['openai-codex','gpt-6-luna'], ['vendor','claude-opus'], ['anthropic','unknown']])('denies forbidden leaf %s/%s', (providerId, modelId) => {
    expect(leafLaunchVerdict({providerId, modelId}, {prohibitionsEnabled: true})).toBe('denied');
  });
  it.each([['unknown-vendor','new-model'], ['zai','GLM-new'], ['minimax','MiniMax-new']])('allows confirmed non-forbidden leaf %s/%s', (providerId, modelId) => {
    expect(leafLaunchVerdict({providerId, modelId}, {prohibitionsEnabled: true})).toBe('allowed');
  });
  it("uses the fully qualified owner-selected global incident route and accepts project exceptions", () => {
    const execution = { runtime: "opencode", provider: "omniroute", model: "omniroute/cx/gpt-6-luna", reasoning: "default", topic: "health" } as const;
    expect(INCIDENT_EXECUTION).toEqual(execution);
    expect(normalizeIncidentExecution(execution)).toEqual(execution);
    expect(normalizeIncidentExecution({runtime:"opencode", provider:"minimax-coding-plan", model:"MiniMax-M3.1-Flash", reasoning:"default", topic:"health"}).model).toBe("MiniMax-M3.1-Flash");
    expect(normalizeIncidentExecution({...execution, model:"zai/GLM-new"}).model).toBe("zai/GLM-new");
    expect(healthModelForHarness("opencode", execution)).toBe("omniroute/cx/gpt-6-luna");
    expect(healthModelForHarness("opencode", {...execution, model:"cx/gpt-6-luna"})).toBe("omniroute/cx/gpt-6-luna");
    for (const model of [execution.model, "zai/GLM-new", "minimax-coding-plan/MiniMax-new"]) {
      expect(validateNoticeplaceHealthLaunch({harness: "opencode", model, operationId: "op"})).toBeUndefined();
    }
  });
  it.each(["gpt-6-luna", "omniroute/cx/gpt-6-luna", "opencode/gpt-6-luna", "vendor/a/Claude-4-sonnet"])("denies %s", model => {
    expect(modelPermittedForProject(policy, "/workspace/TelegramAuto/src", model)).toBe(false);
    expect(() => assertModelAllowedForProjectRoute(policy, "/workspace/TelegramAuto", model)).toThrow(/model_not_permitted/);
  });
  it.each(["zai/GLM-new", "minimax-coding-plan/MiniMax-new", "vendor/new-model"])("allows %s", model => {
    expect(modelPermittedForProject(policy, "/workspace/TelegramAuto", model)).toBe(true);
  });
  it("prefers project route over a globally denied incident model", () => {
    expect(resolveProjectLaunch(policy, { project: "/workspace/TelegramAuto" })).toMatchObject({kind: "launch", model: "zai/GLM-new"});
    expect(() => assertModelAllowedForProjectRoute(policy, "/workspace/TelegramAuto", policy.models.opencode)).toThrow();
  });
  it("rejects an explicit forbidden incident model without admission or substitution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-policy-"));
    try {
      const run = vi.fn(async (request) => ({ok:true, created:true, harness:"opencode" as const, name:"test", cwd:request.cwd, sessionId:"local-fixture", inputId:request.inputId, delivery:"accepted" as const, model:request.model}));
      const result = await dispatchProjectLaunch({[NOTICEPLACE_HEALTH_AUTHORIZED]:true, policy, project:"/workspace/TelegramAuto", cwd:"/workspace/TelegramAuto", message:"fixture", operationId:"r23-fixture", harness:"opencode", model:"omniroute/cx/gpt-6-luna"}, new ProjectLaunchAttemptLog(join(dir,"attempts.json")), run);
      expect(result.outcome).toBe("no_harness");
      expect(result.routingReasonCode).toBe("model_not_permitted_for_project");
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it("does not bypass a cwd blacklist by naming an unrelated project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-cwd-"));
    try {
      const run = vi.fn(async (request) => ({ok:true, created:true, harness:"opencode" as const, name:"test", cwd:request.cwd, sessionId:"local-fixture", inputId:request.inputId, delivery:"accepted" as const, model:request.model}));
      const result = await dispatchProjectLaunch({[NOTICEPLACE_HEALTH_AUTHORIZED]:true, policy, project:"other-project", cwd:"/workspace/TelegramAuto/src", message:"fixture", operationId:"r23-cwd", harness:"opencode", model:"omniroute/cx/gpt-6-luna"}, new ProjectLaunchAttemptLog(join(dir,"attempts.json")), run);
      expect(result.outcome).toBe("no_harness");
      expect(run).not.toHaveBeenCalled();
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it("uses the permitted project route when the incident request has no explicit model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-default-"));
    try {
      const run = vi.fn(async (request) => ({ok:true, created:true, harness:"opencode" as const, name:"test", cwd:request.cwd, sessionId:"local-fixture", inputId:request.inputId, delivery:"accepted" as const, model:request.model}));
      const result = await dispatchProjectLaunch({[NOTICEPLACE_HEALTH_AUTHORIZED]:true, policy, project:"/workspace/TelegramAuto", cwd:"/workspace/TelegramAuto", message:"fixture", operationId:"r23-default", harness:"opencode"}, new ProjectLaunchAttemptLog(join(dir,"attempts.json")), run);
      expect(result.outcome).toBe("accepted");
      expect(run.mock.calls[0]?.[0].model).toBe("zai/GLM-new");
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it("does not replay an unknown admission after the policy model changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-unknown-"));
    try {
      const run = vi.fn(async (request) => ({ok:false, created:false, harness:"opencode" as const, name:"test", cwd:request.cwd, inputId:request.inputId, delivery:"admission_unknown" as const, admissionUnknown:true, nonRetryable:true, model:request.model}));
      const log = new ProjectLaunchAttemptLog(join(dir,"attempts.json"));
      const request = {[NOTICEPLACE_HEALTH_AUTHORIZED]:true as const, policy, project:"/workspace/TelegramAuto", cwd:"/workspace/TelegramAuto", message:"fixture", operationId:"r23-unknown", harness:"opencode" as const};
      expect((await dispatchProjectLaunch(request,log,run)).outcome).toBe("admission_unknown");
      const changed = {...policy, projectRoutes:{"/workspace/TelegramAuto": {...route, models:{opencode:"minimax/new"}}}};
      const replay = await dispatchProjectLaunch({...request, policy:changed},log,run);
      expect(replay.outcome).toBe("admission_unknown");
      expect(replay.model).toBe("zai/GLM-new");
      expect(run).toHaveBeenCalledOnce();
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it("uses incidentExecution rather than the general model for an unconfigured project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-incident-"));
    try {
      const run = vi.fn(async (request) => ({ok:true, created:true, harness:"opencode" as const, name:"test", cwd:request.cwd, sessionId:"local-fixture", inputId:request.inputId, delivery:"accepted" as const, model:request.model}));
      const p = {...policy, models:{opencode:"vendor/general"}, incidentExecution:INCIDENT_EXECUTION, projectRoutes:{}};
      const request = {[NOTICEPLACE_HEALTH_AUTHORIZED]:true as const, policy:p, project:"/workspace/other", cwd:"/workspace/other", message:"fixture", operationId:"r23-global", harness:"opencode" as const};
      const log = new ProjectLaunchAttemptLog(join(dir,"attempts.json"));
      const result = await dispatchProjectLaunch(request, log, run);
      expect(result.outcome).toBe("accepted");
      expect(run.mock.calls[0]?.[0].model).toBe("omniroute/cx/gpt-6-luna");
      const replay = await dispatchProjectLaunch({...request, policy:{...p, incidentExecution:{...INCIDENT_EXECUTION, provider:"minimax-coding-plan", model:"MiniMax-M3.1-Flash"}}}, log, run);
      expect(replay.outcome).toBe("accepted");
      expect(replay.model).toBe("omniroute/cx/gpt-6-luna");
      expect(run).toHaveBeenCalledOnce();
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it("accepts model-less health intent over the current HTTP route and preserves its receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "r23-http-"));
    const token = "local-test-only";
    vi.stubEnv("NOTICEPLACE_HEALTH_LAUNCH_TOKEN", token);
    const run = vi.fn(async (request) => ({ok:true, created:true, harness:"opencode" as const, name:"test", cwd:request.cwd, sessionId:"local-fixture", inputId:request.inputId, delivery:"accepted" as const, model:request.model}));
    const log = new ProjectLaunchAttemptLog(join(dir,"attempts.json"));
    const p = {...policy, incidentExecution:INCIDENT_EXECUTION};
    const server = createWebServer({adapters:new Map(), converter:{async convert(){throw new Error("unused");}}, sessionObservationManagedExternally:true,
      projectLaunchDispatch: request => dispatchProjectLaunch({...request, policy:p}, log, run)});
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("listen failed");
      const body = {purpose:"noticeplace.health-analysis", project:"/workspace/TelegramAuto", cwd:"/workspace/TelegramAuto", message:"fixture", operation_id:"r23-http", harness:"opencode"};
      const post = () => fetch(`http://127.0.0.1:${address.port}/api/automation/project-launch`, {method:"POST", headers:{"content-type":"application/json", authorization:`Bearer ${token}`}, body:JSON.stringify(body)});
      const first = await post();
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({outcome:"accepted",model:"zai/GLM-new"});
      const repeat = await post();
      expect(await repeat.json()).toMatchObject({outcome:"accepted",model:"zai/GLM-new"});
      expect(run).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      vi.unstubAllEnvs();
      await rm(dir,{recursive:true,force:true});
    }
  });
  it("preserves exact and prefix matching and denial wins", () => {
    expect(modelMatchesEntry("abc", "a*")).toBe(true);
    expect(modelMatchesEntry("abc", "abc")).toBe(true);
    expect(modelMatchesEntry("abc", "ab")).toBe(false);
    expect(modelPermittedForProject({...policy, projectRoutes: {"/workspace/TelegramAuto": {...route, allowedModels: ["*"]}}}, "/workspace/TelegramAuto", "opencode/gpt-6-luna")).toBe(false);
  });
});
