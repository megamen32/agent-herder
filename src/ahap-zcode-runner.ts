import { writeAhapFrame, AHAP_MAX_FRAME_BYTES, legacyReadMethods, legacyRead, AhapReadError, adapterFailureContext, type LegacyReadPort } from "./ahap-legacy-read.js";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { CreateSessionOptions, SendMessageOptions, SendMessageResult } from "./types/common.js";
import { ZcodeAdapter } from "./adapters/zcode.js";
import { ZcodeTranscriptReadError } from "./adapters/zcode-native-transcript.js";
import { ZCODE_COLD_CONTINUATION } from "./adapters/zcode-cold-continuation.js";

type RpcId = string | number;
interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type ZcodeAhapPort = Pick<ZcodeAdapter, "init" | "createSession" | "sendMessage" | "getSession" | "getSessionMessages" | "dispose"> & Partial<Pick<ZcodeAdapter, "archiveSession" | "getQueuedContinuationState" | "sendHerderQueuedMessage" | "nativeColdContinuationSupported">> & LegacyReadPort;

const METHODS = ["init", "createSession", "sendMessage", "getSession", "getSessionMessages"];
const CONTROL_CAPABILITIES = {
  cancelTurn: false, detach: false, resume: false, terminate: false,
  recover: false, fork: false, modelSwitch: false, subagents: false,
  events: false, steer: false,
};
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** AHAP v0.1 facade over the existing CI/legacy ZcodeAdapter. It owns no
 * native protocol and deliberately exposes only the bounded create, Queue and
 * exact read methods needed by the new core. */
export async function serveZcodeAhap(
  adapter: ZcodeAhapPort,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  let stopped = false;
  const coldQueueSupported = () => adapter.nativeColdContinuationSupported === true
    && typeof adapter.getQueuedContinuationState === "function" && typeof adapter.sendHerderQueuedMessage === "function";
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
      if (initialized || params.harness !== "zcode" || params.ahapVersion !== "0.1") {
        error(id, -32602, "expected one AHAP 0.1 initialize for zcode");
        continue;
      }
      initialized = true;
      write({ jsonrpc: "2.0", id, result: {
        harness: "zcode", name: "ZCode legacy adapter via AHAP",
        capabilities: { deliveryModes: ["queue", "sync", "steer"],
          nativeAutomaticContinuation: coldQueueSupported() ? ZCODE_COLD_CONTINUATION : "unsupported-no-idle-admission-v1",
          methods: [...new Set([...METHODS, ...legacyReadMethods(adapter), ...(typeof adapter.archiveSession === "function" ? ["archiveSession"] : []),
            ...(coldQueueSupported() ? ["getQueuedContinuationState"] : [])])], controlCapabilities: CONTROL_CAPABILITIES },
      } });
      continue;
    }
    if (!initialized) { error(id, -32600, "initialize must be the first request"); continue; }
    if (request.method === "shutdown") {
      try { await adapter.dispose(); write({ jsonrpc: "2.0", id, result: null }); }
      catch { error(id, -32000, "ZCode adapter shutdown failed"); }
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
          // Never inherit ZcodeAdapter's implicit full-access create default.
          result = await adapter.createSession({ ...params.options, mode: "build", fullAccess: false });
          break;
        }
        case "sendMessage": {
          if (typeof params.id !== "string" || !params.id.trim() || !isDeliveryInput(params.options)) {
            error(id, -32602, "sendMessage expects exact session id, explicit queue boolean, message and stable inputId; queue and steer are mutually exclusive");
            continue;
          }
          const options: SendMessageOptions = { ...params.options };
          const receipt: SendMessageResult = options.queue && !options.steer && coldQueueSupported()
            ? await adapter.sendHerderQueuedMessage!(params.id, options)
            : await adapter.sendMessage(params.id, options);
          // Keep the adapter's receipt fields verbatim. inputId remains the
          // caller correlation; nativeInputMessageId is present only when the
          // adapter read an exact native ZCode message anchor. turnId is separate.
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
        case "getQueuedContinuationState":
          if (!coldQueueSupported()) { error(id, -32601, "controlled cold Queue preparation unavailable"); continue; }
          if (!validSessionId(params.id)) { error(id, -32602, "getQueuedContinuationState requires exact session id"); continue; }
          result = await adapter.getQueuedContinuationState!(params.id);
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
      if (cause instanceof AhapReadError) {
        error(id, cause.code, cause.message, cause.code === -32001 ? adapterFailureContext(request.method, request.method === "sendMessage" || request.method === "createSession" || request.method === "archiveSession") : undefined);
        continue;
      }
      const mutation = request.method === "createSession" || request.method === "sendMessage" || request.method === "archiveSession";
      error(id, -32000, "ZCode adapter call failed", { ...adapterFailureContext(request.method, mutation),
        ...(!mutation && cause instanceof ZcodeTranscriptReadError ? { diagnostic: cause.diagnostic } : {}) });
    }
  }
}

function isCreateOptions(value: unknown): value is CreateSessionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.name === "string" && options.name.trim().length > 0
    && options.name.length <= 256
    && typeof options.cwd === "string" && options.cwd.startsWith("/")
    && options.fullAccess !== true
    && (options.mode === undefined || options.mode === "build");
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

