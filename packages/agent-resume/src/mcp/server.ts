import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { CORE_CONTRACT, coreContractHash } from "../contract.js";
import { defaultSessionSearchDeps, searchSessions } from "../harness/search.js";
import { ReceiptLedger, validateIdempotencyKey } from "../resume/receipts.js";
import { buildResumeCommand, resolveBoundTarget } from "../resume/delivery.js";
import { standaloneRetirement, type HerderLegacyFacade, type LegacyResumeOperation } from "../legacy-retirement.js";

/**
 * Compatibility surface for existing configurations. Reads remain available;
 * effect aliases require an explicit Herder facade and never create a scheduler.
 */
export interface ResumeMcpOptions {
  stateDir?: string;
  opencodeUrl?: string;
  opencodePassword?: string;
  /** Default agent when a caller omits it. */
  defaultAgent?: string;
  /** Explicit trusted Herder owner; absence retires every legacy effect. */
  herderFacade?: HerderLegacyFacade;
}

export interface ResumeRuntime {
  server: McpServer;
  stateDir: string;
  ledger: ReceiptLedger;
}

export function createResumeMcpServer(options: ResumeMcpOptions = {}): ResumeRuntime {
  const stateDir = options.stateDir ?? process.env.AGENT_RESUME_STATE_DIR ?? join(homedir(), ".local/state/agent-resume");
  const ledger = new ReceiptLedger({ path: join(stateDir, "receipts.json") });
  const opencodeUrl = options.opencodeUrl ?? process.env.OPENCODE_URL;

  const server = new McpServer(
    { name: "agent-resume", version: CORE_CONTRACT.version, description: "Agent Herder compatibility reads and retired Agent Resume aliases" },
    {
      instructions: [
        "Use Agent Herder Resource and Automation for supervised execution, leases, waits and resume.",
        "This compatibility endpoint keeps session lookup and existing receipt reads.",
        "Legacy effects require an explicitly injected Herder facade; otherwise they return a migration error.",
      ].join("\n"),
    },
  );

  const legacyCall = async (operation: LegacyResumeOperation, args: Record<string, unknown>) => {
    if (!options.herderFacade) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(standaloneRetirement(operation)) }] };
    }
    const result = await options.herderFacade.invoke(operation, Object.freeze({ ...args }));
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };

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
        execution_owner: "agent-herder",
        legacy_effects: options.herderFacade ? "herder_facade" : "retired",
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
    description: "Compatibility alias: requires the Agent Herder facade. Resume an already selected immutable target. With idempotency_key the durable ledger deduplicates exact retries and rejects conflicting reuse.",
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
    return legacyCall("resume_bound_target", args);
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
    description: "Compatibility alias: requires the Agent Herder facade. Run a command in the background, wait until it finishes or hard_timeout is reached, then resume the bound chat.",
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
    return legacyCall("run_and_resume", args);
  });

  server.registerTool("attach_pid_and_resume", {
    description: "Compatibility alias: requires the Agent Herder facade. Watch an existing PID and resume the bound chat when it exits or hard_timeout is reached.",
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
    return legacyCall("attach_pid_and_resume", args);
  });

  server.registerTool("attach_query_and_resume", {
    description: "Compatibility alias: requires the Agent Herder facade. Find a process by command substring, watch it, and resume the bound chat when it ends.",
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
    return legacyCall("attach_query_and_resume", args);
  });

  server.registerTool("wait_and_resume", {
    description: "Compatibility alias: requires the Agent Herder facade. Wait a fixed duration, then resume the bound chat. Prefer run_and_resume or attach_pid_and_resume for command waits.",
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
    return legacyCall("wait_and_resume", args);
  });

  server.registerTool("wait_job_status", {
    description: "Compatibility alias: requires the Agent Herder facade. Read status for a background wait job created by run_and_resume/attach_*_and_resume/wait_and_resume.",
    inputSchema: z.object({ job_id: z.string().min(1) }),
  }, async (args) => {
    return legacyCall("wait_job_status", args);
  });

  return { server, stateDir, ledger };
}