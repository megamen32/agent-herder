import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ChromePageTools } from "./mac-mini-chrome-transport.js";
import { evaluateVibeAsync } from "./vibe-async-evaluation.js";
import { browserTransportSettingsFromEnv, resolveVibeSettings, type BrowserTransportSettings, type VibeTargetAlias } from "./browser-runtime-settings.js";


export type VibeChromeMcpClient = {
  connect(transport: unknown): Promise<void>;
  callTool(input: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
};
export type VibeChromePageToolsOptions = {
  url: string;
  tokenProvider: () => Promise<string>;
  /** AHAP drivers must never see/adopt tabs created outside this MCP client. */
  ownedPagesOnly?: boolean;
  clientFactory?: () => VibeChromeMcpClient;
  transportFactory?: (url: URL, tokenProvider: () => Promise<string>) => unknown;
};
const MAX_BYTES = 3 * 1024 * 1024;
const STATE_SEPARATOR = "\n\n---\n# Current browser state:";
const SUPPORTED = new Set(["list_pages", "new_page", "evaluate_script", "take_snapshot", "fill", "navigate_page", "close_page"]);
function failure(code: string): Error { return new Error("vibe_chrome_" + code); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_response");
  return value as Record<string, unknown>;
}
function bounded(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw failure("invalid_payload"); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_BYTES) throw failure("payload_exceeds_bound");
}
function pageId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw failure("invalid_page_id");
  return value;
}
function pageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) throw failure("invalid_page_url");
  let url: URL;
  try { url = new URL(value); } catch { throw failure("invalid_page_url"); }
  if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank" || url.username || url.password) throw failure("invalid_page_url");
  return url.href;
}
function timeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 120_000) throw failure("invalid_timeout");
  return value;
}
function onlyKeys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some(key => !allowed.includes(key))) throw failure("unsupported_argument");
}
function responseText(value: unknown): string {
  bounded(value);
  const outer = record(value);
  if (outer.isError === true) throw failure("tool_refused_or_failed");
  if (!Array.isArray(outer.content) || outer.content.some(item => !item || typeof item !== "object")) throw failure("invalid_response");
  const parts = outer.content.filter(item => item.type === "text").map(item => item.text);
  if (!parts.length || parts.some(item => typeof item !== "string")) throw failure("missing_text_response");
  const text = parts.join("\n");
  if (/^\s*(?:Error:|Tool execution failed)/u.test(text)) throw failure("tool_refused_or_failed");
  return text;
}
function primaryText(text: string): string {
  const at = text.indexOf(STATE_SEPARATOR);
  return at < 0 ? text : text.slice(0, at);
}
/** Scan the first JSON object. Braces and Markdown fences inside JSON strings
 * cannot consume or inject the appended browser-state report. */
