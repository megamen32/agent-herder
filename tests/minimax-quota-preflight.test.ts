import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMiniMaxQuotaPreflight, MINIMAX_SUBSCRIPTION_MODEL } from "../src/automation/minimax-quota-preflight.js";
import { dispatchProjectLaunch, namedSessionRunner, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";
import { validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "herder-quota-preflight-"));
  dirs.push(cwd);
  vi.stubEnv("AGENT_HERDER_HUMAN_STOP_STORE", join(cwd, "stops.json"));
  const adapters = new Map<string, HarnessAdapter>();
  for (const type of ["opencode", "zcode"] as const) adapters.set(type, {
    type, name: type, async init() {}, async listSessions() { return []; }, async getSession() { return null; },
    createSession: vi.fn(async (options) => ({ id: type, harness: type, cwd, title: options.name, status: "idle", lastActivity: new Date().toISOString() } as AgentSession)),
    changeModel: vi.fn(async () => ({ ok: true })), sendMessage: vi.fn(async () => ({ ok: true, admitted: true })),
    async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
  });
  const policy = validateAutomationLaunchPolicy({ version: 1, allowedHarnesses: ["opencode", "zcode"], preferredHarness: "opencode", models: { opencode: MINIMAX_SUBSCRIPTION_MODEL, zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" }, projectRoutes: { [cwd]: { harnesses: ["opencode", "zcode"], aliases: ["card"] } } });
  return { cwd, adapters, policy, log: new ProjectLaunchAttemptLog(join(cwd, "attempts.json")) };
}

it("recognizes the exact subscription quota code, coalesces concurrent probes, and expires the finite cache", async () => {
  let now = 0;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 4292056 } }), { status: 429 }));
  const probe = createMiniMaxQuotaPreflight({ token: "fixture-key", fetchImpl, cacheMs: 30, now: () => now });
  expect(await Promise.all([probe(MINIMAX_SUBSCRIPTION_MODEL), probe(MINIMAX_SUBSCRIPTION_MODEL)])).toEqual(["quota_exhausted", "quota_exhausted"]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, request] = fetchImpl.mock.calls[0];
  expect(url).toBe("https://www.minimax.io/v1/token_plan/remains");
  expect(request.method).toBe("GET");
  expect(request.body).toBeUndefined();
  now = 31;
  expect(await probe(MINIMAX_SUBSCRIPTION_MODEL)).toBe("quota_exhausted");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it.each([
  { error: { code: 2056 } },
  { base_resp: { status_code: 4292056 } },
])("recognizes verified HTTP429 MiniMax quota envelope %j", async (body) => {
  const probe = createMiniMaxQuotaPreflight({ token: "fixture-key", fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), { status: 429 })) });
  expect(await probe(MINIMAX_SUBSCRIPTION_MODEL)).toBe("quota_exhausted");
});

it("keeps missing auth, a different model, generic rate limits, and ambiguous/time-out probes unknown", async () => {
  const fetchImpl = vi.fn(async () => new Response('{"error":{"code":"rate_limit"}}', { status: 429 }));
  expect(await createMiniMaxQuotaPreflight({ fetchImpl })(MINIMAX_SUBSCRIPTION_MODEL)).toBe("unknown");
  expect(await createMiniMaxQuotaPreflight({ token: "fixture-key", fetchImpl })("other/model")).toBe("unknown");
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await createMiniMaxQuotaPreflight({ token: "fixture-key", fetchImpl })(MINIMAX_SUBSCRIPTION_MODEL)).toBe("unknown");
  const stalled = createMiniMaxQuotaPreflight({ token: "fixture-key", timeoutMs: 10, fetchImpl: vi.fn(() => new Promise<Response>(() => {})) });
  expect(await stalled(MINIMAX_SUBSCRIPTION_MODEL)).toBe("unknown");
});

it("falls back on an explicit route before creating or messaging OpenCode and preserves replay admission", async () => {
  const f = await fixture();
  const probe = vi.fn(async () => "quota_exhausted" as const);
  const run = namedSessionRunner(f.adapters, "repair", probe);
  const input = { policy: f.policy, project: "card", cwd: f.cwd, message: "business task", operationId: "quota" };
  const first = await dispatchProjectLaunch(input, f.log, run);
  expect(first.attempts.map((a) => a.outcome)).toEqual(["quota_exhausted", "accepted"]);
  expect(first.attempts[0]?.result).toMatchObject({ created: false, delivery: "not_attempted", failureCode: "quota_exhausted" });
  expect(f.adapters.get("opencode")!.createSession).not.toHaveBeenCalled();
  expect(f.adapters.get("opencode")!.sendMessage).not.toHaveBeenCalled();
  expect(first.selectedHarness).toBe("zcode");
  expect(await dispatchProjectLaunch(input, new ProjectLaunchAttemptLog(join(f.cwd, "attempts.json")), run)).toEqual(first);
  expect(probe).toHaveBeenCalledTimes(1);
});

it("leaves an unconfigured OpenCode default explicit and never probes or falls back after unknown native admission", async () => {
  const f = await fixture();
  const quota = vi.fn(async () => "quota_exhausted" as const);
  const defaultResult = await dispatchProjectLaunch({ policy: { ...f.policy, projectRoutes: {} }, project: "unconfigured", cwd: f.cwd, message: "business task" }, f.log, namedSessionRunner(f.adapters, "default", quota));
  expect(defaultResult.selectedHarness).toBe("opencode");
  expect(quota).not.toHaveBeenCalled();
  const unknown = vi.fn(async () => "unknown" as const);
  vi.mocked(f.adapters.get("opencode")!.sendMessage).mockResolvedValue({ ok: false, admissionUnknown: true, nonRetryable: true });
  const result = await dispatchProjectLaunch({ policy: f.policy, project: "card", message: "business task", operationId: "unknown" }, f.log, namedSessionRunner(f.adapters, "unknown", unknown));
  expect(result.outcome).toBe("admission_unknown");
  expect(f.adapters.get("zcode")!.createSession).not.toHaveBeenCalled();
});

it.each([
 [0, 69, "quota_exhausted"], [99, 69, "available"], [50, 0, "quota_exhausted"], [undefined, undefined, "unknown"],
])("uses readonly general allowance %s/%s and never a model call", async (interval, weekly, expected) => {
 const fetchImpl = vi.fn(async () => Response.json({ model_remains: [
  { model_name: "general", current_interval_remaining_percent: interval, current_weekly_remaining_percent: weekly },
  { model_name: "video", current_interval_remaining_percent: 0 },
 ] }));
 expect(await createMiniMaxQuotaPreflight({ token: "fixture", fetchImpl })(MINIMAX_SUBSCRIPTION_MODEL)).toBe(expected);
 const [url, request] = fetchImpl.mock.calls[0];
 expect(String(url)).toContain("/token_plan/remains");
 expect(request.method).toBe("GET");
 expect(request.body).toBeUndefined();
});

it("keeps a message-only quota assertion unknown on the read-only endpoint", async () => {
 const probe = createMiniMaxQuotaPreflight({ token: "fixture", fetchImpl: async () => Response.json({ error: { message: "Token Plan usage limit exceeded (2056)" } }, { status: 429 }) });
 expect(await probe(MINIMAX_SUBSCRIPTION_MODEL)).toBe("unknown");
});
