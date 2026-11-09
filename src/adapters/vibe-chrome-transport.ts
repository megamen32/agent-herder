import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ChromePageTools } from "./mac-mini-chrome-transport.js";

export const MAC_MINI_VIBE_TARGET = "mcp:shell:mac-mini-2012.lan:VibeMacMiniLocal";
export const SERVER100_VIBE_TARGET = "mcp:shell:roomhacker-server-100:VibeServer100Local";

export interface VibeChromeConfig {
  target: string;
  /** Vibe extension session, not an MCP HTTP session or a page ID. */
  sessionId: string;
  relayPort?: number;
  /** Required for a separate relay. Never shares its pid/state with the default relay. */
  relayStateDir?: string;
  timeoutMs?: number;
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
      const native = record(cause)?.data;
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
export function vibeStdioParameters(config: VibeChromeConfig): StdioServerParameters {
  if (![MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET].includes(config.target)) throw new VibeTransportError("vibe_target_not_configured");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(config.sessionId)) throw new VibeTransportError("vibe_browser_session_required");
  const port = config.relayPort ?? 19888;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65534) throw new VibeTransportError("vibe_invalid_relay_port");
  const state = config.relayStateDir;
  if (port !== 19888 && !state) throw new VibeTransportError("vibe_custom_relay_requires_isolated_state");
  if (state && (!/^\/[a-zA-Z0-9_./-]+$/u.test(state) || state.split("/").includes(".."))) throw new VibeTransportError("vibe_invalid_relay_state");
  const env = {
    ...getDefaultEnvironment(),
    VIBE_REMOTE_URL: "", VIBE_EXTENSION_UUID: "", VIBE_RELAY_UUID: "",
    VIBE_MCP_AGENT_PORT: String(port), VIBE_MCP_EXTENSION_PORT: String(port + 1),
    ...(state ? { VIBE_MCP_STATE_DIR: state, VIBE_MCP_PID_FILE: `${state}/vibebrowser-relay.pid` } : {}),
  };
  const flags = ["start", "--transport", "stdio", "--session", config.sessionId, "--port", String(port)];
  if (config.target === SERVER100_VIBE_TARGET) {
    return {
      command: process.execPath,
      args: ["/home/roomhacker/.local/share/vibebrowser/mcp/node_modules/@vibebrowser/mcp/dist/cli.js", ...flags],
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
      "roomhacker@192.168.2.4", "/usr/bin/env", ...remoteEnv, "/usr/local/bin/node",
      "/Users/roomhacker/.local/share/vibebrowser/mcp/node_modules/@vibebrowser/mcp/dist/cli.js", ...flags],
    env,
    stderr: "pipe",
  };
}

/** Stable ownership identity of the explicit installed browser binding. The
 * default relay keeps its native default state/pid layout. An explicit state
 * path has a different pid layout even when it names the default data folder. */
export function vibeOwnershipNamespace(config: VibeChromeConfig): string {
  vibeStdioParameters(config);
  const binding = ["vibe-ownership-v1", config.target, config.sessionId,
    config.relayPort ?? 19888, config.relayStateDir ? posix.normalize(config.relayStateDir).replace(/\/$/u, "") : "default"];
  return "vibe-" + createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

/** The only native refusal that can prove an unmarked candidate belongs to a
 * different Vibe session. Match the observed full literal and the exact page. */
export function isVibePageOwnershipRefusal(cause: unknown, pageId: number): boolean {
  if (!(cause instanceof VibeTransportError) || cause.code !== "vibe_tool_refused" || !Number.isSafeInteger(pageId) || pageId <= 0) return false;
  const response = record(cause.receipt);
  if (!Array.isArray(response?.content)) return false;
  const parts = response.content.map(record);
  if (!parts.length || parts.some(part => part?.type !== "text" || typeof part.text !== "string")) return false;
  return withoutPageState(parts.map(part => part!.text as string).join("\n")) ===
    `Error: tabId ${pageId} is not authorized for this session \u2014 only the tab this session started on, or tabs it opened itself, can be scripted`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function vibeResultText(response: unknown): string {
  const result = record(response);
  if (!result) throw new VibeTransportError("vibe_invalid_response", response);
  if (result.isError === true) throw new VibeTransportError("vibe_tool_refused", response);
  const structured = record(result.structuredContent);
  for (const envelope of [result, structured]) {
    if (!envelope) continue;
    if (envelope.task || envelope.taskId || envelope.job_id || ["accepted", "pending", "running", "working", "unknown"].includes(String(envelope.status))) {
      throw new VibeTransportError("vibe_operation_pending", response);
    }
  }
  if (!Array.isArray(result.content)) throw new VibeTransportError("vibe_invalid_response", response);
  const text = result.content.map(part => {
    const item = record(part);
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
  try { value = record(JSON.parse(withoutPageState(vibeResultText(response)))); }
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

function pageId(args: Record<string, unknown>): number {
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
  const value = record(error.receipt);
  if (!value || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId)
    || ![MAC_MINI_VIBE_TARGET, SERVER100_VIBE_TARGET].includes(String(value.target))
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
        mapped = { pageId: pageId(args), type: args.type };
        if (args.type === "url") mapped.url = boundedString(args.url, 64 * 1024);
        const timeout = args.timeoutMs ?? args.timeout;
        if (timeout !== undefined) {
          if (!Number.isSafeInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 120_000) throw new VibeTransportError("vibe_invalid_arguments");
          mapped.timeoutMs = timeout;
        }
        break;
      }
      case "take_snapshot": mapped = { pageId: pageId(args), format: "accessibility_tree" }; break;
      case "fill": {
        const uid = boundedString(args.uid, 40);
        if (!/^A[0-9]+$/u.test(uid)) throw new VibeTransportError("vibe_invalid_accessibility_ref");
        mapped = { tabId: pageId(args), uid, value: boundedString(args.value, 512 * 1024) };
        break;
      }
      case "close_page": mapped = { pageId: pageId(args) }; break;
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
    const tab = pageId(args), fn = boundedString(args.function, 512 * 1024);
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
