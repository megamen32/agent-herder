import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import type { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { serveOpenCodeAhap } from "../src/ahap-opencode-runner.js";

async function run(adapter: Partial<OpenCodeAdapter>, requests: unknown[], family: "v2" | "v22" = "v22") {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => chunks.push(chunk));
  const completed = serveOpenCodeAhap(adapter as OpenCodeAdapter, input, output, family);
  input.end(requests.map((request) => JSON.stringify(request)).join("\n") + "\n");
  await completed;
  return chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
}

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "opencode", ahapVersion: "0.1" } };

it("rejects JSON primitives and arrays as invalid requests, then keeps serving", async () => {
  let adapterCalls = 0;
  const adapter = {
    async init() { adapterCalls += 1; },
    async createSession() { adapterCalls += 1; return {} as never; },
    async sendMessage() { adapterCalls += 1; return {} as never; },
    async getSession() { adapterCalls += 1; return null; },
    async getSessionMessages() { adapterCalls += 1; return null; },
  };
  const replies = await run(adapter, [null, "primitive", [], initialize, { jsonrpc: "2.0", id: 2, method: "init" }, { jsonrpc: "2.0", id: 3, method: "shutdown" }]);

  expect(replies.slice(0, 3)).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
  ]);
  expect(replies[3].result.harness).toBe("opencode");
  expect(replies[4].result).toBeNull();
  expect(adapterCalls).toBe(1);
});

it("maps create, one initial Start and exact read results without rewriting receipts", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    async init() { calls.push({ method: "init", args: [] }); },
    async createSession(options: unknown) {
      calls.push({ method: "createSession", args: [options] });
      return { id: "ses_created_exact", harness: "opencode", status: "idle", title: "worker", cwd: "/tmp/work", hostId: "fixture" };
    },
    async sendMessage(id: string, options: unknown) {
      calls.push({ method: "sendMessage", args: [id, options] });
      return { ok: true, admitted: true, pending: true, inputId: "caller-input-17", nativeInputMessageId: "msg_native17" };
    },
    async getSession(id: string) {
      calls.push({ method: "getSession", args: [id] });
      return { id, harness: "opencode", status: "running", title: "worker", cwd: "/tmp/work", hostId: "fixture" };
    },
    async getSessionMessages(id: string, limit?: number) {
      calls.push({ method: "getSessionMessages", args: [id, limit] });
      return [{ id: "msg_native17", role: "user", inputId: "caller-input-17", turnId: "turn_17", text: "do work", parts: [{ type: "text", text: "do work" }] }];
    },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "init" },
    { jsonrpc: "2.0", id: 3, method: "createSession", params: { options: { name: "worker", cwd: "/tmp/work" } } },
    { jsonrpc: "2.0", id: 4, method: "sendMessage", params: { id: "ses_created_exact", options: { message: "do work", queue: false, inputId: "caller-input-17" } } },
    { jsonrpc: "2.0", id: 8, method: "sendMessage", params: { id: "ses_created_exact", options: { message: "must not replay", queue: false, inputId: "caller-input-18" } } },
    { jsonrpc: "2.0", id: 5, method: "getSession", params: { id: "ses_created_exact" } },
    { jsonrpc: "2.0", id: 6, method: "getSessionMessages", params: { id: "ses_created_exact", limit: 50 } },
    { jsonrpc: "2.0", id: 7, method: "shutdown" },
  ]);

  expect(replies[0].result.capabilities.methods).toEqual(["init", "createSession", "sendMessage", "getSession", "getSessionMessages"]);
  expect(replies[0].result.capabilities.controlCapabilities).toMatchObject({ events: false, steer: false });
  expect(replies[0].result.capabilities.deliveryModes).toEqual(["start"]);
  expect(replies[2].result.id).toBe("ses_created_exact");
  expect(replies[3].result).toMatchObject({ inputId: "caller-input-17", nativeInputMessageId: "msg_native17", admitted: true });
  expect(replies[3].result.inputId).not.toBe(replies[3].result.nativeInputMessageId);
  expect(replies[4].error.code).toBe(-32602);
  expect(replies[5].result.id).toBe("ses_created_exact");
  expect(replies[6].result[0]).toMatchObject({ id: "msg_native17", inputId: "caller-input-17", turnId: "turn_17" });
  const send = calls.find((call) => call.method === "sendMessage")!;
  expect(send.args[0]).toBe("ses_created_exact");
  expect(send.args[1]).toMatchObject({ queue: false, start: true, activeTurnOnly: true, inputId: "caller-input-17" });
  expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
});

it("returns an UNKNOWN error after a lost mutating call and never invokes a fallback", async () => {
  let submits = 0;
  const adapter = {
    async init() {},
    async createSession() { return { id: "ses_exact", harness: "opencode", status: "idle", title: "worker", cwd: "/tmp/work", hostId: "fixture" }; },
    async sendMessage() { submits += 1; throw new Error("response lost after native queue"); },
    async getSession() { return null; },
    async getSessionMessages() { return null; },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "createSession", params: { options: { name: "worker", cwd: "/tmp/work" } } },
    { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "ses_exact", options: { message: "one input", queue: false, inputId: "input-once" } } },
    { jsonrpc: "2.0", id: 4, method: "sendMessage", params: { id: "ses_exact", options: { message: "one input", queue: false, inputId: "input-once" } } },
    { jsonrpc: "2.0", id: 5, method: "shutdown" },
  ]);

  expect(submits).toBe(1);
  expect(replies[2].error).toMatchObject({ code: -32000, data: { outcome: "unknown", retryable: false } });
  expect(replies[3].error.code).toBe(-32602);
});

