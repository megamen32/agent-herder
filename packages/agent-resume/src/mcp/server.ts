import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { CORE_CONTRACT, coreContractHash } from "../contract.js";
import { defaultSessionSearchDeps, searchSessions } from "../harness/search.js";
import { JobRegistry, findPidsByQuery, parseDurationSeconds } from "../resume/jobs.js";
import { ReceiptLedger, validateIdempotencyKey } from "../resume/receipts.js";
import { buildResumeCommand, resolveBoundTarget, resumeBoundTarget } from "../resume/delivery.js";
import { OpenCodeClient } from "../harness/opencode/client.js";

/**
 * The standalone Agent Resume MCP surface, built from the same source as the
 * library Agent Herder depends on.
 *
 * The tool names and meanings are unchanged from the previous service, so an
 * existing harness configuration keeps working after it is repointed at this
 * build; only the implementation underneath moved.
 */
export interface ResumeMcpOptions {
  stateDir?: string;
  opencodeUrl?: string;
  opencodePassword?: string;
  /** Default agent when a caller omits it. */
  defaultAgent?: string;
}

export interface ResumeRuntime {
  server: McpServer;
  stateDir: string;
  ledger: ReceiptLedger;
  jobs: JobRegistry;
}

export function createResumeMcpServer(options: ResumeMcpOptions = {}): ResumeRuntime {
  const stateDir = options.stateDir ?? process.env.AGENT_RESUME_STATE_DIR ?? join(homedir(), ".local/state/agent-resume");
  const ledger = new ReceiptLedger({ path: join(stateDir, "receipts.json") });
  const opencodeUrl = options.opencodeUrl ?? process.env.OPENCODE_URL;
  const nativeClient = opencodeUrl
    ? new OpenCodeClient({
        baseUrl: opencodeUrl,
        ...(options.opencodePassword ?? process.env.OPENCODE_SERVER_PASSWORD
          ? { password: options.opencodePassword ?? process.env.OPENCODE_SERVER_PASSWORD! }
          : {}),
      })
    : undefined;
  const jobs = new JobRegistry({
    stateDir,
    ledger,
    ...(nativeClient ? { delivery: { nativeClient } } : {}),
  });

  const server = new McpServer(
    { name: "agent-resume", version: CORE_CONTRACT.version, description: "Find and resume a native coding-agent session by exact target" },
    {
      instructions: [
        "Use find_sessions to pick the exact chat, then resume_bound_target with the returned session id.",
        "The marker is exactly 5 ASCII alphanumeric characters and is the only safe way to choose between same-titled sessions.",
        "Admissions are durable: resume_bound_target with an idempotency_key admits once and replays the stored receipt on a retry.",
        "run_and_resume, attach_pid_and_resume and wait_and_resume continue one chat when background work finishes.",
      ].join("\n"),
    },
  );

  const resolveAgent = (requested?: string): string => {
    const value = requested?.trim() || options.defaultAgent?.trim() || process.env.AGENT_RESUME_AGENT?.trim();
    if (!value) throw new Error("agent is required: pass agent or set AGENT_RESUME_AGENT for this server");
    const normalized = value.toLowerCase();
    if (!["codex", "opencode", "claude"].includes(normalized)) throw new Error(`unsupported agent: ${value}`);
    return normalized;
  };

  server.registerTool("get_config", {
    description: "Show the effective Agent Resume configuration: default agent from env/config and state paths.",
    inputSchema: z.object({}),
  }, async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        default_agent: process.env.AGENT_RESUME_AGENT ?? options.defaultAgent ?? null,
        state_dir: stateDir,
        opencode_url: opencodeUrl ?? null,
        core_version: CORE_CONTRACT.version,
        core_hash: coreContractHash(),
      }),
    }],
  }));

  server.registerTool("find_sessions", {
    description: "Find likely local CLI coding-agent sessions. Use cwd/query/marker to pick the right chat before resuming.",
    inputSchema: z.object({
      agent: z.enum(["codex", "opencode", "claude"]).optional(),
      cwd: z.string().nullish().describe("Project directory to scope the search."),
      query: z.string().nullish().describe("Optional title/text query."),
      marker: z.string().nullish().describe("Short correlation marker: exactly 5 ASCII alphanumeric characters."),
      limit: z.number().int().min(1).max(200).nullish(),
    }),
  }, async (args) => {
    const agent = resolveAgent(args.agent ?? undefined);
    const sessions = await searchSessions(defaultSessionSearchDeps({
      ...(opencodeUrl ? { opencodeUrl } : {}),
      ...(options.opencodePassword ? { opencodePassword: options.opencodePassword } : {}),
    }), { agent, cwd: args.cwd ?? undefined, query: args.query ?? undefined, marker: args.marker ?? undefined, limit: args.limit ?? 20 });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, sessions }) }] };
  });

  server.registerTool("build_resume_command", {
    description: "Build the command that would resume one bound session. Never discovers or falls back to a last session.",
    inputSchema: z.object({
      agent: z.enum(["codex", "opencode", "claude"]),
      session_id: z.string().min(1),
      cwd: z.string().min(1),
      prompt: z.string().min(1),
      model: z.string().nullish(),
    }),
  }, async (args) => {
    const target = resolveBoundTarget({ agent: args.agent, session_id: args.session_id, cwd: args.cwd, ...(args.model ? { model: args.model } : {}) });
    const command = buildResumeCommand(target, args.prompt);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, command }) }] };
  });

  server.registerTool("resume_bound_target", {
    description: "Resume an already selected immutable target. With idempotency_key the durable ledger deduplicates exact retries and rejects conflicting reuse.",
    inputSchema: z.object({
      target: z.object({
        agent: z.enum(["codex", "opencode", "claude"]),
        session_id: z.string().min(1),
        cwd: z.string().min(1),
        marker: z.string().nullish(),
        model: z.string().nullish(),
      }),
      prompt: z.string().optional(),
      goal: z.string().optional(),
      result_ref: z.string().min(1),
      idempotency_key: z.string().optional(),
      execute: z.boolean().optional(),
    }),
  }, async (args) => {
    const receipt = await resumeBoundTarget({
      target: args.target,
      prompt: args.prompt ?? null,
      goal: args.goal ?? null,
      resultRef: args.result_ref,
      idempotencyKey: validateIdempotencyKey(args.idempotency_key),
      execute: args.execute,
    }, { ledger, ...(nativeClient ? { nativeClient } : {}) });
    return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
  });

  for (const name of ["get_resume_receipt", "query_resume_receipt"] as const) {
    server.registerTool(name, {
      description: "Read a durable target-bound resume receipt by idempotency_key after a process restart.",
      inputSchema: z.object({ idempotency_key: z.string().min(1) }),
    }, async (args) => {
      const record = ledger.read(validateIdempotencyKey(args.idempotency_key, { required: true }));
      if (!record) return { isError: true, content: [{ type: "text", text: `receipt not found for idempotency_key: ${args.idempotency_key}` }] };
      return { content: [{ type: "text", text: JSON.stringify(record) }] };
    });
  }

  server.registerTool("run_and_resume", {
    description: "Run a command in the background, wait until it finishes or hard_timeout is reached, then resume the bound chat.",
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().min(1),
      target: z.object({
        agent: z.enum(["codex", "opencode", "claude"]),
        session_id: z.string().min(1),
        cwd: z.string().min(1),
        marker: z.string().nullish(),
        model: z.string().nullish(),
      }),
      hard_timeout: z.union([z.string(), z.number()]).nullish(),
      log_file: z.string().nullish(),
      note: z.string().nullish(),
      execute_resume: z.boolean().optional(),
    }),
  }, async (args) => {
    const job = await jobs.runAndResume({
      command: args.command,
      cwd: args.cwd,
      resume: resolveBoundTarget(args.target),
      hardTimeoutSeconds: parseDurationSeconds(args.hard_timeout ?? 0),
      logFile: args.log_file ?? null,
      note: args.note ?? "",
      executeResume: args.execute_resume !== false,
    });
    const finished = await jobs.complete({ jobId: job.job_id });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, job_id: job.job_id, state: finished.state, resume_result: finished.resume_result ?? null }) }] };
  });

  server.registerTool("attach_pid_and_resume", {
    description: "Watch an existing PID and resume the bound chat when it exits or hard_timeout is reached.",
    inputSchema: z.object({
      pid: z.number().int().positive(),
      cwd: z.string().min(1),
      target: z.object({
        agent: z.enum(["codex", "opencode", "claude"]),
        session_id: z.string().min(1),
        cwd: z.string().min(1),
        marker: z.string().nullish(),
        model: z.string().nullish(),
      }),
      hard_timeout: z.union([z.string(), z.number()]).nullish(),
      log_file: z.string().nullish(),
      note: z.string().nullish(),
      execute_resume: z.boolean().optional(),
    }),
  }, async (args) => {
    const job = await jobs.attachPidAndResume({
      pid: args.pid,
      cwd: args.cwd,
      resume: resolveBoundTarget(args.target),
      hardTimeoutSeconds: parseDurationSeconds(args.hard_timeout ?? 0),
      logFile: args.log_file ?? null,
      note: args.note ?? "",
      executeResume: args.execute_resume !== false,
    });
    const finished = await jobs.complete({ jobId: job.job_id });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, job_id: job.job_id, state: finished.state, resume_result: finished.resume_result ?? null }) }] };
  });

  server.registerTool("attach_query_and_resume", {
    description: "Find a process by command substring, watch it, and resume the bound chat when it ends.",
    inputSchema: z.object({
      query: z.string().min(1),
      first: z.boolean().optional(),
      cwd: z.string().min(1),
      target: z.object({
        agent: z.enum(["codex", "opencode", "claude"]),
        session_id: z.string().min(1),
        cwd: z.string().min(1),
        marker: z.string().nullish(),
        model: z.string().nullish(),
      }),
      hard_timeout: z.union([z.string(), z.number()]).nullish(),
      execute_resume: z.boolean().optional(),
    }),
  }, async (args) => {
    const matches = await findPidsByQuery(args.query, { exclude: ["agent-resume-mcp", "agent_resume"] });
    const chosen = args.first ? matches[0] : matches[0];
    if (!chosen) return { isError: true, content: [{ type: "text", text: `no process matched: ${args.query}` }] };
    const job = await jobs.attachPidAndResume({
      pid: chosen.pid,
      cwd: args.cwd,
      resume: resolveBoundTarget(args.target),
      hardTimeoutSeconds: parseDurationSeconds(args.hard_timeout ?? 0),
      executeResume: args.execute_resume !== false,
    });
    const finished = await jobs.complete({ jobId: job.job_id });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, job_id: job.job_id, pid: chosen.pid, state: finished.state, resume_result: finished.resume_result ?? null }) }] };
  });

  server.registerTool("wait_and_resume", {
    description: "Wait a fixed duration, then resume the bound chat. Prefer run_and_resume or attach_pid_and_resume for command waits.",
    inputSchema: z.object({
      wait_seconds: z.union([z.string(), z.number()]),
      cwd: z.string().min(1),
      target: z.object({
        agent: z.enum(["codex", "opencode", "claude"]),
        session_id: z.string().min(1),
        cwd: z.string().min(1),
        marker: z.string().nullish(),
        model: z.string().nullish(),
      }),
      note: z.string().nullish(),
      execute_resume: z.boolean().optional(),
    }),
  }, async (args) => {
    const job = await jobs.waitAndResume({
      waitSeconds: parseDurationSeconds(args.wait_seconds),
      cwd: args.cwd,
      resume: resolveBoundTarget(args.target),
      note: args.note ?? "",
      executeResume: args.execute_resume !== false,
    });
    const finished = await jobs.complete({ jobId: job.job_id });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, job_id: job.job_id, state: finished.state, resume_result: finished.resume_result ?? null }) }] };
  });

  server.registerTool("wait_job_status", {
    description: "Read status for a background wait job created by run_and_resume/attach_*_and_resume/wait_and_resume.",
    inputSchema: z.object({ job_id: z.string().min(1) }),
  }, async (args) => {
    const status = jobs.status(args.job_id);
    if (!status) return { isError: true, content: [{ type: "text", text: `job not found: ${args.job_id}` }] };
    return { content: [{ type: "text", text: JSON.stringify(status) }] };
  });

  return { server, stateDir, ledger, jobs };
}