function firstObject(text: string): Record<string, unknown> {
  const source = text.trimStart();
  if (!source.startsWith("{")) throw failure("invalid_evaluation_envelope");
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      let parsed: unknown;
      try { parsed = JSON.parse(source.slice(0, index + 1)); } catch { throw failure("invalid_evaluation_envelope"); }
      const trailing = source.slice(index + 1);
      if (trailing.trim() && !trailing.startsWith(STATE_SEPARATOR)) throw failure("invalid_evaluation_suffix");
      return record(parsed);
    }
  }
  throw failure("incomplete_evaluation_envelope");
}
function evaluation(text: string): string {
  const envelope = firstObject(text);
  if (envelope.success !== true || !Object.prototype.hasOwnProperty.call(envelope, "result")) throw failure("evaluation_failed");
  const fence = String.fromCharCode(96).repeat(3);
  return fence + "json\n" + JSON.stringify(envelope.result) + "\n" + fence;
}
function pageListing(text: string): string {
  const rows: Array<{ id: number; active: boolean; url?: string }> = [];
  let current: { id: number; active: boolean; url?: string } | undefined;
  const source = primaryText(text);
  const count = source.match(/^\s*Found (\d+) page\(s\):\s*(?:\r?\n|$)/u);
  const expectedCount = count ? Number(count[1]) : undefined;
  if (expectedCount !== undefined && !Number.isSafeInteger(expectedCount)) throw failure("invalid_page_listing");
  const inventoryUrl = (value: string): string => {
    // Inventory may include browser-internal pages; they are never adopted.
    try {
      const parsed = new URL(value);
      if (/[\u0000-\u0020\u007f]/u.test(value) || parsed.username || parsed.password) throw failure("invalid_page_listing");
      return parsed.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
    } catch { throw failure("invalid_page_listing"); }
  };
  for (const line of source.split(/\r?\n/u)) {
    // Standalone list_pages differs from the appended browser-state report.
    const page = line.match(/^\s*Page\s+(\d+)(?:\s+(\[ACTIVE\]))?\s*:\s*"(.*)"\s+-\s+(\S+)\s*$/u);
    if (page) {
      current = { id: pageId(Number(page[1])), active: !!page[2], url: inventoryUrl(page[4]!) };
      if (rows.some(row => row.id === current!.id)) throw failure("duplicate_page_id");
      rows.push(current); continue;
    }
    if (/^\s*Page\s+/u.test(line)) throw failure("invalid_page_listing");
    const header = line.match(/^\s*(?:\d+\.\s*)?Tab\s+(\d+)(?:\s+(\[ACTIVE\]))?\s*:\s*(.*)$/u);
    if (header) {
      current = { id: pageId(Number(header[1])), active: !!header[2] || /\s\[ACTIVE\]\s*$/u.test(header[3]!) };
      if (rows.some(row => row.id === current!.id)) throw failure("duplicate_page_id");
      rows.push(current); continue;
    }
    const url = line.match(/^\s*URL:\s*(\S.*?)\s*$/u);
    if (url) {
      if (!current || current.url) throw failure("invalid_page_listing");
      current.url = inventoryUrl(url[1]!);
    }
  }
  if (expectedCount !== undefined && rows.length !== expectedCount) throw failure("incomplete_page_listing");
  if (!rows.length) {
    if (expectedCount === 0 || /^\s*No (?:open )?(?:tabs|pages)(?: (?:are )?(?:currently )?open)?[.!]?\s*$/iu.test(source)) return "";
    throw failure("invalid_page_listing");
  }
  if (rows.some(row => !row.url)) throw failure("incomplete_page_listing");
  // Titles are not needed by ChromePageTools consumers and could contain text
  // resembling the legacy page-list syntax. Preserve only authoritative IDs/URLs.
  return rows.map(row => row.id + ": Page (" + row.url + ")" + (row.active ? " [selected]" : "")).join("\n");
}

function snapshot(text: string): string {
  return primaryText(text).split(/\r?\n/u).map(line => {
    const row = line.match(/^(\s*)(?:-\s+)?(.+?)\s+uid=([\w-]+)(.*)$/u);
    return row ? row[1] + "uid=" + row[3] + " " + row[2] + row[4] : line;
  }).join("\n");
}

/** Vibe's tool ownership is scoped to this persistent MCP session. Only IDs
 * returned by this client's successful new_page are eligible for page actions.
 * The caller must additionally fence URL/account changes before every action. */
