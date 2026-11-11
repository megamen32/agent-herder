import { writeAhapFrame, AHAP_MAX_FRAME_BYTES, legacyReadMethods, legacyRead, AhapReadError, adapterFailureContext, type LegacyReadPort } from "./ahap-legacy-read.js";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { BrowserChatAdapter, browserChatNativeId } from "./adapters/browser-chat.js";
import { UserIoChatGptDriver } from "./adapters/chatgpt-userio-driver.js";
import { ZaiUserIoDriver } from "./adapters/zai-userio-driver.js";
import { userIoMessageDiagnostic } from "./adapters/userio-agent-channel.js";
import { VibeChromePageTools, type VibeChromePageToolsOptions } from "./adapters/vibe-chrome-transport.js";
import { readProtectedBrowserMcpToken, validateBrowserMcpUrl } from "./adapters/browser-mcp-profile.js";
import { ChatGptMacCdpDriver, CHATGPT_MAC_SNAPSHOT, parseChatGptPages } from "./adapters/chatgpt-mac-cdp-driver.js";
import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT, parseZaiPages } from "./adapters/zai-cdp-driver.js";
import { claimOwnedTab, isOwnedTabUrl, OWNED_TAB_QUERY, ownedTabProbeScript, ownedTabUrl, resolveOwnedTab } from "./adapters/browser-owned-tab.js";
import { verifyNewChatAccountScope } from "./adapters/browser-chat-new-page.js";
import { DirectCdpPageTools, type DirectCdpConfig } from "./adapters/direct-cdp-page-tools.js";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "./adapters/mac-mini-chrome-transport.js";
import { VibeChromeTransport, isVibePageOwnershipRefusal, vibeCreatedPageId, vibeOperationReceipt, vibeOwnershipNamespace, vibeStdioParameters, vibeTextBody, type VibeChromeConfig } from "./adapters/vibe-chrome-transport.js";
import { browserTransportSettingsFromEnv } from "./adapters/browser-runtime-settings.js";
import type { AgentSession, SessionMessageView } from "./types/index.js";

type RpcId = string | number;
type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type BrowserAdapterPort = Pick<BrowserChatAdapter,
  "init" | "listSessions" | "getSession" | "getSessionMessages" | "sendMessage" | "createSession">
  & Partial<Pick<BrowserChatAdapter, "archiveSession" | "supportsArchive">> & LegacyReadPort & { readonly type: string; readonly name: string; readonly browserFeatures: unknown; readonly addressedReadsVerifyPinnedScope?: true; getAccountScope(): string | undefined; getOwnedPageNamespace?(): string | undefined; verifyPinnedAccountScope?(): Promise<void>; prepareCanaryObservation?(nativeSessionId: string): Promise<BrowserCanaryViewReceipt>; getCanaryViewReceipt?(): unknown; closeCanaryObservation?(): Promise<{ page_id?: number; closed: boolean }>; readCanaryObservation?(nativeSessionId: string): Promise<BrowserCanaryObservation>; close?(): void | Promise<void> };

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
  ["vibe_mcp_connection_failed", "transport_disconnected"],
  ["vibe_mcp_closed", "transport_disconnected"],
  ["vibe_mcp_outcome_unknown", "transport_outcome_unknown"],
  ["vibe_tool_refused", "transport_refused"],
  ["vibe_operation_pending", "transport_pending"],
  ["vibe_evaluation_pending", "transport_pending"],
  ["vibe_evaluation_invalid", "evaluation_invalid"],
]);

