import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ChromePageTools } from "./mac-mini-chrome-transport.js";
import { evaluateVibeAsync } from "./vibe-async-evaluation.js";

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
