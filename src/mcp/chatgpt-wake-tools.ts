import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { structuredValueResult } from "./results.js";
import type { WakeBindingStore } from "../chatgpt-wake-binding.js";
import type { HerderJobRegistry } from "../herder-jobs.js";
import type { HarnessAdapter } from "../types/index.js";

const ownerSchema = z.object({
  harness: z.enum(["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent", "minimax-code"]),
  sessionId: z.string().trim().min(1).max(512),
});

/**
 * Explicit ChatGPT wake-binding tools.
 *
 * ChatGPT hosts do not supply a routable conversation identity in MCP request
 * metadata, so a ChatGPT chat cannot be attributed or resumed automatically.
 * These tools provide the supported alternative: an explicit opt-in binding.
 * The owner session is validated against the live adapter registry at
 * registration time, so a binding can never point at a guessed or foreign
 * session. Verification returns the bound owner to pass explicitly to
 * session_identity or resume_after; the store fails closed on any mismatch.
 */
export function registerChatGptWakeTools(server: McpServer, deps: {
  bindings: WakeBindingStore;
  adapters: Map<string, HarnessAdapter>;
  /** Job registry used for the exactly-once terminal result delivery. */
  jobs: HerderJobRegistry;
  /** Transport-provided client identity for provenance; never a secret. */
  provenance?: () => { clientId?: string; subject?: string };
}): void {
  server.registerTool("chatgpt_wake_binding_register", {
    description:
      "Register an explicit ChatGPT wake binding: bindingId + secret + a VALIDATED owner session (harness/sessionId must exist in the live registry). " +
      "Later calls from the same workflow present the bindingId+secret to chatgpt_wake_binding_verify and receive this owner back for explicit use in session_identity or resume_after. " +
      "This is the only supported path for ChatGPT wake/callback, because ChatGPT supplies no routable conversation identity in MCP metadata. The secret is stored only as a salted digest.",
    inputSchema: z.object({
      bindingId: z.string().trim().min(1).max(128),
      secret: z.string().min(16).max(256).describe("Shared secret; keep it in a protected store, never in chat text."),
      owner: ownerSchema,
      maxUses: z.number().int().min(1).max(200).optional(),
    }).strict(),
    outputSchema: z.object({ bindingId: z.string(), owner: ownerSchema, createdAt: z.string(), maxUses: z.number() }),
  }, async (rawArgs) => {
    const adapter = deps.adapters.get(rawArgs.owner.harness);
    if (!adapter) throw new Error(`chatgpt_wake_binding_owner_unknown_harness:${rawArgs.owner.harness}`);
    const session = await adapter.getSession(rawArgs.owner.sessionId).catch(() => null);
    if (!session) throw new Error("chatgpt_wake_binding_owner_unverified: owner session does not exist in the live registry");
    const result = await deps.bindings.register({
      bindingId: rawArgs.bindingId,
      secret: rawArgs.secret,
      owner: rawArgs.owner,
      maxUses: rawArgs.maxUses,
      provenance: deps.provenance?.(),
    });
    return structuredValueResult(result);
  });

  server.registerTool("chatgpt_wake_binding_verify", {
    description:
      "Verify a ChatGPT wake binding with bindingId+secret and receive the validated bound owner exactly once per call against the binding use budget. " +
      "Pass the returned owner explicitly to session_identity or resume_after. Any mismatch, unknown id, or exhausted budget fails closed with chatgpt_wake_binding_unverified.",
    inputSchema: z.object({
      bindingId: z.string().trim().min(1).max(128),
      secret: z.string().min(16).max(256),
    }).strict(),
    outputSchema: z.object({ owner: z.object({ harness: z.string(), sessionId: z.string() }) }),
  }, async (rawArgs) => {
    const owner = await deps.bindings.verify(rawArgs);
    return structuredValueResult({ owner });
  });

  server.registerTool("chatgpt_wake_await", {
    description:
      "Wait for one Agent Herder job to finish and deliver its terminal result to the bound ChatGPT workflow exactly once. " +
      "Requires bindingId+secret (the same explicit binding used for wake) and the jobId. " +
      "The validated bound owner is returned with the terminal job state so the caller can resume the right session. " +
      "A second delivery of the same job through the same binding is refused with chatgpt_wake_delivery_already_done.",
    inputSchema: z.object({
      bindingId: z.string().trim().min(1).max(128),
      secret: z.string().min(16).max(256),
      jobId: z.string().trim().min(1).max(256),
      timeoutMs: z.number().int().min(100).max(600_000).optional().default(120_000),
    }).strict(),
    outputSchema: z.object({
      owner: z.object({ harness: z.string(), sessionId: z.string() }),
      job: z.object({
        id: z.string(), kind: z.string(), state: z.string(), progress: z.number().optional(),
        statusMessage: z.string().optional(), result: z.unknown().optional(), error: z.string().optional(),
      }),
    }),
  }, async (rawArgs) => {
    const owner = await deps.bindings.verifyOnceForJob(rawArgs);
    const deadline = Date.now() + rawArgs.timeoutMs;
    let job = deps.jobs.get(rawArgs.jobId);
    while (job && !["completed", "failed", "cancelled", "interrupted"].includes(job.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = deps.jobs.get(rawArgs.jobId);
    }
    if (!job) throw new Error("chatgpt_wake_job_unknown");
    return structuredValueResult({
      owner,
      job: {
        id: job.id,
        kind: job.kind,
        state: job.state,
        progress: job.progress,
        statusMessage: job.statusMessage,
        result: job.result,
        error: job.error,
      },
    });
  });
}
