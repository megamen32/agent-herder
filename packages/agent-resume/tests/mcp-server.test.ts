import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createResumeMcpServer, type ResumeMcpOptions } from "../src/mcp/server.js";

// Focused integration: the standalone MCP surface over an in-memory transport.
// Expected <2s/max 20s. No harness, provider or spawned process.
async function connect(stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-")), options: ResumeMcpOptions = {}) {
  const runtime = createResumeMcpServer({ ...options, stateDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(serverTransport);
  const client = new Client({ name: "canary", version: "1" });
  await client.connect(clientTransport);
  return { client, runtime, stateDir };
}

it("exposes the same tool names the previous service did", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  expect(names).toEqual([
    "attach_pid_and_resume",
    "attach_query_and_resume",
    "build_resume_command",
    "find_sessions",
    "get_config",
    "get_resume_receipt",
    "query_resume_receipt",
    "resume_bound_target",
    "run_and_resume",
    "wait_and_resume",
    "wait_job_status",
  ]);
});

it("reports its identity and where it keeps state", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-config-"));
  const { client } = await connect(stateDir);
  const result = await client.callTool({ name: "get_config", arguments: {} });
  const payload = JSON.parse(String((result.content[0] as { text: string }).text));
  expect(payload).toMatchObject({ ok: true, state_dir: stateDir, execution_owner: "agent-herder", legacy_effects: "retired" });
  expect(payload.core_hash).toMatch(/^[0-9a-f]{64}$/);
});

it("builds a bound command and refuses an incomplete target", async () => {
  const { client } = await connect();
  const built = await client.callTool({
    name: "build_resume_command",
    arguments: { agent: "claude", session_id: "ses_1", cwd: "/tmp", prompt: "дальше" },
  });
  expect(JSON.parse(String((built.content[0] as { text: string }).text)).command).toEqual(["claude", "--print", "--resume", "ses_1", "дальше"]);

  const refused = await client.callTool({ name: "build_resume_command", arguments: { agent: "claude", session_id: "ses_1", prompt: "дальше" } });
  expect(refused.isError).toBe(true);
});

it("retires standalone resume without admitting a receipt or creating a local registry", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-resume-retired-"));
  const { client, runtime } = await connect(stateDir);
  const result = await client.callTool({
    name: "resume_bound_target",
    arguments: {
      target: { agent: "opencode", session_id: "ses_1", cwd: "/tmp" },
      prompt: "continue",
      result_ref: "result://1",
      idempotency_key: "mcp-key-1",
      execute: false,
    },
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(String((result.content[0] as { text: string }).text))).toMatchObject({
    status: "rejected", reason: "agent_resume_standalone_retired", execution_owner: "agent-herder",
  });
  expect(runtime.ledger.read("mcp-key-1")).toBeNull();
  expect("jobs" in runtime).toBe(false);
  expect(existsSync(join(stateDir, "jobs"))).toBe(false);
  const missing = await client.callTool({ name: "get_resume_receipt", arguments: { idempotency_key: "absent" } });
  expect(missing.isError).toBe(true);
});

it("requires an agent when the server has no default", async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: "find_sessions", arguments: { limit: 1 } });
  expect(result.isError).toBe(true);
  expect(String((result.content[0] as { text: string }).text)).toContain("agent is required");
});

it.each([
  ["run_and_resume", { command: "touch must-not-exist" }],
  ["attach_pid_and_resume", { pid: process.pid }],
  ["attach_query_and_resume", { query: "must-not-enumerate-processes" }],
  ["wait_and_resume", { wait_seconds: 1 }],
  ["wait_job_status", { job_id: "existing-job" }],
] as const)("retires %s before creating a watcher or command", async (name, extra) => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-effect-retired-"));
  const { client } = await connect(stateDir);
  const result = await client.callTool({
    name,
    arguments: {
      cwd: stateDir,
      target: { agent: "opencode", session_id: "ses_job", cwd: stateDir },
      execute_resume: false,
      ...extra,
    },
  });
  expect(result.isError).toBe(true);
  expect(JSON.parse(String((result.content[0] as { text: string }).text))).toMatchObject({
    reason: "agent_resume_standalone_retired", operation: name,
  });
  expect(existsSync(join(stateDir, "jobs"))).toBe(false);
  expect(existsSync(join(stateDir, "must-not-exist"))).toBe(false);
});

it("delegates one explicit compatibility request to the trusted Herder facade", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-facade-"));
  const calls: Array<{ operation: string; args: Readonly<Record<string, unknown>> }> = [];
  const { client, runtime } = await connect(stateDir, {
    herderFacade: {
      invoke: async (operation, args) => {
        calls.push({ operation, args });
        return { execution_ref: "execution-owned-by-herder", state: "registered" };
      },
    },
  });
  const result = await client.callTool({
    name: "run_and_resume",
    arguments: {
      command: "touch must-not-exist",
      cwd: stateDir,
      target: { agent: "opencode", session_id: "ses_job", cwd: stateDir },
    },
  });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(String((result.content[0] as { text: string }).text))).toEqual({
    execution_ref: "execution-owned-by-herder", state: "registered",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.operation).toBe("run_and_resume");
  expect(Object.isFrozen(calls[0]?.args)).toBe(true);
  expect("jobs" in runtime).toBe(false);
  expect(existsSync(join(stateDir, "jobs"))).toBe(false);
  expect(existsSync(join(stateDir, "must-not-exist"))).toBe(false);
});