export class VibeChromePageTools implements ChromePageTools {
  private readonly url: URL;
  private readonly owned = new Set<number>();
  private client?: VibeChromeMcpClient;
  private connecting?: Promise<VibeChromeMcpClient>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly options: VibeChromePageToolsOptions) {
    try { this.url = new URL(options.url); } catch { throw failure("invalid_mcp_url"); }
    if (this.url.protocol !== "https:" || this.url.username || this.url.password || this.url.search || this.url.hash) throw failure("invalid_mcp_url");
    if (typeof options.tokenProvider !== "function") throw failure("missing_token_provider");
  }
  private connected(): Promise<VibeChromeMcpClient> {
    if (this.closed) return Promise.reject(failure("closed"));
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.options.clientFactory?.()
          ?? new Client({ name: "agent-herder-vibe-browser", version: "1" }) as unknown as VibeChromeMcpClient;
        let discarded = false;
        try {
          const transport = this.options.transportFactory
            ? this.options.transportFactory(this.url, this.options.tokenProvider)
            : new StreamableHTTPClientTransport(this.url, { authProvider: { token: this.options.tokenProvider } });
          await client.connect(transport);
          if (this.closed) { discarded = true; await client.close(); throw failure("closed"); }
          this.client = client;
          return client;
        } catch {
          if (!discarded) await client.close().catch(() => undefined);
          throw this.closed ? failure("closed") : failure("connection_failed");
        }
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (this.closed) throw failure("closed");
    if (!SUPPORTED.has(name)) throw failure("unsupported_tool");
    record(args); bounded(args);
    let mapped: Record<string, unknown>;
    let operationTimeout = 30_000;
    let target: number | undefined;
    if (name === "list_pages") {
      onlyKeys(args, []); mapped = {};
    } else if (name === "new_page") {
      onlyKeys(args, ["url", "background", "focus", "timeout", "timeoutMs"]);
      if (args.focus !== undefined && args.focus !== false || args.background !== undefined && args.background !== true) throw failure("background_page_required");
      mapped = { url: pageUrl(args.url), focus: false };
      operationTimeout = timeout(args.timeoutMs ?? args.timeout) ?? 30_000;
    } else {
      target = pageId(args.pageId);
      if (!this.owned.has(target)) throw failure("page_not_owned_by_this_session");
      if (name === "evaluate_script") {
        onlyKeys(args, ["pageId", "function", "args"]);
        if (typeof args.function !== "string" || !args.function.trim() || args.args !== undefined && !Array.isArray(args.args)) throw failure("invalid_evaluation_arguments");
        mapped = { tabId: target, function: args.function, ...(args.args !== undefined ? { args: args.args } : {}) };
      } else if (name === "fill") {
        onlyKeys(args, ["pageId", "uid", "value"]);
        if (typeof args.uid !== "string" || !/^[\w-]{1,128}$/u.test(args.uid) || typeof args.value !== "string") throw failure("invalid_fill_arguments");
        mapped = { tabId: target, uid: args.uid, value: args.value };
      } else if (name === "take_snapshot") {
        onlyKeys(args, ["pageId", "scopeSelector"]);
        if (args.scopeSelector !== undefined && (typeof args.scopeSelector !== "string" || !args.scopeSelector.trim())) throw failure("invalid_snapshot_arguments");
        mapped = { pageId: target, format: "accessibility_tree", compact: true,
          ...(args.scopeSelector !== undefined ? { scopeSelector: args.scopeSelector } : {}) };
      } else if (name === "navigate_page") {
        onlyKeys(args, ["pageId", "type", "url", "timeout", "timeoutMs"]);
        if (!["url", "reload", "back", "forward"].includes(String(args.type))) throw failure("invalid_navigation_type");
        if (args.type !== "url" && args.url !== undefined) throw failure("unexpected_navigation_url");
        const wait = timeout(args.timeoutMs ?? args.timeout);
        mapped = { pageId: target, type: args.type, ...(args.type === "url" ? { url: pageUrl(args.url) } : {}),
          ...(wait !== undefined ? { timeoutMs: wait } : {}) };
        operationTimeout = wait ?? 30_000;
      } else {
        onlyKeys(args, ["pageId"]); mapped = { pageId: target };
      }
    }
    const client = await this.connected();
    if (this.closed) throw failure("closed");
    if (name === "evaluate_script") {
      return evaluateVibeAsync({
        functionDeclaration: args.function as string,
        ...(args.args !== undefined ? { args: args.args as unknown[] } : {}),
        timeoutMs: operationTimeout,
        evaluateOnce: async (declaration, values) => {
          if (this.closed || !this.owned.has(target!)) throw failure("page_not_owned_by_this_session");
          const argumentsForCall = { tabId: target, function: declaration,
            ...(values !== undefined ? { args: values } : {}) };
          bounded(argumentsForCall);
          let response: unknown;
          try { response = await client.callTool({ name: "evaluate_script", arguments: argumentsForCall }, { timeout: operationTimeout }); }
          catch { throw failure("operation_outcome_unavailable_do_not_replay"); }
          return evaluation(responseText(response));
        },
      });
    }
    // Never retry a transport error: a mutating operation may already have run.
    let response: unknown;
    try { response = await client.callTool({ name, arguments: mapped }, { timeout: operationTimeout }); }
    catch { throw failure("operation_outcome_unavailable_do_not_replay"); }
    const text = responseText(response);
    if (name === "list_pages") {
      const listing = pageListing(text);
      if (!this.options.ownedPagesOnly) return listing;
      return listing.split("\n").filter(line => {
        const id = line.match(/^(\d+):/u);
        return !!id && this.owned.has(Number(id[1]));
      }).join("\n");
    }
    if (name === "take_snapshot") return snapshot(text);
    if (name === "new_page") {
      const created = primaryText(text).match(/^Successfully created new background page \(ID: (\d+)\)(?:[.,!]|\s|$)/u);
      if (!created) throw failure("new_page_receipt_unavailable_do_not_adopt");
      const id = pageId(Number(created[1]));
      if (this.owned.has(id)) throw failure("duplicate_new_page_receipt");
      if (this.closed) throw failure("closed");
      this.owned.add(id);
    } else if (name === "close_page") this.owned.delete(target!);
    return primaryText(text);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        const client = this.client ?? await this.connecting?.catch(() => undefined);
        this.client = undefined;
        this.owned.clear();
        if (client) await client.close();
      })();
    }
    return this.closing;
  }
}

