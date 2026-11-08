import { writeAhapFrame, AHAP_MAX_FRAME_BYTES, legacyReadMethods, legacyRead, AhapReadError, adapterFailureContext, type LegacyReadPort } from "./ahap-legacy-read.js";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { CreateSessionOptions, SendMessageOptions, SendMessageResult } from "./types/common.js";
import { CodexQuotaBlockedError } from "./codex-quota-guard.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server.js";

type RpcId = string | number;
interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type CodexAhapPort = Pick<CodexAppServerAdapter, "init" | "createSession" | "sendMessage" | "getSession" | "getSessionMessages" | "dispose"> & Partial<Pick<CodexAppServerAdapter, "archiveSession">> & LegacyReadPort;

const METHODS = ["init", "createSession", "sendMessage", "getSession", "getSessionMessages"];
const CONTROL_CAPABILITIES = {
  cancelTurn: false, detach: false, resume: false, terminate: false,
  recover: false, fork: false, modelSwitch: false, subagents: false,
  events: false, steer: false,
};
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const QUOTA_DENIAL_REASONS = new Set([
  "provider_denied", "below_reserve", "quota_snapshot_expired", "quota_unknown", "quota_policy_unavailable",
]);

/** AHAP v0.1 facade over the existing CI/legacy CodexAppServerAdapter. It owns no
 * native protocol; delivery and receipts remain owned by the legacy adapter. */
export async function serveCodexAhap(
  adapter: CodexAhapPort,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  instanceModel?: string,
): Promise<void> {
  if (instanceModel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(instanceModel)) throw new Error("invalid protected Codex instance model");
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  let stopped = false;
  const write = (value: unknown) => writeAhapFrame(output, value);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    if (Buffer.byteLength(line, "utf8") + 1 > AHAP_MAX_FRAME_BYTES) {
      error(null, -32600, "request exceeds AHAP frame limit");
      continue;
    }
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
      if (initialized || params.harness !== "codex" || params.ahapVersion !== "0.1") {
        error(id, -32602, "expected one AHAP 0.1 initialize for codex");
        continue;
      }
      initialized = true;
      write({ jsonrpc: "2.0", id, result: {
        harness: "codex", name: "Codex legacy adapter via AHAP",
        capabilities: { deliveryModes: ["queue", "sync", "steer"], methods: [...new Set([...METHODS, ...legacyReadMethods(adapter), ...(typeof adapter.archiveSession === "function" ? ["archiveSession"] : [])])], controlCapabilities: CONTROL_CAPABILITIES },
      } });
      continue;
    }
    if (!initialized) { error(id, -32600, "initialize must be the first request"); continue; }
    if (request.method === "shutdown") {
      try { await adapter.dispose(); write({ jsonrpc: "2.0", id, result: null }); }
      catch { error(id, -32000, "Codex adapter shutdown failed"); }
      stopped = true;
      lines.close();
      continue;
    }

    try {
      let result: unknown;
      switch (request.method) {
        case "init":
          await adapter.init(); result = null; break;
        case "createSession": {
          if (!isCreateOptions(params.options)) {
            error(id, -32602, "createSession requires name, absolute cwd, and restricted permissions");
            continue;
          }
          if (instanceModel && params.options.model !== undefined && params.options.model !== instanceModel) {
            error(id, -32602, "model conflicts with protected instance route"); continue;
          }
          result = await adapter.createSession({ ...params.options, ...(instanceModel ? { model: instanceModel } : {}), fullAccess: false });
          break;
        }
        case "sendMessage": {
          if (typeof params.id !== "string" || !params.id.trim() || !isDeliveryInput(params.options)) {
            error(id, -32602, "sendMessage requires exact session id, explicit queue boolean, message, and stable inputId");
            continue;
          }
          if (instanceModel && params.options.model !== undefined && params.options.model !== instanceModel) {
            error(id, -32602, "model conflicts with protected instance route"); continue;
          }
          const options: SendMessageOptions = { ...params.options, ...(instanceModel ? { model: instanceModel } : {}) };
          const receipt: SendMessageResult = await adapter.sendMessage(params.id, options);
          // Keep the adapter's receipt fields verbatim. inputId remains the
          // caller correlation; nativeInputMessageId is present only when the
          // adapter read an exact native Codex message anchor. turnId is separate.
          result = receipt;
          break;
        }
        case "listSessions":
        case "getRawTranscript":
        case "listProjects":
          result = await legacyRead(adapter, request.method, params);
          break;
        case "archiveSession":
          if (typeof adapter.archiveSession !== "function") { error(id, -32601, "method not implemented"); continue; }
          if (!validSessionId(params.id)) { error(id, -32602, "archiveSession requires exact session id"); continue; }
          result = await adapter.archiveSession(params.id);
          break;
        case "getSession":
          if (!validSessionId(params.id)) { error(id, -32602, "getSession requires a valid session id"); continue; }
          result = await adapter.getSession(params.id);
          break;
        case "getSessionMessages":
          if (!validSessionId(params.id) || (params.limit !== undefined
            && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200))) {
            error(id, -32602, "getSessionMessages requires exact session id and limit 1..200");
            continue;
          }
          result = await adapter.getSessionMessages(params.id, params.limit as number | undefined);
          break;
        default:
          error(id, -32601, "method not implemented");
          continue;
      }
      write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (cause) {
      // Only this typed pre-admission guard proves that thread creation was not sent.
      // Never infer safety from an error name, message, or duck-typed receipt.
      if (request.method === "createSession" && cause instanceof CodexQuotaBlockedError
        && cause.operation === "thread/start" && QUOTA_DENIAL_REASONS.has(cause.decision.reason)) {
        error(id, -32000, "Codex quota guard blocked session creation before submission", {
          outcome: "not_submitted", admitted: false, notSubmitted: true, retryable: false,
          code: "codex_quota_guard", method: "createSession", operation: "thread/start", reason: cause.decision.reason,
        });
        continue;
      }
      if (cause instanceof AhapReadError) {
        error(id, cause.code, cause.message, cause.code === -32001 ? adapterFailureContext(request.method, request.method === "sendMessage" || request.method === "createSession") : undefined);
        continue;
      }
      const mutation = request.method === "createSession" || request.method === "sendMessage" || request.method === "archiveSession";
      error(id, -32000, "Codex adapter call failed", adapterFailureContext(request.method, mutation));
    }
  }
}

