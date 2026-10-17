#!/usr/bin/env node
/**
 * The standalone Agent Resume entrypoint.
 *
 * Built and published from the Agent Herder monorepo at the same version as
 * Herder, so the tool anybody installs on its own is generated from the code
 * Agent Herder itself runs against.
 */
import { CORE_CONTRACT, CORE_VERSION, coreContractHash } from "./contract.js";
import { defaultSessionSearchDeps, searchSessions } from "./harness/search.js";
import { JobRegistry } from "./resume/jobs.js";
import { ReceiptLedger, validateIdempotencyKey } from "./resume/receipts.js";
import { buildResumeCommand, resolveBoundTarget, resumeBoundTarget } from "./resume/delivery.js";
import { OpenCodeClient } from "./harness/opencode/client.js";
import { homedir } from "node:os";
import { join } from "node:path";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`agent-resume: ${message}\n`);
  process.exit(1);
}

const stateDir = process.env.AGENT_RESUME_STATE_DIR ?? join(homedir(), ".local/state/agent-resume");
const ledger = new ReceiptLedger({ path: join(stateDir, "receipts.json") });
const opencodeUrl = process.env.OPENCODE_URL;
const nativeClient = opencodeUrl
  ? new OpenCodeClient({ baseUrl: opencodeUrl, ...(process.env.OPENCODE_SERVER_PASSWORD ? { password: process.env.OPENCODE_SERVER_PASSWORD } : {}) })
  : undefined;
const jobs = new JobRegistry({ stateDir, ledger, ...(nativeClient ? { delivery: { nativeClient } } : {}) });

function targetFromFlags(flags: Map<string, string>): ReturnType<typeof resolveBoundTarget> {
  return resolveBoundTarget({
    agent: flags.get("agent") ?? process.env.AGENT_RESUME_AGENT,
    session_id: flags.get("session") ?? flags.get("session-id"),
    cwd: flags.get("cwd") ?? process.cwd(),
    ...(flags.get("marker") ? { marker: flags.get("marker") } : {}),
    ...(flags.get("model") ? { model: flags.get("model") } : {}),
  });
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.slice(2).split("=");
    if (inline !== undefined) flags.set(name!, inline);
    else {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) { flags.set(name!, next); index++; }
      else flags.set(name!, "true");
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const [command = "contract", ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "contract":
      emit({ contract: CORE_CONTRACT, hash: coreContractHash(), version: CORE_VERSION });
      return;
    case "config":
      emit({
        ok: true,
        default_agent: process.env.AGENT_RESUME_AGENT ?? null,
        state_dir: stateDir,
        opencode_url: opencodeUrl ?? null,
        core_version: CORE_VERSION,
        core_hash: coreContractHash(),
      });
      return;
    case "find": {
      const agent = flags.get("agent");
      const sessions = await searchSessions(defaultSessionSearchDeps(), {
        ...(agent ? { agent } : {}),
        ...(flags.get("cwd") ? { cwd: flags.get("cwd") } : {}),
        ...(flags.get("query") ? { query: flags.get("query") } : {}),
        ...(flags.get("marker") ? { marker: flags.get("marker") } : {}),
        ...(flags.get("limit") ? { limit: Number(flags.get("limit")) } : {}),
      });
      emit({ ok: true, sessions });
      return;
    }
    case "command": {
      const target = targetFromFlags(flags);
      const prompt = flags.get("prompt");
      if (!prompt) fail("--prompt is required");
      emit({ ok: true, command: buildResumeCommand(target, prompt) });
      return;
    }
    case "resume": {
      const target = targetFromFlags(flags);
      const prompt = flags.get("prompt") ?? flags.get("goal");
      if (!prompt) fail("--prompt or --goal is required");
      const receipt = await resumeBoundTarget({
        target,
        prompt,
        ...(flags.get("goal") ? { goal: flags.get("goal") } : {}),
        resultRef: flags.get("result-ref") ?? `agent-resume://cli/${Date.now()}`,
        idempotencyKey: validateIdempotencyKey(flags.get("idempotency-key")),
        execute: flags.get("execute") !== "false",
      }, { ledger, ...(nativeClient ? { nativeClient } : {}) });
      emit(receipt);
      if (receipt.status === "failed" || receipt.status === "rejected") process.exitCode = 1;
      return;
    }
    case "receipt": {
      const key = validateIdempotencyKey(flags.get("idempotency-key"), { required: true });
      const record = ledger.read(key);
      if (!record) fail(`receipt not found for idempotency_key: ${key}`);
      emit(record);
      return;
    }
    case "job": {
      const jobId = flags.get("job-id");
      if (!jobId) fail("--job-id is required");
      const status = jobs.status(jobId);
      if (!status) fail(`job not found: ${jobId}`);
      emit(status);
      return;
    }
    case "mcp": {
      // Lazy import: a plain CLI command never loads the MCP stack.
      const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
      const { createResumeMcpServer } = await import("./mcp/server.js");
      serveStdio(() => createResumeMcpServer({ stateDir }).server, {
        onerror: (error: Error) => process.stderr.write(`agent-resume mcp: ${error.message}\n`),
      });
      return;
    }
    default:
      fail(`unknown command '${command}' (contract|config|find|command|resume|receipt|job|mcp)`);
  }
}

void main().catch((error) => {
  process.stderr.write(`agent-resume: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});