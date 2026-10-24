import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CadenceScheduler } from "../src/cadence-scheduler.js";
import { registerCadenceTools } from "../src/mcp/cadence-tools.js";

describe("cadence MCP boundary",()=>{
  it("lists schemas, registers and reads back same native ID across scheduler restart, then completes",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"cadence-mcp-"));
    const options={path:join(dir,"cadence.json"),now:()=>Date.parse("2026-10-24T03:07:00Z"),inspect:vi.fn(async()=>"busy" as const),deliver:vi.fn(async()=>({status:"accepted" as const}))};
    const server=new McpServer({name:"cadence-test",version:"1"});
    registerCadenceTools(server,new CadenceScheduler(options));
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    const client=new Client({name:"cadence-consumer",version:"1"},{versionNegotiation:{mode:"auto"}});
    try {
      await server.connect(serverTransport);await client.connect(clientTransport);
      const listing=await client.listTools();
      expect(listing.tools.map(tool=>tool.name)).toEqual(["cadence_schedule","cadence_status","cadence_control"]);
      const result=await client.callTool({name:"cadence_schedule",arguments:{sessionId:"same-native-thread",requestId:"owned-goal"}});
      expect(result.isError).not.toBe(true);
      const row=(result.structuredContent as any).schedule;
      expect(row).toMatchObject({sessionId:"same-native-thread",activatedAt:"2026-10-24T03:07:00.000Z",nextAt:"2026-10-24T03:22:00.000Z",state:"scheduled"});
      expect(await new CadenceScheduler(options).list()).toEqual([row]);
      const status=await client.callTool({name:"cadence_status",arguments:{scheduleId:row.id}});
      expect((status.structuredContent as any).schedule).toEqual(row);
      const retry=await client.callTool({name:"cadence_schedule",arguments:{sessionId:"same-native-thread",requestId:"owned-goal"}});
      expect((retry.structuredContent as any).schedule).toEqual(row);
      const wrong=await client.callTool({name:"cadence_control",arguments:{scheduleId:row.id,sessionId:"other-thread",action:"complete"}});
      expect(wrong.isError).toBe(true);
      const complete=await client.callTool({name:"cadence_control",arguments:{scheduleId:row.id,sessionId:"same-native-thread",action:"complete"}});
      expect((complete.structuredContent as any).schedule.state).toBe("complete");
      expect(options.deliver).not.toHaveBeenCalled();
    } finally {await client.close();await server.close();await rm(dir,{recursive:true,force:true});}
  });
  it("refuses an isolated MCP factory with no process-owned scheduler",async()=>{
    const server=new McpServer({name:"cadence-no-runtime",version:"1"});registerCadenceTools(server);
    const [ct,st]=InMemoryTransport.createLinkedPair();const client=new Client({name:"cadence-no-runtime-consumer",version:"1"},{versionNegotiation:{mode:"auto"}});
    try{await server.connect(st);await client.connect(ct);const result=await client.callTool({name:"cadence_schedule",arguments:{sessionId:"same-thread",requestId:"task"}});expect(result.isError).toBe(true);}
    finally{await client.close();await server.close();}
  });
});
