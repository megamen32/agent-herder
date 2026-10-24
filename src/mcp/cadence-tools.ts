import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CadenceScheduler } from "../cadence-scheduler.js";
import { structuredResult } from "./results.js";
export function registerCadenceTools(server:McpServer,service?:CadenceScheduler):void {
  const requireService=()=>{if(!service)throw new Error("Cadence requires the process-owned Herder runtime");return service;};
  server.registerTool("cadence_schedule",{
    description:"Durably wake this exact existing Codex thread: every 15m in hour one, 30m in hour two, then at :45 Europe/Moscow hourly. First :45 anchor after hour two can be under an hour away. No new thread. Busy/unavailable threads wait; explicit HumanStop pauses. Retry with identical requestId. Unknown delivery never replays. Wake continues only previously authorized work, and never authorizes financial actions. The goal owner must call cadence_control complete when done or pause when explicitly paused.",
    inputSchema:z.object({sessionId:z.string().trim().min(1).max(512),requestId:z.string().trim().min(1).max(256),message:z.string().trim().min(1).max(16000).optional()}),
  },async input=>structuredResult({schedule:await requireService().schedule(input)}));
  server.registerTool("cadence_status",{
    description:"Read durable cadence state, next wake time and last delivery result. A dispatching record surviving a restart is unresolved and never replayed.",annotations:{readOnlyHint:true},
    inputSchema:z.object({scheduleId:z.string().optional()}),
  },async input=>{const rows=await requireService().list();return structuredResult(input.scheduleId?{schedule:rows.find(row=>row.id===input.scheduleId)??null}:{schedules:rows});});
  server.registerTool("cadence_control",{
    description:"Stop this exact owner's cadence on explicit pause or goal completion. Terminal for this requestId; does not interrupt a previously admitted native turn.",
    inputSchema:z.object({scheduleId:z.string(),sessionId:z.string(),action:z.enum(["pause","complete"])}),
  },async input=>structuredResult({schedule:await requireService().control(input.scheduleId,input.sessionId,input.action)}));
}