type SendDiagnostic = { stage: "preclick" | "account_check" | "transport" | "native_admission" | "readback" | "send"; reason: string };
// Match the entire known adapter literal, never a prefix or raw suffix. All
// output values are constants; these labels are diagnostic, not no-effect proof.
const SEND_REASONS = new Map<string, SendDiagnostic>();
for (const prefix of ["ChatGPT submission rejected before click: ", "ZAI submission blocked before click: ",
  "ChatGPT first message not submitted: ", "ZAI first message not submitted: "]) {
  for (const reason of ["draft_changed", "send_not_ready"]) {
    SEND_REASONS.set(prefix + reason, { stage: "preclick", reason });
  }
}
for (const message of ["pinned browser account scope mismatch", "ChatGPT pinned account scope mismatch; no read data returned"]) {
  SEND_REASONS.set(message, { stage: "account_check", reason: "account_scope_mismatch" });
}
for (const message of ["Mac mini Chrome operation timeout; do not replay an uncertain write", "direct_cdp_connect_timeout",
  "direct_cdp_timeout:Runtime.evaluate; operation outcome may be unknown; do not retry",
  "direct_cdp_timeout:Runtime.callFunctionOn; operation outcome may be unknown; do not retry"]) {
  SEND_REASONS.set(message, { stage: "transport", reason: "transport_timeout" });
}
for (const prefix of ["ChatGPT submission outcome unknown: ", "ZAI submission outcome unknown: ",
  "ZAI submission admission unknown: "]) {
  for (const suffix of ["do not retry automatically", "no native route",
    "First-message click outcome unknown; do not retry", "First message sent but native chat ID not yet verified; do not retry"]) {
    SEND_REASONS.set(prefix + suffix, { stage: "native_admission", reason: "native_admission_unknown" });
  }
}
SEND_REASONS.set("Message submitted but unique native message receipt unavailable; read history before any retry",
  { stage: "native_admission", reason: "native_admission_unknown" });
SEND_REASONS.set("vibe_mcp_outcome_unknown", { stage: "transport", reason: "native_admission_unknown" });
SEND_REASONS.set("vibe_operation_pending", { stage: "transport", reason: "native_admission_unknown" });
SEND_REASONS.set("vibe_evaluation_pending", { stage: "transport", reason: "native_admission_unknown" });
for (const prefix of ["ChatGPT history unavailable: ", "Z.ai history unavailable: "]) {
  for (const suffix of ["read_cooldown", "history_http_429", "auth_http_401", "account_unavailable", "unexpected response"]) {
    SEND_REASONS.set(prefix + suffix, { stage: "readback", reason: "read_failed" });
  }
}
function sendFailureContext(cause: unknown) {
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  const diagnostic = typeof message === "string" && message.length <= 1024
    ? SEND_REASONS.get(message) ?? userIoMessageDiagnostic(message) : undefined;
  return { ...adapterFailureContext("sendMessage", true), ...(diagnostic ?? { stage: "send", reason: "unknown" }), ...transportReceiptContext(cause) };
}

function transportReceiptContext(cause: unknown) {
  const receipt = vibeOperationReceipt(cause);
  return receipt ? { transport_receipt: receipt } : {};
}


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
  // Only a driver whose addressed native read freshly checks and returns the
  // pinned scope may omit separate remote checks around that same read.
  const assertAddressedReadAccount = async () => {
    if (adapter.addressedReadsVerifyPinnedScope) assertAccount();
    else await assertCurrentAccount();
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
        capabilities: { deliveryModes: ["queue"], methods: [...new Set([...METHODS, ...(adapter.archiveSession && adapter.supportsArchive?.() !== false ? ["archiveSession"] : []), ...legacyReadMethods(adapter).filter(method => method !== "listProjects" || (adapter.browserFeatures as {projects?:boolean} | undefined)?.projects !== false)])], controlCapabilities: CONTROL_CAPABILITIES, browserFeatures: adapter.browserFeatures },
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
        case "listProjects":
          if (request.method === "listProjects" && (adapter.browserFeatures as {projects?:boolean} | undefined)?.projects === false) { error(id, -32601, "projects not supported"); continue; }
          await assertCurrentAccount();
          result = await legacyRead(adapter, request.method, params);
          await assertCurrentAccount();
          break;
        case "getRawTranscript":
          await assertAddressedReadAccount();
          result = await legacyRead(adapter, request.method, params);
          await assertAddressedReadAccount();
          break;
        case "getSession":
          await assertCurrentAccount();
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "getSession requires session id"); continue; }
          result = await adapter.getSession(params.id);
          await assertCurrentAccount();
          break;
        case "getSessionMessages":
          await assertAddressedReadAccount();
          if (typeof params.id !== "string" || !params.id.trim()
            || (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200))) {
            error(id, -32602, "getSessionMessages requires session id and a limit from 1 to 200");
            continue;
          }
          result = await adapter.getSessionMessages(params.id, params.limit as number | undefined);
          await assertAddressedReadAccount();
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
            error(id, -32000, "Browser send outcome unconfirmed", sendFailureContext((result as { error?: unknown }).error));
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
          ...transportReceiptContext(cause),
        });
        continue;
      }
      if (cause instanceof AhapReadError) {
        if (request.method === "sendMessage") {
          error(id, cause.code, "Browser adapter call failed", sendFailureContext(cause));
        } else {
          error(id, cause.code, cause.message, cause.code === -32001 ? adapterFailureContext(request.method, request.method === "createSession") : undefined);
        }
        continue;
      }
      const mutation = request.method === "sendMessage" || request.method === "createSession"
        || request.method === "archiveSession" || request.method === "stopTurn" || request.method === "changeModel";
      error(id, -32000, "Browser adapter call failed", request.method === "sendMessage"
        ? sendFailureContext(cause) : { ...adapterFailureContext(request.method, mutation), ...transportReceiptContext(cause) });
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
type OwnedCanaryDom = {
  origin: string; path: string; url: string; phase: "generating" | "idle" | "unknown";
  authenticated: boolean; composer: boolean; securityVerification: boolean;
};

