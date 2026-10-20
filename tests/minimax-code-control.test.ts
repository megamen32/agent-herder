import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MinimaxCodeControl } from "../src/adapters/minimax-code-control.js";

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
  it("steers the running turn of a session", async () => {
    const { control, recorded } = await publishControl((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, turn_id: "turn-7" }));
    });

    const result = await control.steer("mvs_1", "свернись");

    expect(result.ok).toBe(true);
    expect(recorded[0]?.method).toBe("POST");
    expect(recorded[0]?.url).toBe("/minimax-desktop/api/v1/session/mvs_1/steer");
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ content: "свернись" });
    expect((result.body as { turn_id?: string }).turn_id).toBe("turn-7");
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
});
