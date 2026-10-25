import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ResumeAfterService } from "../resume-after.js";
import { structuredResult } from "./results.js";
const ref=z.object({harness:z.enum(["opencode","claude","codex","qoder","hermes","zcode","fast-agent","chatgpt","minimax-code"]),sessionId:z.string().trim().min(1).max(512)});
const trigger=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("delay"),delayMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
  z.object({kind:z.literal("at"),at:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)}),
]);
const resumeRequest=z.union([
  z.object({owner:ref,dependencies:z.array(ref).min(1).max(32),message:z.string().trim().min(1).max(16000).optional(),requestId:z.string().trim().min(1).max(256).optional()}).strict(),
  z.object({owner:ref,message:z.string().trim().min(1).max(16000),requestId:z.string().trim().min(1).max(256),trigger}).strict(),
]);
export function registerResumeAfterTools(server:McpServer,service?:ResumeAfterService):void{
  const requireService=()=>{if(!service)throw new Error("Resume-after requires the process-owned Herder service");return service;};
  server.registerTool("resume_after",{
    description:"Resume this exact session once either after ALL named sessions finish their current native execution, or at one scheduled trigger: a positive delayMs or a timezone-qualified RFC3339 instant. Scheduled resumes require an explicit message and stable requestId and cannot include dependencies. Exact turn joins support Codex and ZCode. A later human Stop cancels the wake. Retry an uncertain request with the same requestId; accepted/unknown delivery is never replayed. A conflicting requestId is rejected.",
    inputSchema:resumeRequest,
  },async args=>{
    const wait=await requireService().register(args);
    return structuredResult({jobId:wait.id,...(wait.scheduledAt?{scheduledAt:wait.scheduledAt}:{}),wait});
  });
  server.registerTool("resume_after_status",{
    description:"Read pending dependency waits; this never resumes or starts a session.",
    annotations:{readOnlyHint:true},
    inputSchema:z.object({waitId:z.string().optional()}),
  },async args=>structuredResult(args.waitId?{wait:await requireService().get(args.waitId)}:{waits:await requireService().list()}));
  server.registerTool("resume_after_cancel",{
    description:"Cancel your own dependency wait without stopping any session.",
    inputSchema:z.object({waitId:z.string(),owner:ref}),
  },async args=>structuredResult({wait:await requireService().cancel(args.waitId,args.owner)}));
}
