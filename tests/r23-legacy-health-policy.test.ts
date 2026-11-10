import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWebServer } from "../src/web/server.js";
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from "../src/automation/project-launch-dispatch.js";

describe("legacy health endpoint policy", () => {
  it.each(["omniroute/cx/gpt-6-luna", "zai/GLM-new", "minimax-coding-plan/MiniMax-M3.1-Flash"])("admits policy-selected %s", async model => {
    const res = await probe(model, false, "valid");
    expect(res.status).toBe(200);
    expect(res.selected).toBe(model);
  });
  it("denies explicit forbidden model before native execution", async () => {
    const res = await probe("omniroute/cx/gpt-6-luna", true, "valid");
    expect(res.status).toBe(409);
    expect(res.selected).toBeUndefined();
  });
  it.each(["absent", "invalid"] as const)("fails closed for %s policy", async state => {
    const res = await probe("omniroute/cx/gpt-6-luna", false, state);
    expect(res.status).toBe(503);
    expect(res.selected).toBeUndefined();
  });
});

async function probe(model: string, denied: boolean, state: "valid"|"absent"|"invalid") {
  const dir = await mkdtemp(join(tmpdir(), "r23-legacy-"));
  const policy = {version:1 as const, allowedHarnesses:["opencode" as const], preferredHarness:"opencode" as const, models:{opencode:model}, incidentExecution:{runtime:"opencode" as const,provider:"omniroute" as const,model,reasoning:"default" as const,topic:"health" as const}, projectRoutes:{"/workspace/exception":{harnesses:["opencode" as const],models:{opencode:denied?"zai/GLM-new":model},deniedModels:denied?["gpt-*","*/gpt-*"]:[]}}};
  let selected: string | undefined;
  const log = new ProjectLaunchAttemptLog(join(dir,"attempts.json"));
  const run = vi.fn(async (request) => {selected=request.model; return {ok:true,created:true,harness:"opencode" as const,name:"test",cwd:request.cwd,model:request.model,sessionId:"fixture",delivery:"accepted" as const};});
  const store = {load:async()=>state === "valid" ? {kind:"valid",policy} : state === "absent" ? {kind:"absent"} : {kind:"invalid",error:"bad"}};
  const server=createWebServer({adapters:new Map(),converter:{async convert(){throw Error("unused");}},sessionObservationManagedExternally:true,automationLaunchPolicyStore:store as never,projectLaunchDispatch:request=>dispatchProjectLaunch({...request,policy},log,run)});
  try {
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address(); if(!address||typeof address==="string")throw Error("bind");
    const execution={runtime:"opencode",provider:model.startsWith("minimax-")?"minimax-coding-plan":"omniroute",model,reasoning:"default",topic:"health"};
    const response=await fetch(`http://127.0.0.1:${address.port}/api/health/remediation`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({incident_id:"legacy-incident",plan_id:"repair",harness:"opencode",name:"legacy",cwd:"/workspace/exception",message:"fixture",execution,...(denied?{model}: {})})});
    return {status:response.status,selected};
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
}