export interface BrowserCanaryViewReceipt {
  native_session_id: string;
  native_conversation_id: string;
  owned_page_id: number;
  owned_page_namespace: string;
  source_route: string;
  creation_receipt: string;
  navigation_receipt: string;
  observedAt: string;
}

export interface BrowserCanaryObservation {
  /** Completeness is limited to this exact owned current conversation. */
  complete: true;
  observedAt: string;
  session: AgentSession;
  proof: {
    capability: "owned-current-conversation";
    account_scope_sha256: string;
    native_session_id: string;
    native_conversation_id: string;
    owned_page_id: number;
    owned_page_url: string;
    owned_page_namespace: string | null;
    owned_view_receipt?: BrowserCanaryViewReceipt;
    canonical_status: "running" | "idle";
    native_messages_receipt: { native_session_id: string; native_conversation_id: string; observedAt: string; window_limit: number; messages: SessionMessageView[] };
    dom_generation_state_receipt: { observedAt: string; source: "owned-current-dom"; raw: OwnedCanaryDom };
  };
}

/** Read only the already selected owned canary. It never navigates or surveys account-wide activity. */
export async function readBrowserCanaryObservation(options: {
  harness: "chatgpt" | "zai";
  nativeSessionId: string;
  accountScope: string;
  tools: ChromePageTools;
  adapter: Pick<BrowserChatAdapter, "getSession" | "getSessionMessages">;
  verifyAccount(pageId: number): Promise<string | undefined>;
}): Promise<BrowserCanaryObservation> {
  const { harness, nativeSessionId, accountScope, tools, adapter } = options;
  if (!ACCOUNT_SCOPE.test(accountScope) || !nativeSessionId) throw new Error("browser_canary_identity_required");
  // This is the adapter's existing normalization, including provider isolation.
  const nativeId = browserChatNativeId(nativeSessionId, harness, true);
  let routeId = harness === "zai" && nativeId.startsWith("route:") ? nativeId.slice(6) : nativeId;
  let expectedPath = nativeId.startsWith("draft:") ? undefined : `/c/${routeId}`;
  const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
  const isConversationPath = (path: unknown): path is string => typeof path === "string"
    && path.startsWith("/c/") && path.length > 3 && !path.slice(3).includes("/");
  const verifyAccount = async (pageId: number) => {
    if (await options.verifyAccount(pageId) !== accountScope) throw new Error("browser_canary_account_mismatch");
  };
  const ownedPage = async () => {
    const listing = await tools.call("list_pages");
    const pages = harness === "chatgpt" ? parseChatGptPages(listing) : parseZaiPages(listing);
    const page = await resolveOwnedTab(tools, harness, pages, accountScope);
    if (!page) throw new Error("browser_canary_owned_page_unavailable");
    return page;
  };
  const dom = async (pageId: number): Promise<OwnedCanaryDom> => {
    const source = harness === "chatgpt" ? CHATGPT_MAC_SNAPSHOT : ZAI_ACTIVITY_SCRIPT;
    const raw = parseChromeEvaluation<OwnedCanaryDom>(await tools.call("evaluate_script", {
      pageId, function: `() => { const s=(${source})(); return {
        origin:s.origin,path:s.path,url:location.href,phase:s.phase,
        authenticated:${harness === "chatgpt" ? "s.authenticated" : "s.loggedIn"},
        composer:s.composer,securityVerification:s.securityVerification===true}; }`,
    }));
    if (!raw || raw.origin !== origin || !isConversationPath(raw.path) || (expectedPath !== undefined && raw.path !== expectedPath)) throw new Error("browser_canary_current_conversation_mismatch");
    let url: URL;
    try { url = new URL(raw.url); } catch { throw new Error("browser_canary_current_url_invalid"); }
    if (url.origin !== origin || url.pathname !== raw.path || url.username || url.password) throw new Error("browser_canary_current_url_invalid");
    if (raw.authenticated !== true || raw.composer !== true || raw.securityVerification || !["generating", "idle"].includes(raw.phase)) {
      throw new Error("browser_canary_dom_state_unverified");
    }
    return raw;
  };
  const beforePage = await ownedPage();
  const beforeDom = await dom(beforePage.id); // Refuse a different current conversation before reading its messages.
  await verifyAccount(beforePage.id);
  const session = await adapter.getSession(nativeSessionId);
  if (!session || session.id !== nativeSessionId || session.harness !== harness) throw new Error("browser_canary_native_session_mismatch");
  if (nativeId.startsWith("draft:")) {
    // First-message admission binds the stable control handle to sourceRoute.
    // Keep using that handle; never make the caller replace its session ID.
    if (session.meta?.pendingRemoteCreation !== false || typeof session.meta.sourceRoute !== "string") throw new Error("browser_canary_native_binding_unverified");
    let route: URL;
    try { route = new URL(session.meta.sourceRoute); } catch { throw new Error("browser_canary_native_binding_unverified"); }
    if (route.origin !== origin || !isConversationPath(route.pathname) || route.username || route.password || route.search || route.hash) throw new Error("browser_canary_native_binding_unverified");
    expectedPath = route.pathname;
    routeId = route.pathname.slice(3);
    if (beforeDom.path !== expectedPath) throw new Error("browser_canary_current_conversation_mismatch");
  }
  const messages = await adapter.getSessionMessages(nativeSessionId, 200);
  if (!Array.isArray(messages) || messages.length >= 200) throw new Error("browser_canary_message_window_unverified");
  const messagesAt = new Date().toISOString();
  const afterPage = await ownedPage();
  if (beforePage.id !== afterPage.id) throw new Error("browser_canary_owned_page_changed");
  await verifyAccount(afterPage.id);
  const raw = await dom(afterPage.id);
  const observedAt = new Date().toISOString();
  const status = raw.phase === "generating" ? "running" : "idle";
  return {
    complete: true, observedAt,
    // Deliberately replace the inventory's cached/heuristic activity status with
    // the verified current DOM phase. This is not an account-wide status claim.
    session: { ...session, status },
    proof: {
      capability: "owned-current-conversation", account_scope_sha256: accountScope,
      native_session_id: nativeSessionId, owned_page_id: afterPage.id, owned_page_url: raw.url,
      native_conversation_id: routeId,
      owned_page_namespace: tools.ownedTabNamespace ?? null,
      canonical_status: status,
      native_messages_receipt: { native_session_id: nativeSessionId, native_conversation_id: routeId, observedAt: messagesAt, window_limit: 200, messages },
      dom_generation_state_receipt: { observedAt, source: "owned-current-dom", raw },
    },
  };
}

