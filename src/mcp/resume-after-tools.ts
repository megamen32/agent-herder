import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ResumeAfterService } from "../resume-after.js";
import type { HumanRequestRegistry } from "../human-request/registry.js";
import { structuredResult } from "./results.js";
import { callerSessionFromMcpContext } from "./caller-session.js";
const ref=z.object({harness:z.enum(["opencode","claude","codex","qoder","hermes","zcode","fast-agent","chatgpt","minimax-code", "browser-chat"]),sessionId:z.string().trim().min(1).max(512)});
const trigger=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("delay"),delayMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}),
  z.object({kind:z.literal("at"),at:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)}),
]);
const rfc3339=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
const humanRequestFields={
  humanRequestId:z.string().trim().min(1).max(128).optional(),
  expiresAt:rfc3339.optional(),
};
/** A HumanRequest join is a question deadline: both fields, an absolute
 * trigger, and the trigger time exactly equal to the registered deadline. */
function refineHumanRequestJoin(value:{humanRequestId?:string;expiresAt?:string;trigger?:{kind:string;at?:string}},ctx:z.RefinementCtx):void{
  if(!value.humanRequestId && !value.expiresAt)return;
  if(!value.humanRequestId || !value.expiresAt){
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"humanRequestId and expiresAt are required together for a HumanRequest join"});
    return;
  }
  if(!value.trigger || value.trigger.kind!=="at"){
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"A HumanRequest join requires a scheduled-time trigger (kind=at)"});
    return;
  }
  if(value.trigger.at!==value.expiresAt){
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"expiresAt must exactly equal the registered trigger time"});
  }
}
const resumeRequest=z.union([
  z.object({owner:ref.optional(),dependencies:z.array(ref).min(1).max(32),message:z.string().trim().min(1).max(16000).optional(),requestId:z.string().trim().min(1).max(256).optional(),...humanRequestFields}).strict()
    .superRefine((value,ctx)=>refineHumanRequestJoin(value,ctx)),
  z.object({owner:ref.optional(),message:z.string().trim().min(1).max(16000),requestId:z.string().trim().min(1).max(256),trigger,...humanRequestFields}).strict()
    .superRefine((value,ctx)=>refineHumanRequestJoin(value,ctx)),
]);
/** The durable HumanRequest seam this route binds answered questions to. */
type HumanRequestJoin = Pick<HumanRequestRegistry, "get" | "bindResumeWait">;
export function registerResumeAfterTools(server:McpServer,service?:ResumeAfterService,humanRequests?:HumanRequestJoin):void{
  const requireService=()=>{if(!service)throw new Error("Resume-after requires the process-owned Herder service");return service;};
  const requireHumanRequests=()=>{if(!humanRequests)throw new Error("Resume-after HumanRequest binding requires the durable registry");return humanRequests;};
  server.registerTool("resume_after",{
    description:"Resume yourself once after a delay, at a scheduled time, or after ALL named dependencies finish their current native execution. Omit owner to resume YOUR CURRENT SESSION: OpenCode, Codex and ZCode supply its native ID in MCP request metadata automatically. Provide owner only to select an explicit session. session_identity() without sessionId reads your own identity the same way. Never guess your own ID from session lists. If native caller metadata is absent or invalid, the tool fails before scheduling. Scheduled resumes require an explicit message and stable requestId, with either trigger.delayMs or a timezone-qualified trigger.at; they cannot include dependencies. Exact turn joins support Codex and ZCode. A later human Stop cancels the wake. Retry an uncertain request with the same requestId; accepted/unknown delivery is never replayed. A conflicting requestId is rejected. To continue an answered typed question, pass humanRequestId (and optionally expiresAt): the wait binds to that exact pending HumanRequest only when its native target matches the owner tuple, and a binding failure cancels this wait.",
    inputSchema:resumeRequest,
  },async (args,context)=>{
    const owner=args.owner ?? callerSessionFromMcpContext(context);
    if (!owner) throw new Error("resume_after requires owner or valid native MCP caller session metadata");
    const wait=await requireService().register({...args,owner});
    if(args.humanRequestId){
      try{
        const request=await requireHumanRequests().get(args.humanRequestId);
        if(!request)throw new Error(`Human request '${args.humanRequestId}' not found`);
        if(request.status!=="pending")throw new Error(`Human request '${args.humanRequestId}' is not pending`);
        const target=request.target;
        if((target.harness??target.agent)!==owner.harness || target.sessionId!==owner.sessionId){
          throw new Error(`Human request '${args.humanRequestId}' native target does not match the owner tuple ${owner.harness}:${owner.sessionId}`);
        }
        // Defense in depth behind the schema: the registered deadline is the
        // wake time, so a drift here would silently move the question's end.
        const trigger=wait.trigger;
        if(!trigger || trigger.kind!=="at" || trigger.at!==args.expiresAt){
          throw new Error(`Human request '${args.humanRequestId}' wake must be scheduled exactly at its expiresAt`);
        }
        await requireHumanRequests().bindResumeWait(args.humanRequestId,wait.id);
      }catch(error){
        // A failed binding cancels only the wait this call created; the wait
        // is cancelled, never delivered, and the durable request is untouched.
        try{ if((await requireService().get(wait.id))?.state==="waiting") await requireService().cancel(wait.id,owner); }
        catch{ /* keep the original binding error */ }
        throw error;
      }
    }
    return structuredResult({jobId:wait.id,...(args.humanRequestId?{humanRequestId:args.humanRequestId}:{}),...(wait.scheduledAt?{scheduledAt:wait.scheduledAt}:{}),wait});
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