it("rejects unsupported delivery before calling the adapter and does not invent a native receipt", async () => {
  let submits = 0;
  const adapter = {
    async init() {},
    async createSession() { return { id: "ses_receipt_missing", harness: "opencode", status: "idle", title: "worker", cwd: "/tmp/work", hostId: "fixture" }; },
    async sendMessage(_id: string, _options: unknown) {
      submits += 1;
      return { ok: true, admitted: true, pending: true, inputId: "caller-input" };
    },
    async getSession() { return null; },
    async getSessionMessages() { return null; },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "createSession", params: { options: { name: "worker", cwd: "/tmp/work" } } },
    { jsonrpc: "2.0", id: 3, method: "sendMessage", params: { id: "ses_receipt_missing", options: { message: "queue unsupported", queue: true, inputId: "input" } } },
    { jsonrpc: "2.0", id: 4, method: "sendMessage", params: { id: "ses_receipt_missing", options: { message: "accepted, receipt absent", queue: false, inputId: "caller-input" } } },
    { jsonrpc: "2.0", id: 5, method: "sendMessage", params: { id: "ses_receipt_missing", options: { message: "never replay", queue: false, inputId: "caller-input" } } },
    { jsonrpc: "2.0", id: 6, method: "shutdown" },
  ]);

  expect(replies[2].error.code).toBe(-32602);
  expect(replies[3].error).toMatchObject({ code: -32000, data: { outcome: "unknown", retryable: false } });
  expect(replies[4].error.code).toBe(-32602);
  expect(submits).toBe(1);
});

it("v2 forwards a second delivery to an existing session with exact mode and caller inputId", async () => {
  const input=new PassThrough(),output=new PassThrough();let text="";output.on("data",c=>{text+=c;});
  const calls:unknown[]=[];
  const adapter={async sendMessage(id:string,options:any){calls.push([id,options]);return {ok:true,admitted:true,inputId:options.inputId,nativeInputMessageId:"msg_real17"};}};
  const serving=serveOpenCodeAhap(adapter as OpenCodeAdapter,input,output,"v2");
  const options={message:"second",queue:false,steer:true,inputId:"caller-second",activeTurnOnly:true};
  input.end([initialize,{jsonrpc:"2.0",id:2,method:"sendMessage",params:{id:"existing-before-runner",options}}].map(x=>JSON.stringify(x)).join("\n")+"\n");
  await serving;const replies=text.trim().split("\n").map(x=>JSON.parse(x));
  expect(calls).toEqual([["existing-before-runner",options]]);
  expect(replies[1].result).toMatchObject({inputId:"caller-second",nativeInputMessageId:"msg_real17"});
  expect(replies[0].result.capabilities.deliveryModes).toEqual(["queue","steer","start"]);
});

it("v2 exposes same-session resume and recover without selecting a model", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const adapter = {
    async resumeSession(id: string) { calls.push({ method: "resumeSession", args: [id] }); return { ok: true }; },
    async recover(id: string, message?: string) { calls.push({ method: "recover", args: [id, message] }); return { ok: true }; },
  };
  const replies = await run(adapter, [
    initialize,
    { jsonrpc: "2.0", id: 2, method: "resumeSession", params: { id: "ses_failed" } },
    { jsonrpc: "2.0", id: 3, method: "recover", params: { id: "ses_failed", message: "Продолжи текущую задачу в этой же сессии." } },
    { jsonrpc: "2.0", id: 4, method: "shutdown" },
  ], "v2");

  expect(replies[0].result.capabilities.methods).toEqual(expect.arrayContaining(["resumeSession", "recover"]));
  expect(replies[0].result.capabilities.controlCapabilities).toMatchObject({ resume: true, recover: true, modelSwitch: false });
  expect(replies[1].result).toEqual({ ok: true });
  expect(replies[2].result).toEqual({ ok: true });
  expect(calls).toEqual([
    { method: "resumeSession", args: ["ses_failed"] },
    { method: "recover", args: ["ses_failed", "Продолжи текущую задачу в этой же сессии."] },
  ]);
});

it('pins an instance model on create and send, and rejects conflicting requests before effects', async () => {
  const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',c=>{text+=c;});
  const calls:Array<{method:string;options:any}>=[];
  const adapter={async createSession(options:any){calls.push({method:'create',options});return {id:'ses_model',cwd:options.cwd};},async sendMessage(_id:string,options:any){calls.push({method:'send',options});return {ok:true,admitted:true,nativeInputMessageId:'msg_abc'};}};
  const serving=serveOpenCodeAhap(adapter as OpenCodeAdapter,input,output,'v2','minimax-coding-plan/MiniMax-M3.1-Flash');
  input.end([initialize,
    {jsonrpc:'2.0',id:2,method:'createSession',params:{options:{name:'worker',cwd:'/tmp/work'}}},
    {jsonrpc:'2.0',id:3,method:'sendMessage',params:{id:'ses_model',options:{message:'one',queue:true,inputId:'a'}}},
    {jsonrpc:'2.0',id:4,method:'createSession',params:{options:{name:'bad',cwd:'/tmp/work',model:'other/model'}}},
    {jsonrpc:'2.0',id:5,method:'sendMessage',params:{id:'ses_model',options:{message:'bad',queue:true,inputId:'b',model:'other/model'}}},
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');await serving;
  const replies=text.trim().split('\n').map(x=>JSON.parse(x));
  expect(calls).toHaveLength(2);expect(calls[0].options.model).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');expect(calls[1].options.model).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');expect(replies[3].error.code).toBe(-32602);expect(replies[4].error.code).toBe(-32602);
});
