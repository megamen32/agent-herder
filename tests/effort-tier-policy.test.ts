import { expect, it } from "vitest";
import { CreateSessionSchema, ChangeModelSchema } from "../src/mcp-tools/definitions.js";

it("retains the requested effort and task class at create ingress", () => {
  const input = { harness: "codex", cwd: "/tmp", name: "review", reasoningEffort: "low", taskClass: "review" };
  expect(CreateSessionSchema.parse(input)).toMatchObject(input);
});

it("rejects unhandled fields on model set", () => {
  expect(ChangeModelSchema.safeParse({ harness: "codex", model: "test", effort: "high" }).success).toBe(false);
});

import { chooseSettings, classifyTask } from "../src/effort-tier-policy.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const model = {
  model: "fixture", supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({reasoningEffort})),
  serviceTiers: [{id: "priority"}],
};

it("bounds defaults by the model vocabulary and requires quota and latency intent for Fast", () => {
  expect(chooseSettings({}, "investigation", model, true)).toMatchObject({reasoningEffort:"low", serviceTier:"normal"});
  expect(chooseSettings({latencySensitive:true}, "debug", model, false)).toMatchObject({reasoningEffort:"high", serviceTier:"normal", tierReason:"reserve_unavailable"});
  expect(chooseSettings({latencySensitive:true}, "judge", model, true)).toMatchObject({reasoningEffort:"low", serviceTier:"fast"});
  expect(chooseSettings({}, "edit", model, true)).toMatchObject({reasoningEffort:"low", effortReason:"model_capability"});
  expect(chooseSettings({reasoningEffort:"low",serviceTier:"normal"}, "architecture", model, true)).toMatchObject({reasoningEffort:"low",effortReason:"caller",serviceTier:"normal"});
  expect(chooseSettings({}, "edit", undefined, true).reasoningEffort).toBeUndefined();
  expect(() => chooseSettings({reasoningEffort:"medium"}, "edit", model, true)).toThrow(/does not advertise/);
});

it("sends thread and turn policy through native RPC and returns observed settings independently", async () => {
  const adapter = new CodexAppServerAdapter({socketPath:"/unused",quotaReader:async()=>({rateLimits:{primary:{usedPercent:5}}})});
  const native = adapter as any;
  const calls: {method:string; params:any}[] = [];
  const thread = {id:"policy-thread", model:"fixture", modelProvider:"openai", status:"idle",cwd:"/tmp"};
  const snapshot = {thread, model:"fixture", reasoningEffort:"low", serviceTier:"default", approvalPolicy:"never", sandbox:{type:"workspaceWrite"}};
  native.ensureReady = async () => undefined;
  native.isReady = () => true;
  native.request = async (method:string, params:any) => {
    calls.push({method,params});
    switch (method) {
      case "model/list": return {data:[model]};
      case "thread/start": case "thread/read": case "thread/resume": return snapshot;
      case "thread/loaded/list": return {data:[thread.id]};
      case "thread/name/set": return {};
      case "turn/start": return {turn:{id:"new-turn"}};
      default: throw new Error(method);
    }
  };
  try {
    const session = await adapter.createSession({name:"inspect files",cwd:"/tmp",model:"fixture", reasoningEffort:"high"});
    expect(calls.find(c => c.method === "thread/start")?.params).toMatchObject({config:{model_reasoning_effort:"high"}, serviceTier:"default"});
    expect(session.meta).toMatchObject({settingsDecision:{reasoningEffort:"high"},effectiveSettings:{reasoningEffort:"low",serviceTier:"normal"}});
    native.getSession = async () => session;
    const sent = await adapter.sendMessage(thread.id,{message:"inspect files",origin:"human",queue:true,latencySensitive:true});
    expect(sent).toMatchObject({ok:true,settingsDecision:{reasoningEffort:"low",serviceTier:"fast"}});
    expect(calls.find(c => c.method === "turn/start")?.params).toMatchObject({effort:"low",serviceTierForTurn:"fast"});
    expect(await adapter.getSessionSettings(thread.id)).toEqual({model:"fixture",reasoningEffort:"low",serviceTier:"normal",sandbox:snapshot.sandbox,approvalPolicy:"never"});
    expect(await adapter.changeModel(thread.id,"other")).toMatchObject({ok:false,effectiveSettings:{model:"fixture"}});
  } finally { await adapter.dispose(); }
});


it("selects Fast automatically for incident triage and honors an explicit latency opt-out", () => {
  const task = classifyTask("Incident triage for an unavailable service");
  expect(chooseSettings({}, task, model, true)).toMatchObject({taskClass:"triage",serviceTier:"fast"});
  expect(chooseSettings({latencySensitive:false}, task, model, true).serviceTier).toBe("normal");
});