// Legacy/installed-Vibe transport and native receipt helpers from the owner workflow.

/** Opaque public aliases. The actual MCP target and child paths are private
 * owner settings injected at process launch. */
export const MAC_MINI_VIBE_TARGET: VibeTargetAlias = "mac-mini";
export const SERVER100_VIBE_TARGET: VibeTargetAlias = "server-100";

export interface VibeChromeConfig {
  target: string;
  /** Vibe extension session, not an MCP HTTP session or a page ID. */
  sessionId: string;
  relayPort?: number;
  /** Required for a separate relay. Never shares its pid/state with the default relay. */
  relayStateDir?: string;
  timeoutMs?: number;
  runtimeSettings?: BrowserTransportSettings;
}

export interface VibeMcpClient {
  connect(transport: unknown): Promise<void>;
  request(input: { method: string; params: Record<string, unknown> }, schema: unknown, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface VibeToolPort {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}

/** Keeps the native receipt available without putting page text, scripts or secrets in an error message. */
export class VibeTransportError extends Error {
  constructor(readonly code: string, readonly receipt?: unknown) {
    super(code);
    this.name = "VibeTransportError";
  }
}

/** Uses the existing MCP SDK. It never replays tools/call or switches transports. */
export class VibeMcpPort implements VibeToolPort {
  private client?: VibeMcpClient;
  private connecting?: Promise<VibeMcpClient>;
  private closed = false;

  constructor(
    private readonly transportFactory: () => unknown,
    private readonly clientFactory: () => VibeMcpClient = () => new Client({ name: "agent-herder-vibe", version: "1" }) as unknown as VibeMcpClient,
    private readonly timeoutMs = 30_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new VibeTransportError("vibe_invalid_timeout");
  }

  private async connected(): Promise<VibeMcpClient> {
    if (this.closed) throw new VibeTransportError("vibe_mcp_closed");
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.clientFactory();
        try {
          await client.connect(this.transportFactory());
          if (this.closed) throw new VibeTransportError("vibe_mcp_closed");
          this.client = client;
          return client;
        } catch {
          await client.close().catch(() => undefined);
          this.closed = true;
          throw new VibeTransportError("vibe_mcp_connection_failed");
        }
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connected();
    try {
      // The native public owner can return a task receipt instead of a finished
      // CallToolResult. Keep it verbatim; SDK callTool's result schema would reject it.
      return await client.request({ method: "tools/call", params: { name, arguments: args } },
        z.object({}).passthrough(), { timeout: this.timeoutMs });
    } catch (cause) {
      // An exception after dispatch is not proof of no effect. A caller may read
      // the provider state, but must not automatically submit the operation again.
      const native = mainRecord(cause)?.data;
      throw new VibeTransportError("vibe_mcp_outcome_unknown", {
        tool: name, outcome: "unknown", replayed: false,
        ...(native === undefined ? {} : { native }),
      });
    }
  }

  async request(method: "tasks/get" | "tasks/result", params: { taskId: string }): Promise<unknown> {
    if (!params.taskId || !["tasks/get", "tasks/result"].includes(method)) throw new VibeTransportError("vibe_invalid_task_read");
    const client = await this.connected();
    return client.request({ method, params }, z.object({}).passthrough(), { timeout: this.timeoutMs });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.connecting) await this.connecting.catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }
}

/** Fixed installed child paths and SSH identity, with an explicit extension-session pin. */
function validateVibeShape(config: VibeChromeConfig): { port: number; state?: string } {
  if (![MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET].includes(config.target as VibeTargetAlias)) throw new VibeTransportError("vibe_target_not_configured");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(config.sessionId)) throw new VibeTransportError("vibe_browser_session_required");
  const port = config.relayPort ?? 19888;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new VibeTransportError("vibe_invalid_relay_port");
  const state = config.relayStateDir;
  if (port !== 19888 && !state) throw new VibeTransportError("vibe_custom_relay_requires_isolated_state");
  if (state && (!/^\/[a-zA-Z0-9_./-]+$/u.test(state) || state.split("/").includes(".."))) throw new VibeTransportError("vibe_invalid_relay_state");
  return { port, ...(state ? { state } : {}) };
}