function isCreateOptions(value: unknown): value is CreateSessionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.name === "string" && options.name.trim().length > 0
    && options.name.length <= 256
    && typeof options.cwd === "string" && options.cwd.startsWith("/")
    && options.fullAccess !== true;
}

function isDeliveryInput(value: unknown): value is SendMessageOptions & { inputId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.queue === "boolean"
    && (options.steer === undefined || typeof options.steer === "boolean")
    && !(options.queue === true && options.steer === true)
    && options.start !== true
    && typeof options.message === "string" && options.message.length > 0
    && options.message.length <= MAX_FRAME_BYTES
    && typeof options.inputId === "string" && options.inputId.trim().length > 0
    && options.inputId.length <= 4096;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Owner profile chooses one transport; inherited CODEX_APP_SERVER_SOCKET cannot select it. */
export function codexRunnerConfig(env: NodeJS.ProcessEnv = process.env) {
  const socketPath = env.AHAP_CODEX_SOCKET?.trim();
  const codexBin = env.AHAP_CODEX_BIN?.trim();
  const cwd = env.AHAP_CODEX_CWD?.trim();
  if (!env.HOME || !isAbsolute(env.HOME) || !cwd || !isAbsolute(cwd)) {
    throw new Error("HOME and AHAP_CODEX_CWD must be absolute owner-profile paths");
  }
  if (!!socketPath === !!codexBin) throw new Error("Set exactly one AHAP_CODEX_SOCKET or AHAP_CODEX_BIN; implicit transport discovery is disabled");
  if (socketPath && (!isAbsolute(socketPath) || /[:?\u0000-\u001f]/u.test(socketPath))) throw new Error("AHAP_CODEX_SOCKET must be an absolute Unix socket path without colon, query or control characters");
  if (codexBin && (!isAbsolute(codexBin) || /[\u0000-\u001f]/u.test(codexBin))) throw new Error("AHAP_CODEX_BIN must be an absolute executable path");
  if (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME)) throw new Error("CODEX_HOME must be an absolute data directory");
  return { socketPath: socketPath ?? "", codexBin, cwd, codexDir: env.CODEX_HOME || join(env.HOME, ".codex") };
}
export function makeConfiguredAdapter(): CodexAppServerAdapter {
  return new CodexAppServerAdapter(codexRunnerConfig());
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || process.env.AHAP_HARNESS !== "codex") {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=codex are required");
  }
  const adapter = makeConfiguredAdapter();
  try { await serveCodexAhap(adapter, process.stdin, process.stdout, process.env.AHAP_CODEX_MODEL); } finally { await adapter.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "unknown startup failure";
    process.stderr.write(`[ahap-codex] ${message}\n`);
    process.exitCode = 1;
  });
}
