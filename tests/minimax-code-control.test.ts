import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MinimaxCodeControl, minimaxExecArgs } from "../src/adapters/minimax-code-control.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

const servers: Server[] = [];
const created: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function publishControl(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<{ control: MinimaxCodeControl; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      recorded.push({ method: request.method ?? "", url: request.url ?? "", body });
      handler(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const dir = await mkdtemp(join(tmpdir(), "minimax-code-control-"));
  created.push(dir);
  const manifestPath = join(dir, "mcode-diagnostic.json");
  await writeFile(manifestPath, JSON.stringify({ port, host: "127.0.0.1", pid: process.pid, owner: "electron" }));

  return { control: new MinimaxCodeControl({ manifestPath, manifestTtlMs: 0 }), recorded };
}

describe("MinimaxCodeControl", () => {
  it("binds only an allowlisted invocation policy to the exact exec argv", () => {
    expect(minimaxExecArgs("mvs_exact", "/work", "full")).toEqual([
      "exec", "--cwd", "/work", "--session", "mvs_exact", "--permission", "full",
      "--input", "-", "--input-format", "text", "--output-format", "json",
    ]);
    expect(minimaxExecArgs("mvs_exact", "/work")).toEqual([
      "exec", "--cwd", "/work", "--session", "mvs_exact", "--input", "-", "--input-format", "text", "--output-format", "json",
    ]);
  });

  it("steers the running turn of a session through its queued item", async () => {
    const { control, recorded } = await publishControl((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.endsWith("/queue")) {
        response.end(JSON.stringify({ item_id: "queue-1", status: "queued" }));
        return;
      }
      response.end(JSON.stringify({ success: true, turn_id: "turn-7" }));
    });

    const result = await control.steer("mvs_1", "свернись");

    expect(result.ok).toBe(true);
    expect(recorded.map((call) => call.url)).toEqual([
      "/minimax-desktop/api/v1/session/mvs_1/queue",
      "/minimax-desktop/api/v1/session/mvs_1/steer",
    ]);
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ content: "свернись" });
    expect(JSON.parse(recorded[1]?.body ?? "{}")).toEqual({ content: "свернись", queue_item_id: "queue-1" });
    expect((result.body as { turn_id?: string }).turn_id).toBe("turn-7");
  });

  it("keeps a steer that lost its queue item, because the message was delivered anyway", async () => {
    const { control } = await publishControl((request, response) => {
      if (request.url?.endsWith("/queue")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ item_id: "queue-2", status: "queued" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 404, key: "local_queue_item_not_found", message: "No queued item is available" }));
    });

    const result = await control.steer("mvs_2", "свернись");

    expect(result.ok).toBe(true);
    expect((result.body as { item_id?: string }).item_id).toBe("queue-2");
  });

  it("enqueues a message for the next turn", async () => {
    const { control, recorded } = await publishControl((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ item_id: "queue-2", status: "pending" }));
    });

    const result = await control.enqueue("mvs_2", "в очередь");

    expect(result.ok).toBe(true);
    expect(recorded[0]?.url).toBe("/minimax-desktop/api/v1/session/mvs_2/queue");
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ content: "в очередь" });
    expect((result.body as { item_id?: string }).item_id).toBe("queue-2");
  });

  it("reads the first event frame of a streamed send", async () => {
    const { control, recorded } = await publishControl((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "turn_started", turn_id: "turn-9" })}\n\n`);
    });

    const result = await control.sendMessage("mvs_3", "привет");

    expect(result.ok).toBe(true);
    expect(recorded[0]?.url).toBe("/minimax-desktop/api/v1/session/mvs_3/message");
    expect((result.body as { turn_id?: string }).turn_id).toBe("turn-9");
  });

  it("aborts the running turn", async () => {
    const { control, recorded } = await publishControl((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true }));
    });

    const result = await control.abort("mvs_4", "остановись");

    expect(result.ok).toBe(true);
    expect(recorded[0]?.url).toBe("/minimax-desktop/api/v1/session/mvs_4/abort");
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ reason: "остановись" });
  });

  it("reports the runtime error of a refused request", async () => {
    const { control } = await publishControl((_request, response) => {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "SESSION_ARCHIVED", message: "Session is archived" }));
    });

    const result = await control.steer("mvs_5", "привет");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.error).toContain("Session is archived");
  });

  it("refuses every call while the desktop app publishes no transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimax-code-control-"));
    created.push(dir);
    const control = new MinimaxCodeControl({ manifestPath: join(dir, "missing.json") });

    expect(await control.available()).toBe(false);
    const result = await control.sendMessage("mvs_6", "привет");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not published");
  });

  it("runs only the exact existing session ID, sends content on stdin, and strips router credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "minimax-code-cli-test-"));
    created.push(dir);
    const cli = join(dir, "mcode-fake");
    await writeFile(cli, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const expected = ["exec", "--cwd", ${JSON.stringify(dir)}, "--session", "mvs_exact", "--input", "-", "--input-format", "text", "--output-format", "json"];
    const valid = JSON.stringify(process.argv.slice(2)) === JSON.stringify(expected)
    && process.env.MINIMAX_DATA_DIR === ${JSON.stringify(dir)} && !process.env.MAVIS_DATA_DIR
    && input === "private-marker-stdin"
    && !process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL && !process.env.OMNIROUTE_API_KEY && !process.env.OMNIROUTE_BASE_URL;
  process.stdout.write(JSON.stringify(valid
    ? { sessionId: "mvs_exact", turnId: "turn_1", status: "succeeded", model: { providerId: "minimax", modelId: "MiniMax-M3.1-Flash", providerKind: "minimax-managed" } }
    : { error: "fake_cli_contract_failed" }));
});
`);
    await chmod(cli, 0o700);
    const control = new MinimaxCodeControl({ cliPath: cli, manifestPath: join(dir, "missing.json") });

    const result = await control.runSession("mvs_exact", dir, dir, "private-marker-stdin");

    expect(result).toMatchObject({ ok: true, body: { sessionId: "mvs_exact", turnId: "turn_1", status: "succeeded" } });
    expect(JSON.stringify(result)).not.toContain("private-marker-stdin");
  });
});
