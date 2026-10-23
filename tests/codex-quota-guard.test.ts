import {describe,it,expect,afterEach,vi} from "vitest";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {evaluateCodexQuota,DEFAULT_CODEX_QUOTA_POLICY,validateCodexQuotaPolicy,loadCodexQuotaPolicy,saveCodexQuotaPolicy,checkCodexQuota,CodexQuotaBlockedError,assertRemoteCodexAdmission} from "../src/codex-quota-guard.js";
import {CodexAppServerAdapter} from "../src/adapters/codex-app-server.js";
const policy={...DEFAULT_CODEX_QUOTA_POLICY};
const sample=(used:number)=>({rateLimits:{primary:{usedPercent:used,windowDurationMins:300}}});
afterEach(()=>vi.unstubAllEnvs());
describe("Codex quota reserve",()=>{
 it.each([[81,false],[80,true],[79,true],[100,false],[0,true]])("used %s admits %s",(used,allowed)=>expect(evaluateCodexQuota(sample(used),policy).allowed).toBe(allowed));
 it("uses the lowest remaining window, including a native secondary bucket",()=>{
  const x=evaluateCodexQuota({rateLimitsByLimitId:{codex:{primary:{usedPercent:1},secondary:{usedPercent:86}},special:{primary:{usedPercent:2}}}},policy);
  expect(x.allowed).toBe(false);expect(x.remainingPercent).toBe(14);
 });
 it("keeps a missing secondary window optional",()=>expect(evaluateCodexQuota({primary_used:15,secondary_window:null},policy).allowed).toBe(true));
 it.each([{}, {error:"offline"},{primary_used:"10"},{primary_used:NaN},{primary_used:-1},{primary_used:101}])("fails closed on unknown or invalid readings %j",raw=>expect(evaluateCodexQuota(raw,policy).allowed).toBe(false));
 it("unknown allow is explicit, but cannot override a proven low window",()=>{
  expect(evaluateCodexQuota({}, {...policy,onUnknown:"allow"}).allowed).toBe(true);
  expect(evaluateCodexQuota({rateLimits:{primary:{usedPercent:90},secondary:{usedPercent:"?"}}},{...policy,onUnknown:"allow"}).allowed).toBe(false);
 });
 it("backend refusal beats percentage and unknown policy",()=>expect(evaluateCodexQuota({...sample(1),ordinaryUsageAllowed:false},{...policy,onUnknown:"allow"}).allowed).toBe(false));
 it("never infers a reset from an expired snapshot",()=>expect(evaluateCodexQuota({primary_window:{used_percent:0,reset_at:1}},policy).reason).toBe("quota_snapshot_expired"));
 it("validates updates strictly",()=>{
  expect(()=>validateCodexQuotaPolicy({...policy,minRemainingPercent:101})).toThrow();
  expect(()=>validateCodexQuotaPolicy({...policy,minRemainingPercent:"20"})).toThrow();
  expect(()=>validateCodexQuotaPolicy({...policy,extra:true})).toThrow();
 });
 it("persists across instances and rejects stale settings edits",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"quota-policy-"));const path=join(dir,"guard.json");
  try {const a=await loadCodexQuotaPolicy(path);expect(a.policy.minRemainingPercent).toBe(20);
   await saveCodexQuotaPolicy({...policy,minRemainingPercent:25},a.revision,path);
   expect((await loadCodexQuotaPolicy(path)).policy.minRemainingPercent).toBe(25);
   await expect(saveCodexQuotaPolicy(policy,a.revision,path)).rejects.toThrow("conflict");
   await writeFile(path,"invalid");expect((await checkCodexQuota(async()=>sample(0),path)).decision.allowed).toBe(false);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it("native admission gates all consuming methods before the transport write; reads and interruption stay available",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"quota-native-"));vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR",dir);
  try {
   const a=new CodexAppServerAdapter({});const x=a as any;const calls:string[]=[];
   x.isTransportWritable=()=>true;
   x.writeMessage=(m:any)=>{calls.push(m.method);const p=x.pending.get(m.id);clearTimeout(p.timer);x.pending.delete(m.id);p.resolve(m.method==="account/rateLimits/read"?sample(86):{ok:true});};
   for(const method of ["thread/start","thread/fork","turn/start","turn/steer"])await expect(x.request(method,{})).rejects.toBeInstanceOf(CodexQuotaBlockedError);
   expect(calls).toEqual(Array(4).fill("account/rateLimits/read"));
   await expect(x.request("thread/read",{})).resolves.toEqual({ok:true});
   await expect(x.request("turn/interrupt",{})).resolves.toEqual({ok:true});
   expect(calls.slice(-2)).toEqual(["thread/read","turn/interrupt"]);
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});

