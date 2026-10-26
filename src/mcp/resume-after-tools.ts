import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ResumeAfterService } from "../resume-after.js";
import { structuredResult } from "./results.js";
import { callerSessionFromMcpContext } from "./caller-session.js";
const ref=z.object({harness:z.enum(["opencode","claude","codex","qoder","hermes","zcode","fast-agent","chatgpt","minimax-code"]),sessionId:z.string().trim().min(1).max(512)});
const trigger=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("delay"),delayMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
  z.object({kind:z.literal("at"),at:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)}),
]);
const resumeRequest=z.union([
  z.object({owner:ref.optional(),dependencies:z.array(ref).min(1).max(32),message:z.string().trim().min(1).max(16000).optional(),requestId:z.string().trim().min(1).max(256).optional()}).strict(),
  z.object({owner:ref.optional(),message:z.string().trim().min(1).max(16000),requestId:z.string().trim().min(1).max(256),trigger}).strict(),
]);
export function registerResumeAfterTools(server:McpServer,service?:ResumeAfterService):void{
  const requireService=()=>{if(!service)throw new Error("Resume-after requires the process-owned Herder service");return service;};
  server.registerTool("resume_after",{
    description:"Resume yourself once after a delay, at a scheduled time, or after ALL named dependencies finish their current native execution. Omit owner to resume YOUR CURRENT SESSION: OpenCode, Codex and ZCode supply its native ID in MCP request metadata automatically. Provide owner only to select an explicit session. session_identity() without sessionId reads your own identity the same way. Never guess your own ID from session lists. If native caller metadata is absent or invalid, the tool fails before scheduling. Scheduled resumes require an explicit message and stable requestId, with either trigger.delayMs or a timezone-qualified trigger.at; they cannot include dependencies. Exact turn joins support Codex and ZCode. A later human Stop cancels the wake. Retry an uncertain request with the same requestId; accepted/unknown delivery is never replayed. A conflicting requestId is rejected.",
    inputSchema:resumeRequest,
  },async (args,context)=>{
    const owner=args.owner ?? callerSessionFromMcpContext(context);
    if (!owner) throw new Error("resume_after requires owner or valid native MCP caller session metadata");
    const wait=await requireService().register({...args,owner});
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
