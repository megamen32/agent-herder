import { spawn } from "node:child_process";

/** Narrow Chrome DevTools MCP transport over the existing Mac mini CDP owner.
 * Each SSH invocation calls the ALREADY-RUNNING local gateway. It never opens
 * another Chrome DevTools socket, starts Chrome, or accesses browser secrets.
 */
export interface ChromePageTools {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
}

export class MacMiniChromeTransport implements ChromePageTools {
  constructor(
    private readonly target = process.env.AGENT_HERDER_MAC_MINI_SSH_TARGET || "roomhacker@192.168.2.4",
    private readonly timeoutMs = 30_000,
  ) {
    if (!/^[a-zA-Z_][\w.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(target)) {
      throw new Error("Invalid trusted Mac mini SSH target");
    }
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid Chrome MCP tool name");
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
    }) + "\n";
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("ssh", [
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=5", this.target,
        "/usr/bin/python3", "/Users/roomhacker/.local/share/mac-chrome-mcp/http_stdio.py",
        "--url", "http://127.0.0.1:50260/mcp",
      ], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("Mac mini Chrome operation timeout; do not replay an uncertain write"), this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 512 * 1024) fail("Chrome MCP response exceeds bound");
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8 * 1024) stderr = stderr.slice(-8 * 1024);
      });
      child.on("error", error => fail("Mac mini SSH unavailable: " + error.message));
      child.on("close", code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) reject(new Error("Mac mini Chrome gateway exited: " + (stderr.trim() || code)));
        else resolve(stdout);
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(payload);
    });
    const line = output.split("\n").find(row => row.trim().startsWith("{"));
    if (!line) throw new Error("Mac mini Chrome gateway returned no JSON");
    const body = JSON.parse(line) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };
    if (body.error) throw new Error("Mac mini Chrome gateway: " + (body.error.message || "unknown error"));
    const content = (body.result?.content || []).map(part => part.text || "").join("\n");
    if (body.result?.isError || /^Error:/m.test(content)) {
      throw new Error("Mac mini Chrome tool failed: " + content.slice(0, 280));
    }
    return content;
  }
}

/** The established DevTools MCP returns a fenced JSON result for evaluate_script. */
export function parseChromeEvaluation<T>(text: string): T {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) throw new Error("Chrome evaluation did not return a JSON value");
  return JSON.parse(match[1]!) as T;
}