export interface BrowserChatRunnerTransportFactories {
  directCdp(config: DirectCdpConfig): ChromePageTools;
  macMini(): ChromePageTools;
  vibe?(config: VibeChromeConfig): ChromePageTools;
  vibeMcp?(config: VibeChromePageToolsOptions): ChromePageTools & { close?(): void | Promise<void> };
}

const DEFAULT_TRANSPORT_FACTORIES: BrowserChatRunnerTransportFactories = {
  directCdp: config => new DirectCdpPageTools(config),
  macMini: () => new MacMiniChromeTransport(),
  vibe: config => new VibeChromeTransport(config),
  vibeMcp: config => new VibeChromePageTools(config),
};

/** Restrict every driver branch to this exact Vibe binding. Known foreign URL
 * markers are excluded without scripting. After SPA navigation, only the
 * window.name equality boolean is read, never account data or chat history. */
export async function filterVibeOwnedPages(
  tools: ChromePageTools, listing: string, harness: "chatgpt" | "zai", accountScope: string, namespace: string,
): Promise<string> {
  const keep: string[] = [];
  for (const line of listing.split("\n")) {
    const page = (harness === "chatgpt" ? parseChatGptPages(line) : parseZaiPages(line))[0];
    if (!page) continue;
    const url = new URL(page.url);
    if (url.searchParams.has(OWNED_TAB_QUERY)) {
      if (!isOwnedTabUrl(page.url, harness, accountScope, namespace)) continue;
    }
    if (url.pathname !== "/" && !/^\/c\/[^/]+$/u.test(url.pathname)) continue;
    try {
      const probe = parseChromeEvaluation<{ owned: boolean }>(await tools.call("evaluate_script", {
        pageId: page.id, function: ownedTabProbeScript(harness, accountScope, namespace),
      }));
      if (typeof probe?.owned !== "boolean") throw new Error("owned_tab_probe_invalid");
      if (probe.owned) keep.push(line);
    } catch (error) {
      if (!isVibePageOwnershipRefusal(error, page.id)) throw error;
    }
  }
  return keep.join("\n");
}