export interface ZcodeCreateModelPin {
  getPinnedCreateModel(): string;
  verifyPinnedCreateModel(): Promise<{
    model: string; provider_id: string; model_id: string; reasoning_level: string;
    source: "zcode-native-create-model-catalog"; observed_at: string;
    listed_models: string[]; native_catalog_entry: unknown;
  }>;
}

/** A protected owner profile may choose a model for its own new sessions.
 * This neither changes native defaults nor substitutes another provider. */
export function pinZcodeCreateModel<T extends Pick<ZcodeAdapter, "createSession" | "listModels" | "readCreateModelCatalog">>(
  adapter: T, configured: string | undefined,
): T & Partial<ZcodeCreateModelPin> {
  if (configured === undefined) return adapter;
  if (configured.trim() !== configured || !/^[^/\s$]+\/[^/\s$]+\$[^/\s$]+$/u.test(configured) || configured.length > 512) {
    throw new Error("AHAP_ZCODE_CREATE_MODEL requires exact provider/model$reasoning");
  }
  const [base, reasoning] = configured.split("$");
  const [provider, model] = base.split("/");
  const create = adapter.createSession.bind(adapter);
  const verify = async () => {
    const listed = await adapter.listModels();
    const catalog = await adapter.readCreateModelCatalog();
    const settings = catalog.settings as {model?: {available?: unknown[]}} | undefined;
    const available = settings?.model?.available;
    const matches = Array.isArray(available) ? available.filter(value => {
      const ref = (value as {ref?: {providerId?: unknown; modelId?: unknown}})?.ref;
      return ref?.providerId === provider && ref.modelId === model;
    }) : [];
    const entry = matches[0] as {reasoning?: {levels?: Array<{value?: unknown}>}} | undefined;
    const levels = entry?.reasoning?.levels;
    if (!Array.isArray(listed) || !listed.every(value => typeof value === "string")
        || (!listed.includes(base) && !listed.includes(configured)) || matches.length !== 1
        || !Array.isArray(levels) || levels.some(value => typeof value?.value !== "string")
        || levels.filter(value => value.value === reasoning).length !== 1) {
      throw new Error("Pinned ZCode model or reasoning is unavailable in the native catalog");
    }
    return {model: configured, provider_id: provider, model_id: model, reasoning_level: reasoning,
      source: "zcode-native-create-model-catalog" as const, observed_at: new Date().toISOString(),
      listed_models: listed, native_catalog_entry: matches[0]};
  };
  adapter.createSession = async options => {
    if (options.model !== undefined && options.model !== configured) {
      throw new Error("Caller model conflicts with the pinned ZCode create model");
    }
    await verify();
    return create({...options, model: configured});
  };
  return Object.assign(adapter, {getPinnedCreateModel: () => configured, verifyPinnedCreateModel: verify});
}

export function makeConfiguredAdapter(): ZcodeAdapter {
  const command = process.env.AHAP_ZCODE_SERVER_NODE?.trim();
  const entry = process.env.AHAP_ZCODE_SERVER_ENTRY?.trim();
  const cwd = process.env.AHAP_ZCODE_CWD?.trim();
  const transport = process.env.AHAP_ZCODE_TRANSPORT?.trim();
  if (transport === "official-server") {
    const home = process.env.HOME;
    if (!home?.startsWith("/") || !cwd?.startsWith("/")) {
      throw new Error("official-server requires absolute HOME and AHAP_ZCODE_CWD");
    }
    if (command || entry || process.env.ZCODE_SERVER_NODE) {
      throw new Error("official-server forbids custom command overrides");
    }
    if (!existsSync(join(home, ".zcode/server/run/control.sock"))) {
      throw new Error("official-server control.sock unavailable; no stdio fallback");
    }
    // Reuse the legacy authenticated supervisor route, never the unrelated
    // JSON CLI app-server as a zcode-hello/binary stdio transport.
    const adapter = new ZcodeAdapter({ cwd });
    if (!adapter.nativeReadWithoutActivation) {
      throw new Error("official-server route was not selected; no stdio fallback");
    }
    return pinZcodeCreateModel(adapter, process.env.AHAP_ZCODE_CREATE_MODEL);
  }
  // Preserve the already explicitly configured custom binary contract.
  if (transport !== undefined && transport !== "custom-stdio") {
    throw new Error("AHAP_ZCODE_TRANSPORT must be official-server or custom-stdio");
  }
  if (!command?.startsWith("/") || !entry?.startsWith("/") || !cwd?.startsWith("/")) {
    throw new Error("AHAP_ZCODE_SERVER_NODE, AHAP_ZCODE_SERVER_ENTRY and AHAP_ZCODE_CWD must be absolute paths");
  }
  return pinZcodeCreateModel(new ZcodeAdapter({ command, args: [entry], cwd }), process.env.AHAP_ZCODE_CREATE_MODEL);
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || process.env.AHAP_HARNESS !== "zcode") {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=zcode are required");
  }
  await serveZcodeAhap(makeConfiguredAdapter());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "unknown startup failure";
    process.stderr.write(`[ahap-zcode] ${message}\n`);
    process.exitCode = 1;
  });
}

// Maintained read-only supervisor proof for the exact installed CI owner.
export {readZcodeOfficialRunning} from './adapters/zcode-server-control.js';
