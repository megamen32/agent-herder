import { describe, expect, it } from "vitest";
import { normalizeSessionReference, parseSessionReference } from "../src/session-reference.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { findSession } from "../src/mcp-tools/handlers.js";

describe("session references", () => {
  const id = "01a1ac02-7593-7522-be82-2d03583393b0";
  it.each([
    [id, {id}],
    [`codex:${id}`, {id, harness:"codex"}],
    [`codex::${id}`, {id, harness:"codex"}],
    [`https://agent.bezrabotnyi.com/?from=lhc#/session/codex%3A${id}`, {id, harness:"codex"}],
    [`codex://threads/${id}?hostId=remote-ssh-discovered%3A104.bezrabotnyi.com`, {id, harness:"codex", hostId:"remote-ssh-discovered:104.bezrabotnyi.com"}],
  ])("parses %s", (input, expected) => expect(parseSessionReference(input)).toEqual(expected));
  it("rejects conflicting explicit identity instead of routing to the wrong session", () => {
    expect(() => normalizeSessionReference({sessionId:`codex:${id}`, harness:"opencode"})).toThrow("session_reference_harness_conflict");
  });
  it("resolves a URL through the registered agent_info handler", async () => {
    const callbacks = new Map<string, Function>(); const events = new HerderEventBus();
    const session = {id,harness:"codex",status:"idle",title:"fixture",cwd:"/tmp",lastActivity:new Date().toISOString(),needsPermission:false};
    const adapter = {type:"codex",getSession:async (asked:string) => asked === id ? session : null};
    registerSessionTools({registerTool:(name:string,_schema:unknown,fn:Function)=>callbacks.set(name,fn)} as never,
      {adapters:new Map([["codex",adapter as never]]),events,jobs:new HerderJobRegistry(events),routingPeers:[]});
    const result = await callbacks.get("agent_info")!({sessionId:`https://agent.bezrabotnyi.com/#/session/codex%3A${id}`});
    expect(result.structuredContent.session.id).toBe(id);
  });
  it("does not silently select the first adapter when native IDs collide", async () => {
    const make = (harness:string) => ({getSession:async () => ({id,harness,title:harness,cwd:"/tmp",status:"idle",lastActivity:"2026-11-05T00:00:00Z"})}) as never;
    await expect(findSession(new Map([["codex",make("codex")],["opencode",make("opencode")]]),id)).rejects.toThrow("session_ambiguous");
  });
  it("returns both candidate identities from agent_info without selecting one", async () => {
    const callbacks=new Map<string,Function>(); const events=new HerderEventBus();
    const make=(harness:string)=>({getSession:async()=>({id,harness,title:harness,cwd:"/tmp",status:"idle",lastActivity:"2026-11-05T00:00:00Z",needsPermission:false})});
    registerSessionTools({registerTool:(name:string,_schema:unknown,fn:Function)=>callbacks.set(name,fn)} as never,
      {adapters:new Map([["codex",make("codex") as never],["opencode",make("opencode") as never]]),events,jobs:new HerderJobRegistry(events),routingPeers:[]});
    const result=await callbacks.get("agent_info")!({sessionId:id});
    expect(result.structuredContent.session).toBeNull();
    expect(result.structuredContent.candidates.map((v:{harness:string})=>v.harness)).toEqual(["codex","opencode"]);
  });
});