export function vibeStdioParameters(config: VibeChromeConfig): StdioServerParameters {
  const { port, state } = validateVibeShape(config);
  const env = {
    ...getDefaultEnvironment(),
    VIBE_REMOTE_URL: "", VIBE_EXTENSION_UUID: "", VIBE_RELAY_UUID: "",
    VIBE_MCP_AGENT_PORT: String(port), VIBE_MCP_EXTENSION_PORT: String(port + 1),
    ...(state ? { VIBE_MCP_STATE_DIR: state, VIBE_MCP_PID_FILE: `${state}/vibebrowser-relay.pid` } : {}),
  };
  const flags = ["start", "--transport", "stdio", "--session", config.sessionId, "--port", String(port)];
  let runtime: ReturnType<typeof resolveVibeSettings>;
  try { runtime = resolveVibeSettings(config.target, config.runtimeSettings ?? browserTransportSettingsFromEnv()); }
  catch (error) { throw new VibeTransportError(error instanceof Error ? error.message : "vibe_runtime_settings_invalid"); }
  if (config.target === SERVER100_VIBE_TARGET) {
    return {
      command: process.execPath,
      args: [runtime.cliPath, ...flags],
      env,
      stderr: "pipe",
    };
  }
  // SSH joins its remote argv into a command. Every nonconstant value above is
  // restricted to shell-safe session IDs, decimal ports and absolute paths.
  const remoteEnv = [
    "VIBE_REMOTE_URL=", "VIBE_EXTENSION_UUID=", "VIBE_RELAY_UUID=",
    `VIBE_MCP_AGENT_PORT=${port}`, `VIBE_MCP_EXTENSION_PORT=${port + 1}`,
    ...(state ? [`VIBE_MCP_STATE_DIR=${state}`, `VIBE_MCP_PID_FILE=${state}/vibebrowser-relay.pid`] : []),
  ];
  return {
    command: "/usr/bin/ssh",
    args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5",
      runtime.sshTarget!, "/usr/bin/env", ...remoteEnv, runtime.nodePath!,
      runtime.cliPath, ...flags],
    env,
    stderr: "pipe",
  };
}

/** Stable ownership identity of the explicit installed browser binding. The
 * default relay keeps its native default state/pid layout. An explicit state
 * path has a different pid layout even when it names the default data folder. */
export function vibeOwnershipNamespace(config: VibeChromeConfig): string {
  validateVibeShape(config);
  const binding = ["vibe-ownership-v1", config.target, config.sessionId,
    config.relayPort ?? 19888, config.relayStateDir ? posix.normalize(config.relayStateDir).replace(/\/$/u, "") : "default"];
  return "vibe-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

/** The only native refusal that can prove an unmarked candidate belongs to a
 * different Vibe session. Match the observed full literal and the exact page. */
export function isVibePageOwnershipRefusal(cause: unknown, pageId: number): boolean {
  if (!(cause instanceof VibeTransportError) || cause.code !== "vibe_tool_refused" || !Number.isSafeInteger(pageId) || pageId <= 0) return false;
  const response = mainRecord(cause.receipt);
  if (!Array.isArray(response?.content)) return false;
  const parts = response.content.map(mainRecord);
  if (!parts.length || parts.some(part => part?.type !== "text" || typeof part.text !== "string")) return false;
  return withoutPageState(parts.map(part => part!.text as string).join("\n")) ===
    `Error: tabId ${pageId} is not authorized for this session \u2014 only the tab this session started on, or tabs it opened itself, can be scripted`;
}

function mainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function vibeResultText(response: unknown): string {
  const result = mainRecord(response);
  if (!result) throw new VibeTransportError("vibe_invalid_response", response);
  if (result.isError === true) throw new VibeTransportError("vibe_tool_refused", response);
  const structured = mainRecord(result.structuredContent);
  for (const envelope of [result, structured]) {
    if (!envelope) continue;
    if (envelope.task || envelope.taskId || envelope.job_id || ["accepted", "pending", "running", "working", "unknown"].includes(String(envelope.status))) {
      throw new VibeTransportError("vibe_operation_pending", response);
    }
  }
  if (!Array.isArray(result.content)) throw new VibeTransportError("vibe_invalid_response", response);
  const text = result.content.map(part => {
    const item = mainRecord(part);
    if (item?.type !== "text" || typeof item.text !== "string") throw new VibeTransportError("vibe_expected_text_response", response);
    return item.text;
  }).join("\n");
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new VibeTransportError("vibe_response_too_large");
  if (/^Error:/u.test(text)) throw new VibeTransportError("vibe_tool_refused", response);
  return text;
}

function withoutPageState(text: string): string {
  return text.split("\n\n---\n# Current browser state:", 1)[0]!.trim();
}

export const vibeTextBody = withoutPageState;

/** The ChromePageTools representation is generated only from a native new_page receipt. */
export function vibeCreatedPageId(text: string): number {
  const match = /^Vibe page opened: ([1-9][0-9]*)$/u.exec(text);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(id)) throw new VibeTransportError("vibe_created_page_receipt_invalid");
  return id;
}