export function makeConfiguredAdapter(
  env: NodeJS.ProcessEnv = process.env,
  factories: BrowserChatRunnerTransportFactories = DEFAULT_TRANSPORT_FACTORIES,
): BrowserAdapterPort {
  const harness = env.AHAP_HARNESS?.trim();
  if (harness !== "chatgpt" && harness !== "zai") throw new Error("AHAP_HARNESS must explicitly select chatgpt or zai");
  const transport = (env.AHAP_BROWSER_TRANSPORT ?? env.AHAP_CHATGPT_TRANSPORT)?.trim() || 'userio';
  if (!["direct-cdp", "mac-mini", "vibe", "vibe-mcp", "userio"].includes(transport ?? "")) {
    throw new Error("AHAP_BROWSER_TRANSPORT must explicitly select direct-cdp, mac-mini, vibe, vibe-mcp or userio");
  }
  if (transport === "vibe-mcp") {
    throw new Error("Vibe is not permitted for ChatGPT or Z.AI owner sessions");
  }
  // The page number is only a first-use hint. The driver owns exactly one
  // tab per provider and finds it by its own marker, so a gateway restart or
  // a closed tab never breaks the route and never opens a tab per call.
  const rawPageId = (env.AHAP_BROWSER_PAGE_ID ?? env.AHAP_CHATGPT_PAGE_ID ?? env.AGENT_HERDER_ZAI_PAGE_ID)?.trim();
  const pageId = rawPageId && /^[1-9][0-9]*$/u.test(rawPageId) ? Number(rawPageId) : undefined;
  const expectedScope = (env.AHAP_BROWSER_ACCOUNT_SCOPE ?? env.AHAP_CHATGPT_ACCOUNT_SCOPE ?? env.AHAP_USERIO_ACCOUNT_SCOPE)?.trim();
  if (!expectedScope || !ACCOUNT_SCOPE.test(expectedScope)) {
    throw new Error("Exact account scope is required");
  }

  if (transport === "userio") {
    if(env.AHAP_USERIO_ACCOUNT_SCOPE && env.AHAP_USERIO_ACCOUNT_SCOPE!==expectedScope) throw new Error('userio_scope_conflict');
    if(env.AHAP_USERIO_ACCESS_TOKEN_FILE && env.AHAP_USERIO_TOKEN_FILE
      && env.AHAP_USERIO_ACCESS_TOKEN_FILE!==env.AHAP_USERIO_TOKEN_FILE) throw new Error('userio_token_file_conflict');
    if (rawPageId || env.AHAP_BROWSER_CDP_WS_URL || env.AHAP_BROWSER_MCP_URL
      || env.AHAP_CHATGPT_CDP_WS_URL || env.AHAP_BROWSER_CDP_CONTEXT_ID) {
      throw new Error("UserIO must not share another browser transport");
    }
    const config = {
      endpoint: env.AHAP_USERIO_ENDPOINT ?? "",
      agentId: env.AHAP_USERIO_AGENT_ID ?? "",
      instanceId: env.AHAP_USERIO_INSTANCE_ID ?? "",
      accountScope: expectedScope,
      tokenFile: env.AHAP_USERIO_ACCESS_TOKEN_FILE ?? env.AHAP_USERIO_TOKEN_FILE ?? "",
      ...(env.AHAP_USERIO_CONNECTION_ID?.trim()?{connectionId:env.AHAP_USERIO_CONNECTION_ID.trim()}:{}),
      ...(env.AHAP_USERIO_PRINCIPAL_ID?.trim()?{principalId:env.AHAP_USERIO_PRINCIPAL_ID.trim()}:{}),
    };
    const driver = harness === "chatgpt" ? new UserIoChatGptDriver(config) : new ZaiUserIoDriver(config);
    const provider = { id: harness, name: harness === "chatgpt" ? "ChatGPT UserIO" : "Z.AI UserIO",
      harness, cwd: process.cwd() } as const;
    const adapter = new BrowserChatAdapter(driver, provider, process.cwd(), true, true);
    return Object.assign(adapter, {
      ...(harness === "chatgpt" ? { addressedReadsVerifyPinnedScope: true as const } : {}),
      getRawTranscript: (id:string) => driver.getRawTranscript(browserChatNativeId(id, harness, true)),
      getAccountScope: () => driver.getAccountScope(),
      verifyPinnedAccountScope: async () => {
        if (driver instanceof ZaiUserIoDriver) await driver.verifyPinnedAccountScope(expectedScope);
        else await driver.verifyPinnedAccountScope();
      },
      close: async () => undefined,
    });
  }

  let selectedTransport: ChromePageTools;
  let ownedPageNamespace: string | undefined;
  if (transport === "mac-mini") {
    selectedTransport = factories.macMini();
  } else if (transport === "vibe") {
    const target = env.AHAP_BROWSER_VIBE_TARGET?.trim();
    const sessionId = env.AHAP_BROWSER_VIBE_SESSION_ID?.trim();
    if (!target || !sessionId) throw new Error("Exact Vibe target and browser session are required");
    const rawPort = env.AHAP_BROWSER_VIBE_RELAY_PORT?.trim();
    if (rawPort && !/^[0-9]+$/u.test(rawPort)) throw new Error("vibe_invalid_relay_port");
    const relayStateDir = env.AHAP_BROWSER_VIBE_STATE_DIR?.trim();
    const runtimeSettings = browserTransportSettingsFromEnv(env);
    const config: VibeChromeConfig = { target, sessionId,
      ...(rawPort ? { relayPort: Number(rawPort) } : {}),
      ...(relayStateDir ? { relayStateDir } : {}),
      ...(Object.values(runtimeSettings).some(Boolean) ? { runtimeSettings } : {}),
    };
    ownedPageNamespace = vibeOwnershipNamespace(config);
    if (!factories.vibe) throw new Error("vibe_transport_factory_unavailable");
    selectedTransport = factories.vibe(config);
  } else {
    const endpoint = (env.AHAP_BROWSER_CDP_WS_URL ?? env.AHAP_CHATGPT_CDP_WS_URL)?.trim();
    const contextId = (env.AHAP_BROWSER_CDP_CONTEXT_ID ?? env.AHAP_CHATGPT_CDP_CONTEXT_ID)?.trim();
    const targetId = (env.AHAP_BROWSER_CDP_TARGET_ID ?? env.AHAP_CHATGPT_CDP_TARGET_ID)?.trim();
    if (!endpoint || !contextId || !targetId) {
      throw new Error("Direct CDP requires endpoint, context and target IDs");
    }
    selectedTransport = factories.directCdp({ endpoint, contextId, targetId, accountScope: expectedScope });
  }
  // The driver owns exactly one tab per provider and finds it by its own
  // marker, so a gateway restart or a closed tab never breaks the route.
  let canaryView: { control: string; pageId: number; creation: string; receipt?: BrowserCanaryViewReceipt;
    status?: "idle" | "running"; closeAttempted?: boolean; closed?: boolean } | undefined;
  const pageTools: ChromePageTools = {
    ...(ownedPageNamespace ? { ownedTabNamespace: ownedPageNamespace, ownedTabAccountScope: expectedScope } : {}),
    async call(name, args = {}) {
      if (ownedPageNamespace && name === "new_page") return (await openOwnedVibePage(args)).receipt;
      const result = await selectedTransport.call(name, args);
      if (name !== "list_pages") return result;
      const origin = harness === "chatgpt" ? "chatgpt\\.com" : "chat\\.z\\.ai";
      const exactPagePattern = new RegExp(`^\\s*${pageId}\\s*:.*?\\(https://${origin}(?:/[^)]*)?\\)`);
      const originPattern = new RegExp(`\(https://${origin}(?:/[^)]*)?\)`);
      let candidates = result.split("\n").filter(line => originPattern.test(line));
      if (canaryView && !canaryView.closed) {
        candidates = candidates.filter(line => new RegExp(`^\\s*${canaryView!.pageId}\\s*:`).test(line));
        if (!candidates.length) throw new Error("browser_canary_prepared_page_unavailable");
      }
      if (!candidates.length) return "";
      if (ownedPageNamespace) return filterVibeOwnedPages(selectedTransport, candidates.join("\n"), harness, expectedScope, ownedPageNamespace);
      // The driver owns exactly one tab per provider and finds it by its own
      // marker. Hiding the other tabs of the same site here would make that
      // ownership unverifiable, so the marked tab comes first and the rest
      // stay visible for the driver to probe read-only.
      const marked = candidates.filter(line => isOwnedTabUrl(line.match(originPattern)![0]!.slice(1, -1), harness));
      const rest = candidates.filter(line => !marked.includes(line));
      return [...marked, ...rest].join("\n");
    },
  };
  const openOwnedVibePage = async (args: Record<string, unknown>, onCreated?: (pageId: number, receipt: string) => void) => {
    if (!ownedPageNamespace || typeof args.url !== "string"
      || !isOwnedTabUrl(args.url, harness, expectedScope, ownedPageNamespace)) throw new Error("browser_canary_owned_creation_required");
    const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
    if (new URL(args.url).origin !== origin) throw new Error("browser_canary_owned_creation_required");
    const receipt = await selectedTransport.call("new_page", args);
    const pageId = vibeCreatedPageId(receipt);
    onCreated?.(pageId, receipt);
    const actual = parseChromeEvaluation<{ origin: string }>(await selectedTransport.call("evaluate_script", {
      pageId, function: "() => ({origin:location.origin})",
    }));
    if (actual?.origin !== origin) throw new Error("browser_canary_owned_creation_origin_mismatch");
    // Claim the native returned ID before re-listing. A site's SPA can remove
    // the URL query during load, before list_pages can see our marker.
    await claimOwnedTab(pageTools, harness, pageId, expectedScope);
    return { pageId, receipt };
  };
  const driver = harness === "chatgpt"
    ? new ChatGptMacCdpDriver(pageTools, undefined, 0, expectedScope, { autoRespondToPrompts: false })
    : new ZaiCdpDriver(pageTools, undefined, 0);
  const provider = { id: harness, name: harness === "chatgpt" ? "ChatGPT browser" : "Z.ai browser", harness, cwd: process.cwd() } as const;
  const adapter = new BrowserChatAdapter(driver, provider, process.cwd(), true, true);
  let verifiedAccountScope: string | undefined;
  const verifyPinnedAccountScope = async () => {
    verifiedAccountScope = undefined;
    if (harness === "chatgpt") await (driver as ChatGptMacCdpDriver).verifyPinnedAccountScope();
    else {
      await (driver as ZaiCdpDriver).verifyPinnedAccountScope(expectedScope);
      verifiedAccountScope = driver.getAccountScope();
    }
  };
  const sendMessage = adapter.sendMessage.bind(adapter);
  return Object.assign(adapter, {
    sendMessage: (...args: Parameters<BrowserChatAdapter["sendMessage"]>) => {
      // A previous idle read cannot authorize closing a view after a new send,
      // including a dispatch whose outcome is unknown.
      if (canaryView) canaryView.status = undefined;
      return sendMessage(...args);
    },
    getAccountScope: () => driver.getAccountScope?.() ?? verifiedAccountScope,
    getOwnedPageNamespace: () => ownedPageNamespace,
    verifyPinnedAccountScope,
    prepareCanaryObservation: async (nativeSessionId: string): Promise<BrowserCanaryViewReceipt> => {
      if (!ownedPageNamespace) throw new Error("browser_canary_vibe_view_required");
      browserChatNativeId(nativeSessionId, harness, true); // Reject foreign handles before effects.
      if (canaryView) {
        if (canaryView.control === nativeSessionId && canaryView.receipt && !canaryView.closed) return canaryView.receipt;
        throw new Error("browser_canary_view_already_prepared");
      }
      const origin = harness === "chatgpt" ? "https://chatgpt.com" : "https://chat.z.ai";
      const created = await openOwnedVibePage({ url: ownedTabUrl(origin, harness, expectedScope, ownedPageNamespace), background: true },
        (pageId, creation) => { canaryView = { control: nativeSessionId, pageId, creation }; });
      if (await verifyNewChatAccountScope(pageTools, harness, created.pageId) !== expectedScope) throw new Error("browser_canary_account_mismatch");
      const session = await adapter.getSession(nativeSessionId);
      if (!session || session.id !== nativeSessionId || session.harness !== harness || session.meta?.pendingRemoteCreation !== false
        || typeof session.meta.sourceRoute !== "string") throw new Error("browser_canary_native_binding_unverified");
      let route: URL;
      try { route = new URL(session.meta.sourceRoute); } catch { throw new Error("browser_canary_native_binding_unverified"); }
      if (route.origin !== origin || !route.pathname.startsWith("/c/") || route.pathname.length <= 3 || route.pathname.slice(3).includes("/")
        || route.username || route.password || route.search || route.hash) throw new Error("browser_canary_native_binding_unverified");
      const navigation = await selectedTransport.call("navigate_page", { pageId: created.pageId, type: "url", url: route.href });
      await claimOwnedTab(pageTools, harness, created.pageId, expectedScope);
      if (await verifyNewChatAccountScope(pageTools, harness, created.pageId) !== expectedScope) throw new Error("browser_canary_account_mismatch");
      const receipt: BrowserCanaryViewReceipt = { native_session_id: nativeSessionId, native_conversation_id: route.pathname.slice(3),
        owned_page_id: created.pageId, owned_page_namespace: ownedPageNamespace, source_route: route.href,
        creation_receipt: created.receipt, navigation_receipt: vibeTextBody(navigation), observedAt: new Date().toISOString() };
      canaryView = { control: nativeSessionId, pageId: created.pageId, creation: created.receipt, receipt };
      return receipt;
    },
    getCanaryViewReceipt: () => canaryView ? { ...canaryView } : undefined,
    closeCanaryObservation: async () => {
      if (!canaryView) return { closed: true };
      const view = canaryView;
      if (view.closed) return { page_id: view.pageId, closed: true };
      if (view.receipt && view.status !== "idle") throw new Error("browser_canary_view_not_terminal");
      if (!view.closeAttempted) {
        view.closeAttempted = true;
        try { await selectedTransport.call("close_page", { pageId: view.pageId }); } catch { /* Reconcile without another close dispatch. */ }
      }
      const pages = await selectedTransport.call("list_pages");
      if (pages.split("\n").some(line => new RegExp(`^\\s*${view.pageId}\\s*:`).test(line))) throw new Error("browser_canary_view_close_unconfirmed");
      view.closed = true;
      return { page_id: view.pageId, closed: true };
    },
    readCanaryObservation: async (nativeSessionId: string) => {
      const observed = await readBrowserCanaryObservation({
        harness, nativeSessionId, accountScope: expectedScope, tools: pageTools, adapter,
        verifyAccount: pageId => verifyNewChatAccountScope(pageTools, harness, pageId),
      });
      if (canaryView?.control === nativeSessionId && canaryView.receipt) {
        observed.proof.owned_view_receipt = canaryView.receipt;
        canaryView.status = observed.session.status === "idle" ? "idle" : "running";
      }
      return observed;
    },
    close: async () => {
      if (driver instanceof ChatGptMacCdpDriver) driver.stopPromptPolling();
      if ("close" in selectedTransport && typeof selectedTransport.close === "function") await selectedTransport.close();
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
