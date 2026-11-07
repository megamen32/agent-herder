import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { CodexQuotaBlockedError, type QuotaDecision } from "../src/codex-quota-guard.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { codexRunnerConfig, makeConfiguredAdapter, serveCodexAhap } from "../src/ahap-codex-runner.js";
const rpc = (id:number,method:string,params={}) => ({jsonrpc:"2.0",id,method,params});
async function run(adapter:any,calls:any[]) {
  const input=new PassThrough(),output=new PassThrough();let text="";output.on("data",c=>{text+=c;});
  const serving=serveCodexAhap(adapter,input,output);
  input.end([rpc(1,"initialize",{harness:"codex",ahapVersion:"0.1"}),...calls].map(x=>JSON.stringify(x)).join("\n")+"\n");
  await serving;return text.trim().split("\n").map(x=>JSON.parse(x));
}
it("requires explicit single transport and owner HOME/cwd without inherited socket fallback",()=>{
  const env={HOME:"/tmp/owner",AHAP_CODEX_CWD:"/tmp/project",CODEX_APP_SERVER_SOCKET:"/wrong.sock"};
  expect(()=>codexRunnerConfig(env)).toThrow(/exactly one/);
  expect(codexRunnerConfig({...env,AHAP_CODEX_BIN:"/opt/codex"})).toEqual({socketPath:"",codexBin:"/opt/codex",cwd:"/tmp/project",codexDir:"/tmp/owner/.codex"});
  expect(codexRunnerConfig({...env,AHAP_CODEX_SOCKET:"/tmp/exact.sock",CODEX_HOME:"/tmp/data"})).toMatchObject({socketPath:"/tmp/exact.sock",codexDir:"/tmp/data"});
  expect(()=>codexRunnerConfig({...env,AHAP_CODEX_SOCKET:"/tmp/exact.sock",AHAP_CODEX_BIN:"/opt/codex"})).toThrow(/exactly one/);
  expect(()=>codexRunnerConfig({...env,HOME:"relative",AHAP_CODEX_BIN:"/opt/codex"})).toThrow(/absolute/);
});
it("constructs the existing adapter without starting it",async()=>{
  vi.stubEnv("AHAP_CODEX_SOCKET","/tmp/ahap-test-unconnected.sock");vi.stubEnv("AHAP_CODEX_BIN",undefined);vi.stubEnv("AHAP_CODEX_CWD","/tmp");
  try {const adapter=makeConfiguredAdapter();expect(adapter).toBeInstanceOf(CodexAppServerAdapter);await adapter.dispose();} finally {vi.unstubAllEnvs();}
});
it("forwards existing-session delivery modes and native turn receipts verbatim",async()=>{
  const receipt={ok:true,admitted:true,inputId:"caller-17",turnId:"native-turn-9"};
  const adapter={sendMessage:vi.fn(async()=>receipt),dispose:vi.fn()};
  const options={message:"exact",queue:false,steer:true,inputId:"caller-17",activeTurnOnly:true,origin:"automation"};
  const replies=await run(adapter,[rpc(2,"sendMessage",{id:"existing",options}),rpc(3,"shutdown")]);
  expect(adapter.sendMessage).toHaveBeenCalledExactlyOnceWith("existing",options);
  expect(replies[1].result).toEqual(receipt);expect(replies[1].result.nativeInputMessageId).toBeUndefined();
  expect(adapter.dispose).toHaveBeenCalledTimes(1);
});
it("exposes legacy discovery/raw bytes and does not claim unavailable projects",async()=>{
  const raw={bytes:new Uint8Array([0,255,10]),complete:true,source:{kind:"native-file",location:"fixture",format:"jsonl"},timestampCoverage:"native"};
  const adapter={listSessions:vi.fn(async()=>[]),getRawTranscript:vi.fn(async()=>raw)};
  const replies=await run(adapter,[rpc(2,"listSessions",{options:{limit:3}}),rpc(3,"getRawTranscript",{id:"existing"})]);
  expect(replies[0].result.capabilities.methods).toContain("getRawTranscript");expect(replies[0].result.capabilities.methods).not.toContain("listProjects");
  expect(adapter.listSessions).toHaveBeenCalledWith({limit:3});expect(replies[2].result).toEqual({bytes_base64:"AP8K",complete:true,source:raw.source,timestampCoverage:"native"});
});
it("sanitizes mutation exception with corrective context and never automatically retries",async()=>{
  const adapter={sendMessage:vi.fn(async()=>{throw new Error("Bearer SECRET https://private/?token=secret");})};
  const replies=await run(adapter,[rpc(2,"sendMessage",{id:"existing",options:{message:"one",queue:true,inputId:"stable"}})]);
  expect(adapter.sendMessage).toHaveBeenCalledTimes(1);expect(replies[1].error.data).toMatchObject({outcome:"unknown",retryable:false,method:"sendMessage"});
  expect(replies[1].error.data.correctiveAction).toContain("Do not repeat");expect(JSON.stringify(replies)).not.toContain("SECRET");
});

