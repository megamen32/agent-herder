import { expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createAgentHerderMcpServer } from "../src/index.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
import { HerderEventBus } from "../src/herder-events.js";
import { createWebServer } from "../src/web/server.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AddressInfo } from "node:net";

it("wakes a tool-only client on Codex completion and changes its watched HTTP body once", async () => {
  const events = new HerderEventBus();
  const adapter = new CodexAppServerAdapter();
  const adapters = new Map([["codex", adapter]]);
  const supervisor = new SessionSupervisor(adapters, {} as never, undefined, { events, autoResumeFailedSessions:false });
  adapter.subscribeEvents(event => supervisor["handleHarnessEvent"]("codex", event));
  const native = (method: string, params: Record<string, unknown>) =>
    adapter["consumeMessage"]({method, params: {threadId: "child", ...params}});
  const server = createAgentHerderMcpServer(undefined, { events });
  const client = new Client({name:"cloud", version:"1"});
  const [c,s] = InMemoryTransport.createLinkedPair();
  const web = createWebServer({adapters: new Map(), converter: {} as never, supervisor, herderEvents: events, sessionObservationManagedExternally:true});
  await new Promise<void>(resolve => web.listen(0,"127.0.0.1",resolve));
  const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/api/sessions/codex/child/status`;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({name,arguments:args})).structuredContent as Record<string, any>;
  try {
    await server.connect(s);
    await client.connect(c);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("session_await");
    native("turn/started",{turn:{id:"one"}});
    expect(await (await fetch(url)).json()).toMatchObject({state:"running"});
    const since = events.latestSequence();
    const start = Date.now();
    const wait = call("session_await",{sessionIds:["child"],afterSequence:since,timeoutMs:1800});
    await new Promise(resolve => setTimeout(resolve,20));
    const turn = {id:"one",status:"completed",completedAt:1780000000,items:[{type:"agentMessage",text:"Ready for review"}]};
    native("turn/completed",{turn});
    native("turn/completed",{turn});
    const result = await wait;
    expect(result.completion).toMatchObject({sessionId:"child",outcome:"completed",lastAssistantMessage:"Ready for review"});
    expect(Date.now()-start).toBeLessThan(2000);
    const status = await (await fetch(url)).text();
    expect(JSON.parse(status)).toMatchObject({state:"finished",revision:result.cursor,finishedAt:"2026-05-28T20:26:40.000Z"});
    native("turn/started",{threadId:"other",turn:{id:"two"}});
    expect(await (await fetch(url)).text()).toBe(status);
    const replay = await call("event_list",{afterSequence:since,uriPrefix:"herder://completions/codex/child/"});
    expect(replay.events.map((event: any) => event.type)).toEqual(["turn.completed"]);
    expect((await call("session_await",{sessionIds:["child"],timeoutMs:0})).completion).toEqual(result.completion);
    native("turn/started",{turn:{id:"two"}});
    native("turn/completed",{turn:{id:"two",status:"failed",error:{message:"provider_unavailable"}}});
    expect((await call("session_await",{sessionIds:["child"],afterSequence:result.cursor,timeoutMs:0})).completion.outcome).toBe("failed");
  } finally {
    await client.close(); await server.close();
    await new Promise<void>(resolve => web.close(() => resolve()));
  }
});

it("resumes a lost reply from disk and respects timeout, scoped routes and the exact turn's digest", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { awaitCompletion, recordCodexTurn, completionStatus } = await import("../src/session-completion.js");
  const dir = mkdtempSync(join(tmpdir(), "hx-completion-"));
  const options = {persistencePath: join(dir,"events.json"), persistDebounceMs:1000};
  const signal = new AbortController().signal;
  try {
    const before = new HerderEventBus(options);
    const adapter = new CodexAppServerAdapter();
    adapter["threads"].set("child", {id:"child",parentThreadId:"parent"});
    adapter.subscribeEvents(event => { if (event.completionState) recordCodexTurn(before,event.completionState); });
    const message = (method:string, params:Record<string,unknown>) => adapter["consumeMessage"]({method,params:{threadId:"child",...params}});
    message("turn/started",{turn:{id:"one"}});
    const baseline = before.latestSequence();
    message("item/agentMessage/delta",{turnId:"one",itemId:"item",delta:"secret=masked " + "A".repeat(500)});
    message("turn/completed",{turn:{id:"one",status:"interrupted"}});
    const restored = new HerderEventBus(options);
    const result = await awaitCompletion(restored, ["other","child"],baseline,0,signal);
    expect(result.completion).toMatchObject({outcome:"stopped",parentThreadId:"parent"});
    expect(result.completion?.lastAssistantMessage).toHaveLength(240);
    expect(result.completion?.lastAssistantMessage).not.toContain("masked");
    recordCodexTurn(restored, result.completion!);
    expect(restored.latestSequence()).toBe(result.cursor);
    expect(await awaitCompletion(restored, ["child"],result.cursor,5,signal)).toMatchObject({completion:null,cursor:result.cursor});
    expect(completionStatus(restored,"child").revision).toBe(result.cursor);
    await expect(awaitCompletion(restored, ["child"],undefined,50,signal,async () => {throw Error("denied");})).rejects.toThrow("denied");
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it("recovers an already finished native turn from a single bounded summary on cold watch", async () => {
  const { awaitCompletion } = await import("../src/session-completion.js");
  const { vi } = await import("vitest");
  const adapter = new CodexAppServerAdapter();
  vi.spyOn(adapter as any, "ensureReady").mockResolvedValue(undefined);
  const request = vi.spyOn(adapter as any, "request").mockResolvedValue({data:[{id:"cold",status:"completed",items:[
    {type:"userMessage",text:"private input"}, {type:"agentMessage",text:"Which version?",questions:[{}]},
  ]}]});
  const bus = new HerderEventBus();
  const result = await awaitCompletion(bus, ["child"],undefined,1800,new AbortController().signal,async () => adapter);
  expect(result.completion).toMatchObject({turnId:"cold",outcome:"needs_input",lastAssistantMessage:"Which version?"});
  expect(request).toHaveBeenCalledExactlyOnceWith("thread/turns/list",{threadId:"child",limit:1,sortDirection:"desc",itemsView:"summary"},"completion_status",2000);
  expect(JSON.stringify(bus.listAfter(0))).not.toContain("private input");
});

it("wakes over authenticated stateless HTTP MCP and replays the same finished record through the web guard", async () => {
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const { recordCodexTurn } = await import("../src/session-completion.js");
  const events = new HerderEventBus();
  const adapter = new CodexAppServerAdapter();
  adapter.subscribeEvents(event => { if (event.completionState) recordCodexTurn(events,event.completionState); });
  const web = createWebServer({
    adapters: new Map(), converter: {} as never, herderEvents: events, sessionObservationManagedExternally: true,
    mcpAuthToken: "fixture", mcpServerFactory: () => createAgentHerderMcpServer(undefined, {events}),
    fleetHttpGuard: async (req, res) => {
      if (req.url === "/mcp" || req.headers.cookie === "owner=fixture") return false;
      res.writeHead(401).end(); return true;
    },
  });
  await new Promise<void>(resolve => web.listen(0,"127.0.0.1",resolve));
  const origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const url = origin + "/api/sessions/codex/child/status";
  const client = new Client({name:"tool-only",version:"1"},{versionNegotiation:{mode:"auto"}});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit:{headers:{authorization:"Bearer fixture"}},
    }));
    const catalog = await client.listTools();
    expect(catalog.tools.some(tool => tool.name === "session_await")).toBe(true);
    expect((await fetch(url)).status).toBe(401);
    const afterSequence = events.latestSequence();
    const before = Date.now();
    const wait = client.callTool({name:"session_await",arguments:{sessionIds:["child"],afterSequence,timeoutMs:1800}});
    await new Promise(resolve => setTimeout(resolve,30));
    adapter["consumeMessage"]({method:"turn/completed",params:{threadId:"child",turn:{
      id:"quota",status:"failed",error:{message:"provider_unavailable"},
    }}});
    const reply = await wait;
    expect(reply.structuredContent?.completion).toMatchObject({turnId:"quota",outcome:"failed"});
    expect(Date.now()-before).toBeLessThan(2000);
    const status = await (await fetch(url,{headers:{cookie:"owner=fixture"}})).json();
    expect(status).toMatchObject({state:"finished",outcome:"failed",revision:reply.structuredContent?.cursor});
    const replay = await client.callTool({name:"event_list",arguments:{afterSequence,uriPrefix:"herder://completions/"}});
    expect(replay.structuredContent?.events).toMatchObject([{type:"turn.completed",turn:{outcome:"failed"}}]);
  } finally {
    await client.close();
    await new Promise<void>(resolve => web.close(() => resolve()));
  }
});

it("advertises resource subscriptions without requiring MCP Tasks for completion", async () => {
  const server = createAgentHerderMcpServer(undefined, {events:new HerderEventBus()});
  const client = new Client({name:"capability-probe",version:"1"},{versionNegotiation:{mode:"auto"}});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toMatchObject({subscribe:true,listChanged:true});
    expect(capabilities?.tasks).toBeUndefined();
  } finally {
    await client.close(); await server.close();
  }
});
