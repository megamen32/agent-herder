import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ZcodeAppServerClient } from "../src/adapters/zcode-protocol.js";

const fixture = join(process.cwd(), "tests/fixtures/fake-zcode-app-server.mjs");

describe("ZCode app-server protocol client", () => {
  it("reports unexpected transport death once but not intentional disposal", async () => {
    const client = new ZcodeAppServerClient({ command: process.execPath, args: [fixture], startupTimeoutMs: 3000 });
    const errors: Error[] = [];
    const unsubscribe = client.onDisconnect((error) => errors.push(error));
    try {
      await client.start();
      const child = (client as unknown as { child: ChildProcessWithoutNullStreams }).child;
      child.kill("SIGTERM");
      for (let attempt = 0; attempt < 100 && errors.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(errors).toHaveLength(1);
      await client.start();
      await client.close();
      expect(errors).toHaveLength(1);
    } finally { unsubscribe(); await client.close(); }
  });
  it("performs the hello handshake and exchanges framed channel RPC", async () => {
    const client = new ZcodeAppServerClient({
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      startupTimeoutMs: 3000,
      requestTimeoutMs: 3000,
    });
    try {
      await client.start();
      const result = await client.call("zcode-agent", "initialize", [{ workspacePath: "/workspace", workspaceIdentity: "/workspace" }]);
      expect(result).toEqual({ available: true, protocolName: "ZCode Protocol", protocolVersion: 1, transportKind: "stdio" });
      const event = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("event timeout")), 1000);
        const stop = client.listen("zcode-task", "onDynamicTaskEvent", { taskId: "session-1" }, (payload) => { clearTimeout(timer); stop(); resolve(payload); });
      });
      expect(event).toEqual({ type: "task_complete", taskId: "session-1" });
    } finally {
      await client.close();
    }
  });
});