describe("Codex quota history fallback",()=>{
 const historyRecord=(ts:number,quota:Record<string,unknown>={primary:24,allowed:true,limit_reached:false})=>JSON.stringify({ts,quota});
 async function withHistory(records:string[],run:(path:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),"quota-history-"));const path=join(dir,"history.jsonl");
  vi.stubEnv("QUOTA_LENS_HISTORY",path);
  try{await writeFile(path,records.join("\n")+"\n");await run(path);}finally{await rm(dir,{recursive:true,force:true});}
 }
 it("admits after transient local quota fetch failure with a recent allowed sample",async()=>{
  await withHistory([historyRecord(Math.floor(Date.now()/1000)-60)],async()=>{
   const result=await checkCodexQuota(async()=>({error:"fetch failed"}));
   expect(result.decision).toMatchObject({allowed:true,reason:"reserve_available"});
  });
 });
 it.each([
  ["stale",(now:number)=>historyRecord(now-301)],
  ["host mismatch",(now:number)=>JSON.stringify({ts:now-30,host:"some-other-host",quota:{primary:24,allowed:true,limit_reached:false}})],
  ["limit reached",(now:number)=>historyRecord(now-30,{primary:24,allowed:true,limit_reached:true})],
 ])("keeps admission blocked for %s history",async(_name,make)=>{
  await withHistory([make(Math.floor(Date.now()/1000))],async()=>{
   const result=await checkCodexQuota(async()=>({error:"fetch failed"}));
   expect(result.decision.allowed).toBe(false);
  });
 });
 it("prefers a successful live read over a recent history sample",async()=>{
  await withHistory([historyRecord(Math.floor(Date.now()/1000)-30)],async()=>{
   const result=await checkCodexQuota(async()=>sample(86));
   expect(result.decision).toMatchObject({allowed:false,reason:"below_reserve"});
  });
 });
 it("never applies the local history to remote Codex admission",async()=>{
  await withHistory([historyRecord(Math.floor(Date.now()/1000)-30)],async()=>{
   const dir=await mkdtemp(join(tmpdir(),"quota-remote-history-"));vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR",dir);
   try{
    const read=async()=>({content:[{type:"text",text:JSON.stringify({providers:[{provider:"codex",state:"unknown"}]})}]});
    await expect(assertRemoteCodexAdmission("create_session",{harness:"codex"},read)).rejects.toBeInstanceOf(CodexQuotaBlockedError);
   }finally{await rm(dir,{recursive:true,force:true});}
  });
 });
});

it("fleet uses the addressed provider and does not fetch or gate a non-Codex action",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"quota-fleet-"));vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR",dir);
 try{
  const read=vi.fn(async()=>({content:[{type:"text",text:JSON.stringify({providers:[{provider:"codex",state:"reported",details:{primary_used:86}}]})}]}));
  await expect(assertRemoteCodexAdmission("create_session",{harness:"codex"},read)).rejects.toBeInstanceOf(CodexQuotaBlockedError);
  expect(read).toHaveBeenCalledTimes(1);
  await assertRemoteCodexAdmission("create_session",{harness:"minimax-code"},read);
  await assertRemoteCodexAdmission("stop",{harness:"codex"},read);
  expect(read).toHaveBeenCalledTimes(1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("thread/resume is gated as well: a continuation cannot spend the reserve",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"quota-resume-"));vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR",dir);
 try{
  const a=new CodexAppServerAdapter({});const x=a as any;const calls:string[]=[];
  x.isTransportWritable=()=>true;
  x.writeMessage=(m:any)=>{calls.push(m.method);const p=x.pending.get(m.id);clearTimeout(p.timer);x.pending.delete(m.id);p.resolve(m.method==="account/rateLimits/read"?sample(86):{ok:true});};
  await expect(x.request("thread/resume",{})).rejects.toBeInstanceOf(CodexQuotaBlockedError);
  expect(calls).toEqual(["account/rateLimits/read"]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

it("a refused resume is not submitted and must not be replayed",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"quota-refusal-"));vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR",dir);
 try{
  const a=new CodexAppServerAdapter({});const x=a as any;
  x.isReady=()=>true;
  x.isTransportWritable=()=>true;
  x.writeMessage=(m:any)=>{const p=x.pending.get(m.id);clearTimeout(p.timer);x.pending.delete(m.id);p.resolve(m.method==="account/rateLimits/read"?sample(86):{ok:true});};
  const result=await a.resumeSession("thread-quota-1");
  expect(result.ok).toBe(false);
  expect(result).toMatchObject({notSubmitted:true,admitted:false,nonRetryable:true,admissionUnknown:false});
  expect(String((result as any).error)).toContain("codex_quota_guard");
 }finally{await rm(dir,{recursive:true,force:true});}
});
