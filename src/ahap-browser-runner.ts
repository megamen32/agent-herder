import { writeAhapFrame, AHAP_MAX_FRAME_BYTES, legacyReadMethods, legacyRead, AhapReadError, adapterFailureContext, type LegacyReadPort } from "./ahap-legacy-read.js";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { BrowserChatAdapter } from "./adapters/browser-chat.js";
import { ChatGptMacCdpDriver } from "./adapters/chatgpt-mac-cdp-driver.js";
import { ZaiCdpDriver } from "./adapters/zai-cdp-driver.js";
import { isOwnedTabUrl } from "./adapters/browser-owned-tab.js";
import { DirectCdpPageTools, type DirectCdpConfig } from "./adapters/direct-cdp-page-tools.js";
import { MacMiniChromeTransport, type ChromePageTools } from "./adapters/mac-mini-chrome-transport.js";

type RpcId = string | number;
type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type BrowserAdapterPort = Pick<BrowserChatAdapter,
  "init" | "listSessions" | "getSession" | "getSessionMessages" | "sendMessage" | "createSession">
  & Partial<Pick<BrowserChatAdapter, "archiveSession" | "supportsArchive">> & LegacyReadPort & { readonly type: string; readonly name: string; readonly browserFeatures: unknown; getAccountScope(): string | undefined; verifyPinnedAccountScope?(): Promise<void>; close?(): void };

const METHODS = ["init", "listSessions", "getSession", "getSessionMessages", "sendMessage", "createSession"];
const CONTROL_CAPABILITIES = {
  cancelTurn: false, detach: false, resume: false, terminate: false,
  recover: false, fork: false, modelSwitch: false, subagents: false,
  events: false, steer: false,
};
const ACCOUNT_SCOPE = /^[a-f0-9]{64}$/u;

type InitStage = "adapter_init" | "verify_pinned_account" | "account_match";
// Exact known literals only: never expose or classify arbitrary error suffixes.
const INIT_REASONS = new Map<string, string>([
  ["pinned browser account scope mismatch", "account_scope_mismatch"],
  ["ChatGPT pinned account scope mismatch; no read data returned", "account_scope_mismatch"],
  ["Pinned ChatGPT page unavailable; no read data returned", "pinned_page_unavailable"],
  ["Configured ChatGPT page unavailable; no page fallback allowed", "pinned_page_unavailable"],
  ["Configured Z.ai page unavailable; no page fallback allowed", "pinned_page_unavailable"],
  ["ChatGPT Mac mini tab is not an authenticated page", "authentication_required"],
  ["ZAI Chrome tab is not a logged-in chat page; sign in in Mac mini Chrome", "authentication_required"],
  ["Mac mini Chrome operation timeout; do not replay an uncertain write", "transport_timeout"],
  ["direct_cdp_connect_timeout", "transport_timeout"],
  ["direct_cdp_closed", "transport_disconnected"],
  ["direct_cdp_connect_closed", "transport_disconnected"],
  ["direct_cdp_disconnected", "transport_disconnected"],
  ["direct_cdp_disconnected; operation outcome may be unknown", "transport_disconnected"],
  ["Mac mini Chrome gateway returned no JSON", "transport_no_json"],
  ["Chrome evaluation did not return a JSON value", "evaluation_invalid"],
  ["direct_cdp_evaluate_no_value", "evaluation_invalid"],
  ["direct_cdp_target_context_mismatch", "target_context_mismatch"],
  ["Chrome MCP response exceeds bound", "response_too_large"],
]);


