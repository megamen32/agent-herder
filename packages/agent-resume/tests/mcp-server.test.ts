import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createResumeMcpServer } from "../src/mcp/server.js";
import { ReceiptLedger } from "../src/resume/receipts.js";

// Focused integration: the standalone MCP surface over an in-memory transport.
// Expected <2s/max 20s. No harness, provider or spawned process.
async function connect(stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-"))) {
  const runtime = createResumeMcpServer({ stateDir });
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
  expect(payload).toMatchObject({ ok: true, state_dir: stateDir });
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

it("admits a bound target once and replays the receipt", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-resume-"));
  const { client, runtime } = await connect(stateDir);
  const arguments_ = {
    target: { agent: "opencode", session_id: "ses_1", cwd: "/tmp" },
    prompt: "дальше",
    result_ref: "result://1",
    idempotency_key: "mcp-key-1",
    execute: false,
  };
  const first = await client.callTool({ name: "resume_bound_target", arguments: arguments_ });
  const second = await client.callTool({ name: "resume_bound_target", arguments: arguments_ });
  const firstReceipt = JSON.parse(String((first.content[0] as { text: string }).text));
  const secondReceipt = JSON.parse(String((second.content[0] as { text: string }).text));
  expect(firstReceipt.status).toBe("accepted");
  expect(secondReceipt.receipt_id).toBe(firstReceipt.receipt_id);
  expect(new ReceiptLedger({ path: join(stateDir, "receipts.json") }).read("mcp-key-1")?.status).toBe("accepted");

  const receipt = await client.callTool({ name: "get_resume_receipt", arguments: { idempotency_key: "mcp-key-1" } });
  expect(JSON.parse(String((receipt.content[0] as { text: string }).text)).status).toBe("accepted");
  const missing = await client.callTool({ name: "get_resume_receipt", arguments: { idempotency_key: "absent" } });
  expect(missing.isError).toBe(true);
  expect(runtime.jobs.list()).toEqual([]);
});

it("requires an agent when the server has no default", async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: "find_sessions", arguments: { limit: 1 } });
  expect(result.isError).toBe(true);
  expect(String((result.content[0] as { text: string }).text)).toContain("agent is required");
});

it("watches a command and reports the job exactly once", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herder-mcp-job-"));
  const { client } = await connect(stateDir);
  const result = await client.callTool({
    name: "run_and_resume",
    arguments: {
      command: "sleep 0.05",
      cwd: "/tmp",
      target: { agent: "opencode", session_id: "ses_job", cwd: "/tmp" },
      execute_resume: false,
    },
  });
  const payload = JSON.parse(String((result.content[0] as { text: string }).text));
  expect(payload.state).toBe("finished");
  const status = await client.callTool({ name: "wait_job_status", arguments: { job_id: payload.job_id } });
  expect(JSON.parse(String((status.content[0] as { text: string }).text)).job_id).toBe(payload.job_id);
  const missing = await client.callTool({ name: "wait_job_status", arguments: { job_id: "no-such-job" } });
  expect(missing.isError).toBe(true);
}, 20_000);