export function parseVibeEvaluation<T = unknown>(response: unknown): T {
  let value: Record<string, unknown> | undefined;
  try { value = mainRecord(JSON.parse(withoutPageState(vibeResultText(response)))); }
  catch (error) {
    if (error instanceof VibeTransportError) throw error;
    throw new VibeTransportError("vibe_evaluation_invalid", response);
  }
  if (value?.success !== true || !Object.hasOwn(value, "result")) throw new VibeTransportError("vibe_evaluation_invalid", response);
  return value.result as T;
}

export function parseVibeOpenedPage(response: unknown): number {
  const text = withoutPageState(vibeResultText(response));
  const match = /^Successfully created new (?:background )?page \(ID: ([1-9][0-9]*)\)(?:,|$)/u.exec(text);
  const pageId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(pageId)) throw new VibeTransportError("vibe_new_page_receipt_invalid", response);
  return pageId;
}

export function normalizeVibePages(text: string): string {
  const body = withoutPageState(text);
  const count = /^Found ([0-9]+) page\(s\):$/mu.exec(body);
  if (!count) throw new VibeTransportError("vibe_page_list_invalid");
  const rows: string[] = [];
  const ids = new Set<number>();
  for (const line of body.split("\n")) {
    if (!line.startsWith("Page ")) continue;
    const match = /^Page ([1-9][0-9]*)( \[ACTIVE\])?: "(.*)" - (\S+)$/u.exec(line);
    const id = match ? Number(match[1]) : NaN;
    if (!match || !Number.isSafeInteger(id) || ids.has(id)) throw new VibeTransportError("vibe_page_list_invalid");
    ids.add(id);
    const title = match[3]!.replace(/[()]/gu, " ");
    rows.push(`${id}: ${title} (${match[4]})${match[2] ? " [selected]" : ""}`);
  }
  if (rows.length !== Number(count[1])) throw new VibeTransportError("vibe_page_list_incomplete");
  return rows.join("\n");
}

export function normalizeVibeSnapshot(response: unknown): string {
  const text = withoutPageState(vibeResultText(response));
  // Vibe places A-refs after the semantic role/name; the existing driver reads
  // the DevTools ordering. Preserve the exact ref and label, never invent one.
  return text.replace(/^(\s*)- ([a-zA-Z][\w-]*) ("(?:[^"\\]|\\.)*") uid=(A[0-9]+)(.*)$/gmu,
    "$1uid=$4 $2 $3$5");
}

function mainPageId(args: Record<string, unknown>): number {
  const value = args.pageId;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new VibeTransportError("vibe_exact_page_required");
  if (args.tabId !== undefined && args.tabId !== value) throw new VibeTransportError("vibe_conflicting_page_binding");
  return value as number;
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new VibeTransportError("vibe_invalid_arguments");
  return value;
}

const EVALUATIONS_KEY = "__agentHerderVibeEvaluationsV1";
const MAX_EVALUATION_JSON_BYTES = 2 * 1024 * 1024;
const OPERATION_ID = /^[a-f0-9-]{36}$/u;

