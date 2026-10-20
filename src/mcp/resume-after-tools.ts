import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ResumeAfterService } from "../resume-after.js";
import { structuredResult } from "./results.js";
const ref=z.object({harness:z.enum(["opencode","claude","codex","qoder","hermes","zcode","fast-agent","chatgpt"]),sessionId:z.string().trim().min(1).max(512)});
export function registerResumeAfterTools(server:McpServer,service?:ResumeAfterService):void{
  const requireService=()=>{if(!service)throw new Error("Resume-after requires the process-owned Herder service");return service;};
  server.registerTool("resume_after",{
    description:"Resume this exact session once after ALL named sessions finish their current native execution. Keep doing independent work; do not stop yourself. Idle, a permission prompt or lost transport is not completion. A later human Stop cancels the wake. Retry an uncertain request with the same requestId. delivery_blocked and delivery_failed are terminal and never replay; after fixing the cause, a newly authorized continuation needs a new requestId.",
    inputSchema:z.object({owner:ref,dependencies:z.array(ref).min(1).max(32),message:z.string().trim().min(1).max(16000).optional(),requestId:z.string().trim().min(1).max(256).optional()}),
  },async args=>structuredResult({wait:await requireService().register(args)}));
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