/** Run the bounded browser BrowserChatAdapter surface over AHAP v0.1 stdio. */
export async function serveBrowserChatAhap(
  adapter: BrowserAdapterPort,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  expectedAccountScope = process.env.AHAP_BROWSER_ACCOUNT_SCOPE ?? process.env.AHAP_CHATGPT_ACCOUNT_SCOPE,
): Promise<void> {
  if (!expectedAccountScope || !ACCOUNT_SCOPE.test(expectedAccountScope)) {
    throw new Error("AHAP_CHATGPT_ACCOUNT_SCOPE must be a pinned SHA-256 account scope");
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.once("close", () => adapter.close?.());
  let initialized = false;
  let accountVerified = false;
  let stopped = false;
  const write = (value: unknown) => writeAhapFrame(output, value);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const assertAccount = () => {
    if (!accountVerified || adapter.getAccountScope() !== expectedAccountScope) {
      throw new Error("pinned browser account scope mismatch");
    }
  };
  const assertCurrentAccount = async () => {
    assertAccount();
    await adapter.verifyPinnedAccountScope?.();
    assertAccount();
  };

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    if (Buffer.byteLength(line, "utf8") + 1 > AHAP_MAX_FRAME_BYTES) { error(null, -32600, "Request exceeds 4 MiB AHAP frame limit; reduce input size"); continue; }
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
      if (initialized || params.harness !== adapter.type || params.ahapVersion !== "0.1") {
        error(id, -32602, `expected one AHAP 0.1 initialize for ${adapter.type}`);
        continue;
      }
      initialized = true;
      write({ jsonrpc: "2.0", id, result: {
        harness: adapter.type, name: adapter.name,
        capabilities: { deliveryModes: ["queue"], methods: [...new Set([...METHODS, ...(adapter.archiveSession && adapter.supportsArchive?.() !== false ? ["archiveSession"] : []), ...legacyReadMethods(adapter)])], controlCapabilities: CONTROL_CAPABILITIES, browserFeatures: adapter.browserFeatures },
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

    let initStage: InitStage = "adapter_init";
    try {
      let result: unknown;
      switch (request.method) {
        case "init":
          accountVerified = false;
          if (adapter.verifyPinnedAccountScope) {
            initStage = "verify_pinned_account";
            await adapter.verifyPinnedAccountScope();
          }
          initStage = "adapter_init";
          await adapter.init();
          initStage = "account_match";
          if (adapter.getAccountScope() !== expectedAccountScope) {
            throw new Error("pinned browser account scope mismatch");
          }
          accountVerified = true;
          result = null;
          break;
        case "listSessions":
        case "getRawTranscript":
        case "listProjects":
          await assertCurrentAccount();
          result = await legacyRead(adapter, request.method, params);
          await assertCurrentAccount();
          break;
        case "getSession":
          await assertCurrentAccount();
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "getSession requires session id"); continue; }
          result = await adapter.getSession(params.id);
          await assertCurrentAccount();
          break;
        case "getSessionMessages":
          await assertCurrentAccount();
          if (typeof params.id !== "string" || !params.id.trim()
            || (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200))) {
            error(id, -32602, "getSessionMessages requires session id and a limit from 1 to 200");
            continue;
          }
          result = await adapter.getSessionMessages(params.id, params.limit as number | undefined);
          await assertCurrentAccount();
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
            error(id, -32000, "Browser send outcome unconfirmed", adapterFailureContext("sendMessage", true));
            continue;
          }
          break;
        }
        case "archiveSession":
          if (!adapter.archiveSession || adapter.supportsArchive?.() === false) { error(id, -32601, "archive not supported"); continue; }
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "archiveSession requires session id"); continue; }
          await assertCurrentAccount();
          result = await adapter.archiveSession(params.id);
          break;
        case "createSession":
          assertAccount();
          if (!isCreateOptions(params.options)) { error(id, -32602, "createSession requires a name and absolute cwd"); continue; }
          result = await adapter.createSession(params.options);
          break;
        default: error(id, -32601, "method not implemented"); continue;
      }
      write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (cause) {
      if (request.method === "init") {
        error(id, -32000, "Browser adapter initialization failed", {
          ...adapterFailureContext("init", false), stage: initStage,
          reason: cause instanceof Error ? INIT_REASONS.get(cause.message) ?? "unknown" : "unknown",
        });
        continue;
      }
      if (cause instanceof AhapReadError) {
        error(id, cause.code, cause.message, cause.code === -32001 ? adapterFailureContext(request.method, request.method === "sendMessage" || request.method === "createSession") : undefined);
        continue;
      }
      const mutation = request.method === "sendMessage" || request.method === "createSession"
        || request.method === "archiveSession" || request.method === "stopTurn" || request.method === "changeModel";
      error(id, -32000, "Browser adapter call failed", adapterFailureContext(request.method, mutation));
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
export interface BrowserChatRunnerTransportFactories {
  directCdp(config: DirectCdpConfig): ChromePageTools;
  macMini(): ChromePageTools;
}

const DEFAULT_TRANSPORT_FACTORIES: BrowserChatRunnerTransportFactories = {
  directCdp: config => new DirectCdpPageTools(config),
  macMini: () => new MacMiniChromeTransport(),
};


export function makeConfiguredAdapter(
  env: NodeJS.ProcessEnv = process.env,
  factories: BrowserChatRunnerTransportFactories = DEFAULT_TRANSPORT_FACTORIES,
): BrowserAdapterPort {
  const harness = env.AHAP_HARNESS?.trim();
  if (harness !== "chatgpt" && harness !== "zai") throw new Error("AHAP_HARNESS must explicitly select chatgpt or zai");
  const transport = (env.AHAP_BROWSER_TRANSPORT ?? env.AHAP_CHATGPT_TRANSPORT)?.trim();
  if (transport !== "direct-cdp" && transport !== "mac-mini") {
    throw new Error("AHAP_BROWSER_TRANSPORT must explicitly select direct-cdp or mac-mini");
  }
  // The page number is only a first-use hint. The driver owns exactly one
  // tab per provider and finds it by its own marker, so a gateway restart or
  // a closed tab never breaks the route and never opens a tab per call.
  const rawPageId = (env.AHAP_BROWSER_PAGE_ID ?? env.AHAP_CHATGPT_PAGE_ID ?? env.AGENT_HERDER_ZAI_PAGE_ID)?.trim();
  const pageId = rawPageId && /^[1-9][0-9]*$/u.test(rawPageId) ? Number(rawPageId) : undefined;
  const expectedScope = (env.AHAP_BROWSER_ACCOUNT_SCOPE ?? env.AHAP_CHATGPT_ACCOUNT_SCOPE)?.trim();
  if (!expectedScope || !ACCOUNT_SCOPE.test(expectedScope)) {
    throw new Error("Exact account scope is required");
  }

  let selectedTransport: ChromePageTools;
  if (transport === "mac-mini") {
    selectedTransport = factories.macMini();
  } else {
    const endpoint = (env.AHAP_BROWSER_CDP_WS_URL ?? env.AHAP_CHATGPT_CDP_WS_URL)?.trim();
    const contextId = (env.AHAP_BROWSER_CDP_CONTEXT_ID ?? env.AHAP_CHATGPT_CDP_CONTEXT_ID)?.trim();
    const targetId = (env.AHAP_BROWSER_CDP_TARGET_ID ?? env.AHAP_CHATGPT_CDP_TARGET_ID)?.trim();
    if (!endpoint || !contextId || !targetId) {
      throw new Error("Direct CDP requires endpoint, context and target IDs");
    }
    selectedTransport = factories.directCdp({ endpoint, contextId, targetId });
  }
  // The driver owns exactly one tab per provider and finds it by its own
  // marker, so a gateway restart or a closed tab never breaks the route.
  const pageTools: ChromePageTools = {
    async call(name, args = {}) {
      const result = await selectedTransport.call(name, args);
      if (name !== "list_pages") return result;
      const origin = harness === "chatgpt" ? "chatgpt\\.com" : "chat\\.z\\.ai";
      const exactPagePattern = new RegExp(`^\\s*${pageId}\\s*:.*?\\(https://${origin}(?:/[^)]*)?\\)`);
      const originPattern = new RegExp(`\(https://${origin}(?:/[^)]*)?\)`);
      const candidates = result.split("\n").filter(line => originPattern.test(line));
      if (!candidates.length) return "";
      // The driver owns exactly one tab per provider and finds it by its own
      // marker. Hiding the other tabs of the same site here would make that
      // ownership unverifiable, so the marked tab comes first and the rest
      // stay visible for the driver to probe read-only.
      const marked = candidates.filter(line => isOwnedTabUrl(line.match(originPattern)![0]!.slice(1, -1), harness));
      const rest = candidates.filter(line => !marked.includes(line));
      return [...marked, ...rest].join("\n");
    },
  };
  const driver = harness === "chatgpt"
    ? new ChatGptMacCdpDriver(pageTools, undefined, 0, expectedScope)
    : new ZaiCdpDriver(pageTools, undefined, 0);
  const provider = { id: harness, name: harness === "chatgpt" ? "ChatGPT browser" : "Z.ai browser", harness, cwd: process.cwd() } as const;
  const adapter = new BrowserChatAdapter(driver, provider, process.cwd(), true);
  let verifiedAccountScope: string | undefined;
  return Object.assign(adapter, {
    getAccountScope: () => driver.getAccountScope?.() ?? verifiedAccountScope,
    verifyPinnedAccountScope: async () => {
      verifiedAccountScope = undefined;
      if (harness === "chatgpt") await (driver as ChatGptMacCdpDriver).verifyPinnedAccountScope();
      else {
        await (driver as ZaiCdpDriver).verifyPinnedAccountScope(expectedScope);
        verifiedAccountScope = driver.getAccountScope();
      }
    },
    close: () => {
      if ("close" in selectedTransport && typeof selectedTransport.close === "function") selectedTransport.close();
    },
  });
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || !["chatgpt", "zai"].includes(process.env.AHAP_HARNESS || "")) {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=chatgpt|zai are required");
  }
  const adapter = await makeConfiguredAdapter();
  await serveBrowserChatAhap(adapter);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    process.stderr.write(`[ahap-browser] ${cause instanceof Error ? cause.message : "startup failure"}\n`);
    process.exitCode = 1;
  });
}
