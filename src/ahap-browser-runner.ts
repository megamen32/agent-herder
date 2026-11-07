import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { BrowserChatAdapter, type BrowserChatDriver } from "./adapters/browser-chat.js";
import { ChatGptMacCdpDriver } from "./adapters/chatgpt-mac-cdp-driver.js";
import { DirectCdpPageTools } from "./adapters/direct-cdp-page-tools.js";

type RpcId = string | number;
type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type BrowserAdapterPort = Pick<BrowserChatAdapter,
  "init" | "listSessions" | "getSession" | "getSessionMessages" | "sendMessage" | "createSession">
  & { getAccountScope(): string | undefined; close?(): void };

const METHODS = ["init", "listSessions", "getSession", "getSessionMessages", "sendMessage", "createSession"];
const CONTROL_CAPABILITIES = {
  cancelTurn: false, detach: false, resume: false, terminate: false,
  recover: false, fork: false, modelSwitch: false, subagents: false,
  events: false, steer: false,
};
const ACCOUNT_SCOPE = /^[a-f0-9]{64}$/u;

/** Run the bounded ChatGPT BrowserChatAdapter surface over AHAP v0.1 stdio. */
export async function serveBrowserChatAhap(
  adapter: BrowserAdapterPort,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  expectedAccountScope = process.env.AHAP_CHATGPT_ACCOUNT_SCOPE,
): Promise<void> {
  if (!expectedAccountScope || !ACCOUNT_SCOPE.test(expectedAccountScope)) {
    throw new Error("AHAP_CHATGPT_ACCOUNT_SCOPE must be a pinned SHA-256 account scope");
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.once("close", () => adapter.close?.());
  let initialized = false;
  let accountVerified = false;
  let stopped = false;
  const write = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const assertAccount = () => {
    if (!accountVerified || adapter.getAccountScope() !== expectedAccountScope) {
      throw new Error("pinned ChatGPT account scope mismatch");
    }
  };

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    let request: RpcRequest;
    try { request = JSON.parse(line) as RpcRequest; }
    catch { error(null, -32700, "parse error"); continue; }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      error(null, -32600, "invalid request");
      continue;
    }
    const id = typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || id === null) {
      if (id !== null) error(id, -32600, "invalid request");
      continue;
    }
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : {};
    if (request.method === "initialize") {
      if (initialized || params.harness !== "chatgpt" || params.ahapVersion !== "0.1") {
        error(id, -32602, "expected one AHAP 0.1 initialize for chatgpt");
        continue;
      }
      initialized = true;
      write({ jsonrpc: "2.0", id, result: {
        harness: "chatgpt", name: "ChatGPT BrowserChatAdapter",
        capabilities: { methods: METHODS, controlCapabilities: CONTROL_CAPABILITIES },
      } });
      continue;
    }
    if (!initialized) { error(id, -32600, "initialize must be the first request"); continue; }
    if (request.method === "shutdown") {
      write({ jsonrpc: "2.0", id, result: null });
      stopped = true;
      lines.close();
      continue;
    }

    try {
      let result: unknown;
      switch (request.method) {
        case "init":
          await adapter.init();
          if (adapter.getAccountScope() !== expectedAccountScope) {
            throw new Error("pinned ChatGPT account scope mismatch");
          }
          accountVerified = true;
          result = null;
          break;
        case "listSessions":
          assertAccount();
          result = await adapter.listSessions(params.options as never);
          break;
        case "getSession":
          assertAccount();
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "getSession requires session id"); continue; }
          result = await adapter.getSession(params.id);
          break;
        case "getSessionMessages":
          assertAccount();
          if (typeof params.id !== "string" || !params.id.trim()
            || (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200))) {
            error(id, -32602, "getSessionMessages requires session id and a limit from 1 to 200");
            continue;
          }
          result = await adapter.getSessionMessages(params.id, params.limit as number | undefined);
          break;
        case "sendMessage": {
          assertAccount();
          if (typeof params.id !== "string" || !params.id.trim() || !isSendOptions(params.options)) {
            error(id, -32602, "sendMessage requires session id and message");
            continue;
          }
          result = await adapter.sendMessage(params.id, params.options);
          const receipt = result as { admissionUnknown?: boolean; nonRetryable?: boolean };
          if (receipt.admissionUnknown || (result as { ok?: boolean }).ok === false) {
            error(id, -32000, "ChatGPT send outcome unknown", { outcome: "unknown", retryable: false });
            continue;
          }
          break;
        }
        case "createSession":
          assertAccount();
          if (!isCreateOptions(params.options)) { error(id, -32602, "createSession requires a name and absolute cwd"); continue; }
          result = await adapter.createSession(params.options);
          break;
        default: error(id, -32601, "method not implemented"); continue;
      }
      write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch {
      const mutation = request.method === "sendMessage" || request.method === "createSession"
        || request.method === "stopTurn" || request.method === "changeModel";
      error(id, -32000, "ChatGPT adapter call failed", mutation
        ? { outcome: "unknown", retryable: false } : { outcome: "read_failed" });
    }
  }
}

function isSendOptions(value: unknown): value is Parameters<BrowserChatAdapter["sendMessage"]>[1] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.message === "string" && options.message.length > 0
    && options.message.length <= 16_000 && (options.queue === undefined || typeof options.queue === "boolean");
}
function isCreateOptions(value: unknown): value is Parameters<BrowserChatAdapter["createSession"]>[0] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.name === "string" && !!options.name.trim()
    && typeof options.cwd === "string" && options.cwd.startsWith("/");
}
async function makeConfiguredAdapter(): Promise<BrowserAdapterPort> {
  const endpoint = process.env.AHAP_CHATGPT_CDP_WS_URL?.trim();
  const contextId = process.env.AHAP_CHATGPT_CDP_CONTEXT_ID?.trim();
  const targetId = process.env.AHAP_CHATGPT_CDP_TARGET_ID?.trim();
  const expectedScope = process.env.AHAP_CHATGPT_ACCOUNT_SCOPE?.trim();
  if (!endpoint || !contextId || !targetId || !expectedScope || !ACCOUNT_SCOPE.test(expectedScope)) {
    throw new Error("Pinned ChatGPT CDP endpoint, context, target and account scope are required");
  }
  const pageTools = new DirectCdpPageTools({ endpoint, contextId, targetId });
  const driver: BrowserChatDriver = new ChatGptMacCdpDriver(pageTools, 1, 0, expectedScope);
  const adapter = new BrowserChatAdapter(driver, { id: "chatgpt", name: "ChatGPT browser", harness: "chatgpt", cwd: process.cwd() }, process.cwd(), true);
  return Object.assign(adapter, { getAccountScope: () => driver.getAccountScope?.(), close: () => pageTools.close() });
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || process.env.AHAP_HARNESS !== "chatgpt") {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=chatgpt are required");
  }
  const adapter = await makeConfiguredAdapter();
  await serveBrowserChatAhap(adapter);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    process.stderr.write(`[ahap-chatgpt] ${cause instanceof Error ? cause.message : "startup failure"}\n`);
    process.exitCode = 1;
  });
}