type EvaluationState = { operationId: string; state: string; json?: string };
export type VibeOperationReceipt = {
  operationId: string; target: string; sessionId: string; pageId: number;
  state: string; dispatches: number;
};

/** Safe metadata for AHAP errors. Native content, function text and values stay private. */
export function vibeOperationReceipt(error: unknown): VibeOperationReceipt | undefined {
  if (!(error instanceof VibeTransportError)) return undefined;
  const value = mainRecord(error.receipt);
  if (!value || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)
    || ![MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET].includes(String(value.target) as VibeTargetAlias)
    || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value.sessionId)
    || !Number.isSafeInteger(value.pageId) || Number(value.pageId) < 1
    || !["pending", "missing", "complete", "failed", "undefined", "not_json", "too_large", "capacity", "conflict"].includes(String(value.state))) return undefined;
  return { operationId: value.operationId, target: String(value.target), sessionId: value.sessionId,
    pageId: Number(value.pageId), state: String(value.state), dispatches: value.dispatches === 0 ? 0 : 1 };
}

/** Reconciliation reads use the same operation ID and exact tab/session binding. */
export function vibeEvaluationReadScript(operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw new VibeTransportError("vibe_invalid_operation_id");
  return `() => { const entry = globalThis[${JSON.stringify(EVALUATIONS_KEY)}]?.[${JSON.stringify(operationId)}];
    return entry ? {...entry} : {operationId:${JSON.stringify(operationId)},state:'missing'}; }`;
}

function evaluationStartScript(operationId: string, fn: string): string {
  return `(...args) => {
    const key=${JSON.stringify(EVALUATIONS_KEY)},id=${JSON.stringify(operationId)};
    let entries=globalThis[key];
    if(entries && (typeof entries!=='object'||Array.isArray(entries)))return {operationId:id,state:'conflict'};
    if(!entries)globalThis[key]=entries=Object.create(null);
    if(Object.keys(entries).length>=16)return {operationId:id,state:'capacity'};
    if(entries[id])return {...entries[id]};
    const entry=entries[id]={operationId:id,state:'pending'};
    const settle=value=>{
      if(value===undefined){entry.state='undefined';return;}
      try{
        const json=JSON.stringify(value);
        if(typeof json!=='string'){entry.state='not_json';return;}
        if(new TextEncoder().encode(json).length>${MAX_EVALUATION_JSON_BYTES}){entry.state='too_large';return;}
        entry.json=json;entry.state='complete';
      }catch{entry.state='not_json';}
    };
    try{
      const value=(${fn})(...args);
      if(value && typeof value.then==='function')Promise.resolve(value).then(settle,()=>{entry.state='failed';});
      else settle(value);
    }catch{entry.state='failed';}
    return {...entry};
  }`;
}

function evaluationCleanupScript(operationId: string): string {
  return `() => { const entries=globalThis[${JSON.stringify(EVALUATIONS_KEY)}],id=${JSON.stringify(operationId)};
    if(entries?.[id]?.operationId===id && entries[id].state==='complete'){delete entries[id];return {cleaned:true};}
    return {cleaned:false}; }`;
}