it("AHAP uses the real legacy Unix socket transport and its receipt journal without replay", async () => {
  const {createServer}=await import("node:http");
  const {WebSocketServer}=await import("ws");
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const root=await mkdtemp(join(tmpdir(),"ahap-codex-wire-"));
  const server=createServer(), sockets=new WebSocketServer({server});
  const wire:Array<{method:string;params:any}>=[];
  sockets.on("connection",socket=>socket.on("message",data=>{
    const request=JSON.parse(data.toString());wire.push(request);
    const reply=(result:unknown)=>{if(request.id!==undefined)socket.send(JSON.stringify({id:request.id,result}));};
    if(request.method==="initialize")return reply({userAgent:"fixture"});
    if(request.method==="thread/read")return reply({thread:{id:"existing",cwd:root,name:"exact",status:{type:"active",activeFlags:[]}}});
    if(request.method==="thread/turns/list")return reply({data:[{id:"native-turn-exact",status:"inProgress"}],nextCursor:null});
    if(request.method==="turn/steer")return reply({turnId:"native-turn-exact"});
    reply({});
  }));
  await new Promise<void>(resolve=>server.listen(join(root,"control.sock"),resolve));
  const adapter=new CodexAppServerAdapter({socketPath:join(root,"control.sock"),codexBin:"/must-not-spawn",codexDir:root,requestTimeoutMs:500,quotaReader:async()=>({rateLimits:{primary:{usedPercent:0}}})});
  // Isolate the optional local archive enrichment; every native request still
  // traverses the real adapter and a real Unix WebSocket connection.
  vi.spyOn((adapter as any).rawTranscriptAdapter,"getSessionObservation").mockResolvedValue(null);
  try {
    const options={message:"second input",queue:false,steer:true,activeTurnOnly:true,inputId:"stable-wire-input",origin:"human"};
    const replies=await run(adapter,[rpc(2,"init"),rpc(3,"sendMessage",{id:"existing",options}),rpc(4,"sendMessage",{id:"existing",options}),rpc(5,"shutdown")]);
    expect(replies[2].result).toEqual({ok:true,admitted:true,turnId:"native-turn-exact",inputId:"stable-wire-input"});
    expect(replies[3].result).toEqual(replies[2].result);
    expect(wire.filter(r=>r.method==="turn/steer")).toEqual([expect.objectContaining({params:{threadId:"existing",expectedTurnId:"native-turn-exact",input:[{type:"text",text:"second input"}]}})]);
    expect(wire.some(r=>r.method==="turn/start")).toBe(false);
  } finally {
    await adapter.dispose();for(const socket of sockets.clients)socket.terminate();
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});

it.each([false, true])("idle Codex queue with activeTurnOnly=%s uses the legacy socket semantics without duplicate effects", async (activeTurnOnly) => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "ahap-codex-idle-"));
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const wire: Array<{ method: string; params: any }> = [];
  let starts = 0;
  const idleThread = { id: "existing-idle", cwd: root, name: "idle fixture", status: { type: "idle" } };
  sockets.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(data.toString());
    wire.push(request);
    const reply = (result: unknown) => {
      if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result }));
    };
    if (request.method === "initialize") return reply({ userAgent: "isolated-idle-fixture" });
    if (request.method === "initialized") return;
    if (request.method === "thread/read" || request.method === "thread/resume") return reply({ thread: idleThread });
    if (request.method === "thread/turns/list") return reply({ data: [], nextCursor: null });
    if (request.method === "turn/start") {
      starts++;
      return reply({ turn: { id: `idle-native-turn-${starts}`, status: "inProgress" } });
    }
    // No permissive fallback can silently approve an unexpected native mutation.
    if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "Unexpected fixture method" } }));
  }));
  await new Promise<void>(resolve => server.listen(join(root, "control.sock"), resolve));
  const adapter = new CodexAppServerAdapter({
    socketPath: join(root, "control.sock"), codexBin: "/must-not-spawn",
    codexDir: root, requestTimeoutMs: 500,
    quotaReader: async () => ({ rateLimits: { primary: { usedPercent: 0 } } }),
  });
  // Only archive enrichment is stubbed. Native init/read/resume/start and the
  // durable inputId receipt journal are the real legacy implementation.
  vi.spyOn((adapter as any).rawTranscriptAdapter, "getSessionObservation").mockResolvedValue(null);
  try {
    const options = { message: "start this idle session once", queue: true, activeTurnOnly, inputId: "stable-idle-input", origin: "automation" };
    const replies = await run(adapter, [
      rpc(2, "init"),
      rpc(3, "sendMessage", { id: idleThread.id, options }),
      rpc(4, "sendMessage", { id: idleThread.id, options }),
      rpc(5, "shutdown"),
    ]);
    expect(replies[1].result).toBeNull();
    expect(replies[3].result).toEqual(replies[2].result);
    expect(replies[4].result).toBeNull();
    expect(wire.some(request => request.method === "turn/steer")).toBe(false);
    if (activeTurnOnly) {
      expect(replies[2].result).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true });
      expect(replies[2].result.error).toContain("skipped_inactive");
      expect(starts).toBe(0);
      expect(wire.some(request => request.method === "thread/resume")).toBe(false);
    } else {
      expect(replies[2].result).toEqual({ ok: true, admitted: true, turnId: "idle-native-turn-1", inputId: options.inputId });
      expect(starts).toBe(1);
      expect(wire.filter(request => request.method === "thread/resume")).toEqual([
        expect.objectContaining({ params: { threadId: idleThread.id } }),
      ]);
      expect(wire.filter(request => request.method === "turn/start")).toEqual([
        expect.objectContaining({ params: { threadId: idleThread.id, input: [{ type: "text", text: options.message }], model: null } }),
      ]);
    }
  } finally {
    await adapter.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

const quotaDecision = (reason: string): QuotaDecision => ({ allowed: false, reason, remainingPercent: null, windows: [], checkedAt: "2026-11-08T00:00:00Z" });
for (const reason of ["provider_denied", "below_reserve", "quota_snapshot_expired", "quota_unknown", "quota_policy_unavailable"]) {
  it(`FIXQ classifies typed createSession thread/start refusal with allowlisted reason ${reason}`, async () => {
    const cause = new CodexQuotaBlockedError(quotaDecision(reason), "thread/start");
    cause.message = "PRIVATE raw exception payload";
    const createSession = vi.fn(async () => { throw cause; });
    const replies = await run({ createSession }, [rpc(2, "createSession", { options: { name: "quota-fixture", cwd: "/tmp" } })]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(replies[1].error.code).toBe(-32000);
    expect(replies[1].error.data).toEqual({ outcome: "not_submitted", admitted: false, notSubmitted: true, retryable: false,
      code: "codex_quota_guard", method: "createSession", operation: "thread/start", reason });
    expect(JSON.stringify(replies)).not.toContain("PRIVATE");
  });
}
for (const [label, method, cause] of [
  ["ordinary error", "createSession", new Error("PRIVATE raw error")],
  ["duck type", "createSession", { name: "CodexQuotaBlockedError", code: "codex_quota_guard", notSubmitted: true, admitted: false, operation: "thread/start", decision: quotaDecision("below_reserve") }],
  ["other operation", "createSession", new CodexQuotaBlockedError(quotaDecision("below_reserve"), "turn/start")],
  ["other mutation", "sendMessage", new CodexQuotaBlockedError(quotaDecision("below_reserve"), "thread/start")],
  ["unrecognized reason", "createSession", new CodexQuotaBlockedError(quotaDecision("PRIVATE invented reason"), "thread/start")],
] as const) {
  it(`FIXQ keeps ${label} UNKNOWN without replay or raw text`, async () => {
    const call = vi.fn(async () => { throw cause; });
    const params = method === "createSession" ? { options: { name: "quota-fixture", cwd: "/tmp" } }
      : { id: "fixture-only", options: { message: "fixture", queue: true, inputId: "fixture-only" } };
    const replies = await run({ [method]: call }, [rpc(2, method, params)]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(replies[1].error).toMatchObject({ code: -32000, data: { outcome: "unknown", retryable: false, method } });
    expect(replies[1].error.data.notSubmitted).toBeUndefined();
    expect(JSON.stringify(replies)).not.toContain("PRIVATE");
  });
}