export class VibeChromeTransport implements ChromePageTools {
  private readonly port: VibeToolPort;
  constructor(private readonly config: VibeChromeConfig, port?: VibeToolPort) {
    // Validate even injected bindings so tests and production have the same rules.
    const parameters = vibeStdioParameters(config);
    this.port = port ?? new VibeMcpPort(() => new StdioClientTransport(parameters), undefined, config.timeoutMs);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    let mapped: Record<string, unknown>;
    switch (name) {
      case "list_pages": mapped = {}; break;
      case "new_page": {
        if (args.background !== undefined && typeof args.background !== "boolean") throw new VibeTransportError("vibe_invalid_arguments");
        mapped = { url: boundedString(args.url, 64 * 1024), focus: args.background === false, waitForReady: true };
        break;
      }
      case "evaluate_script": {
        return this.evaluate(args);
      }
      case "navigate_page": {
        if (!["url", "back", "forward", "reload"].includes(String(args.type))) throw new VibeTransportError("vibe_invalid_arguments");
        mapped = { pageId: mainPageId(args), type: args.type };
        if (args.type === "url") mapped.url = boundedString(args.url, 64 * 1024);
        const timeout = args.timeoutMs ?? args.timeout;
        if (timeout !== undefined) {
          if (!Number.isSafeInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120_000) throw new VibeTransportError("vibe_invalid_arguments");
          mapped.timeoutMs = timeout;
        }
        break;
      }
      case "take_snapshot": mapped = { pageId: mainPageId(args), format: "accessibility_tree" }; break;
      case "fill": {
        const uid = boundedString(args.uid, 40);
        if (!/^A[0-9]+$/u.test(uid)) throw new VibeTransportError("vibe_invalid_accessibility_ref");
        mapped = { tabId: mainPageId(args), uid, value: boundedString(args.value, 512 * 1024) };
        break;
      }
      case "close_page": mapped = { pageId: mainPageId(args) }; break;
      default: throw new VibeTransportError("vibe_unsupported_tool");
    }
    const result = await this.port.callTool(name, mapped);
    if (name === "list_pages") return normalizeVibePages(vibeResultText(result));
    if (name === "take_snapshot") return normalizeVibeSnapshot(result);
    if (name === "new_page") return `Vibe page opened: ${parseVibeOpenedPage(result)}`;
    return vibeResultText(result);
  }

  async close(): Promise<void> { await this.port.close?.(); }

  private async evaluate(args: Record<string, unknown>): Promise<string> {
    const tab = mainPageId(args), fn = boundedString(args.function, 512 * 1024);
    if (args.args !== undefined && (!Array.isArray(args.args) || !args.args.every(item => typeof item === "string"))) throw new VibeTransportError("vibe_invalid_arguments");
    const operationId = randomUUID();
    const receipt: VibeOperationReceipt = { operationId, target: this.config.target, sessionId: this.config.sessionId,
      pageId: tab, state: "pending", dispatches: 1 };
    const deadline = Date.now() + (this.config.timeoutMs ?? 30_000);
    let current: EvaluationState | undefined;
    let nativeReceipt: unknown;
    const parse = (response: unknown): EvaluationState => {
      const value = parseVibeEvaluation<EvaluationState>(response);
      if (!value || value.operationId !== operationId || typeof value.state !== "string") throw new VibeTransportError("vibe_evaluation_invalid", response);
      return value;
    };
    const pending = () => new VibeTransportError("vibe_evaluation_pending", {
      ...receipt, ...(nativeReceipt === undefined ? {} : { native: nativeReceipt }),
    });
    try {
      current = parse(await this.port.callTool("evaluate_script", { tabId: tab,
        function: evaluationStartScript(operationId, fn), ...(args.args === undefined ? {} : { args: args.args }) }));
    } catch (error) {
      if (error instanceof VibeTransportError && error.code === "vibe_tool_refused") throw error;
      nativeReceipt = error instanceof VibeTransportError ? error.receipt : undefined;
      // Dispatch may have reached the browser. Only read the same operation now.
    }
    for (;;) {
      if (current) {
        receipt.state = current.state;
        if (current.state === "complete") {
          if (typeof current.json !== "string" || Buffer.byteLength(current.json) > MAX_EVALUATION_JSON_BYTES) throw new VibeTransportError("vibe_evaluation_invalid", receipt);
          let value: unknown;
          try { value = JSON.parse(current.json); }
          catch { throw new VibeTransportError("vibe_evaluation_invalid", receipt); }
          // Cleanup never executes the original action, and only deletes this
          // operation after its completed value has reached this client.
          await this.port.callTool("evaluate_script", { tabId: tab, function: evaluationCleanupScript(operationId) }).catch(() => undefined);
          return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
        }
        if (["failed", "undefined", "not_json", "too_large", "capacity", "conflict"].includes(current.state)) {
          if (["capacity", "conflict"].includes(current.state)) receipt.dispatches = 0;
          throw new VibeTransportError(`vibe_evaluation_${current.state}`, receipt);
        }
        if (!["pending", "missing"].includes(current.state)) throw new VibeTransportError("vibe_evaluation_invalid", receipt);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw pending();
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
      try {
        current = parse(await this.port.callTool("evaluate_script", { tabId: tab, function: vibeEvaluationReadScript(operationId) }));
      } catch (error) {
        nativeReceipt = error instanceof VibeTransportError ? error.receipt : undefined;
        throw pending();
      }
    }
  }
}
