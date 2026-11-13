import { writeAhapFrame, AHAP_MAX_FRAME_BYTES, legacyReadMethods, legacyRead, AhapReadError, adapterFailureContext, type LegacyReadPort } from "./ahap-legacy-read.js";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import type {
  AgentSession,
  CreateSessionOptions,
  SendMessageOptions,
  SendMessageResult,
} from "./types/index.js";

type OpenCodePort = Pick<OpenCodeAdapter,
  "init" | "createSession" | "sendMessage" | "getSession" | "getSessionMessages"> & Partial<Pick<OpenCodeAdapter, "archiveSession" | "resumeSession" | "recover">> & LegacyReadPort;

type RpcId = string | number;
type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const METHODS = ["init", "createSession", "sendMessage", "getSession", "getSessionMessages"];
const CONTROL_CAPABILITIES = {
  cancelTurn: false, detach: false, resume: false, terminate: false,
  recover: false, fork: false, modelSwitch: false, subagents: false,
  events: false, steer: false,
};

/** Run the narrow AHAP v0.1 surface used by the OpenCode create/deliver/read port. */
export async function serveOpenCodeAhap(
  adapter: OpenCodePort,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  family?: "v2" | "v22",
  instanceModel?: string,
): Promise<void> {
  if (instanceModel !== undefined && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(instanceModel)) throw new Error("invalid protected OpenCode instance model");
  if (family !== "v2" && family !== "v22") throw new Error("OpenCode native protocol must be selected before AHAP startup");
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  let stopped = false;
  const createdSessionIds = new Set<string>();
  const attemptedStartSessionIds = new Set<string>();

  const write = (value: unknown) => writeAhapFrame(output, value);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    if (Buffer.byteLength(line, "utf8") + 1 > AHAP_MAX_FRAME_BYTES) { error(null, -32600, "Request exceeds 4 MiB AHAP frame limit; reduce input size"); continue; }
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      error(null, -32700, "parse error");
      continue;
    }
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
      ? request.params as Record<string, unknown>
      : {};

    if (request.method === "initialize") {
      if (initialized || params.harness !== "opencode" || params.ahapVersion !== "0.1") {
        error(id, -32602, "expected one AHAP 0.1 initialize for opencode");
        continue;
      }
      initialized = true;
      const canResume = family === "v2" && typeof adapter.resumeSession === "function";
      const canRecover = family === "v2" && typeof adapter.recover === "function";
      write({ jsonrpc: "2.0", id, result: {
        harness: "opencode",
        name: "OpenCode bounded adapter",
        capabilities: {
          methods: [...new Set([
            ...METHODS,
            ...legacyReadMethods(adapter),
            ...(family === "v2" && typeof adapter.archiveSession === "function" ? ["archiveSession"] : []),
            ...(canResume ? ["resumeSession"] : []),
            ...(canRecover ? ["recover"] : []),
          ])],
          deliveryModes: family === "v22" ? ["start"] : ["queue", "steer", "start"],
          nativeProtocol: family,
          ...(family === "v2" ? { nativeStartAdmission: "steer-before-turn-v1" } : {}),
          controlCapabilities: { ...CONTROL_CAPABILITIES, resume: canResume, recover: canRecover },
        },
      } });
      continue;
    }
    if (!initialized) {
      error(id, -32600, "initialize must be the first request");
      continue;
    }
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
          result = null;
          break;
        case "createSession": {
          const options = params.options;
          if (!isCreateOptions(options)) {
            error(id, -32602, "createSession requires a named session and absolute cwd");
            continue;
          }
          if (instanceModel && options.model !== undefined && options.model !== instanceModel) {
            error(id, -32602, "model conflicts with protected instance route");
            continue;
          }
          result = await adapter.createSession(instanceModel ? { ...options, model: instanceModel } : options);
          if (result && typeof result === "object" && typeof (result as AgentSession).id === "string") {
            createdSessionIds.add((result as AgentSession).id);
          }
          break;
        }
        case "sendMessage": {
          const options = params.options;
          if (typeof params.id !== "string" || !params.id.trim() || !isDeliveryInput(options)) {
            error(id, -32602, "sendMessage expects {id,options:{message,inputId,queue:boolean,steer?}}; select one delivery mode");
            continue;
          }
          if (instanceModel && options.model !== undefined && options.model !== instanceModel) {
            error(id, -32602, "model conflicts with protected instance route");
            continue;
          }
          let delivery: SendMessageOptions = { ...options, ...(instanceModel ? { model: instanceModel } : {}) };
          if (family === "v22") {
            if (options.queue || options.steer || options.start === false
              || !createdSessionIds.has(params.id) || attemptedStartSessionIds.has(params.id)) {
              error(id, -32602, "OpenCode v22 native adapter supports one initial Start on a runner-created session only; use a v2 instance for existing-session queue/steer");
              continue;
            }
            attemptedStartSessionIds.add(params.id);
            delivery = { ...delivery, queue: false, start: true, activeTurnOnly: true };
          } else if (options.start === true) {
            // A fresh v2 Start must enter native execution with its original input.
            // Queue parks it in session_inbox; native steer admits it once now.
            // activeTurnOnly suppresses the separate wakeInboxItem PATCH.
            if (!createdSessionIds.has(params.id) || attemptedStartSessionIds.has(params.id)) {
              error(id, -32602, "v2 Start requires a fresh runner-created session; use queue or steer for an existing session");
              continue;
            }
            attemptedStartSessionIds.add(params.id);
            delivery = { ...delivery, queue: false, steer: true, start: false, activeTurnOnly: true };
          }
          result = await adapter.sendMessage(params.id, delivery);
          const receipt = result as SendMessageResult;
          if (receipt.admitted === true
            && (typeof receipt.nativeInputMessageId !== "string" || !/^msg_[A-Za-z0-9]+$/u.test(receipt.nativeInputMessageId))) {
            throw new Error("OpenCode Start admission has no exact native user receipt");
          }
          break;
        }
        case "listSessions":
        case "getRawTranscript":
        case "listProjects":
          result = await legacyRead(adapter, request.method, params);
          break;
        case "archiveSession":
          if (family !== "v2" || typeof adapter.archiveSession !== "function") { error(id, -32601, "method not implemented"); continue; }
          if (typeof params.id !== "string" || !/^ses_[A-Za-z0-9]+$/u.test(params.id)) { error(id, -32602, "archiveSession requires exact session id"); continue; }
          result = await adapter.archiveSession(params.id);
          break;
        case "getSession":
          if (typeof params.id !== "string" || !params.id.trim()) {
            error(id, -32602, "getSession requires session id");
            continue;
          }
          result = await adapter.getSession(params.id);
          break;
        case "getSessionMessages":
          if (typeof params.id !== "string" || !params.id.trim()
            || (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200))) {
            error(id, -32602, "getSessionMessages requires session id and a limit from 1 to 200");
            continue;
          }
          result = await adapter.getSessionMessages(params.id, params.limit as number | undefined);
          break;
        case "resumeSession":
          if (family !== "v2" || typeof adapter.resumeSession !== "function") { error(id, -32601, "method not implemented"); continue; }
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "resumeSession requires session id"); continue; }
          result = await adapter.resumeSession(params.id);
          break;
        case "recover": {
          if (family !== "v2" || typeof adapter.recover !== "function") { error(id, -32601, "method not implemented"); continue; }
          if (typeof params.id !== "string" || !params.id.trim()) { error(id, -32602, "recover requires session id"); continue; }
          if (params.message !== undefined && (typeof params.message !== "string" || params.message.length === 0 || params.message.length > 4 * 1024 * 1024)) {
            error(id, -32602, "recover message must be a non-empty string up to 4 MiB");
            continue;
          }
          result = await adapter.recover(params.id, params.message as string | undefined);
          break;
        }
        default:
          error(id, -32601, "method not implemented");
          continue;
      }
      write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (cause) {
      if (cause instanceof AhapReadError) {
        error(id, cause.code, cause.message, cause.code === -32001 ? adapterFailureContext(request.method, request.method === "sendMessage" || request.method === "createSession") : undefined);
        continue;
      }
      const mutation = request.method === "createSession" || request.method === "sendMessage" || request.method === "archiveSession";
      error(id, -32000, "OpenCode adapter call failed", adapterFailureContext(request.method, mutation));
    }
  }
}

function isCreateOptions(value: unknown): value is CreateSessionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.name === "string" && options.name.trim().length > 0
    && typeof options.cwd === "string" && isAbsolute(options.cwd);
}

function isDeliveryInput(value: unknown): value is SendMessageOptions & { inputId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.queue === "boolean"
    && (options.steer === undefined || typeof options.steer === "boolean")
    && (options.start === undefined || typeof options.start === "boolean")
    && !(options.queue === true && options.steer === true)
    && !(options.start === true && options.steer === true)
    && typeof options.message === "string" && options.message.length > 0
    && options.message.length <= 4 * 1024 * 1024
    && typeof options.inputId === "string" && options.inputId.trim().length > 0
    && options.inputId.length <= 4096;
}

export async function makeConfiguredAdapter(baseUrl = process.env.AHAP_OPENCODE_BASE_URL?.trim(), password = process.env.AHAP_OPENCODE_PASSWORD): Promise<{adapter: OpenCodeAdapter; family: "v2" | "v22"}> {
  if (!baseUrl) throw new Error("AHAP_OPENCODE_BASE_URL must bind this runner to one OpenCode instance");
  const endpoint = new URL(baseUrl);
  if (!(["http:", "https:"].includes(endpoint.protocol)) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) {
    throw new Error("AHAP_OPENCODE_BASE_URL must be an absolute HTTP(S) endpoint without credentials, query, or fragment");
  }
  // Match the existing native receipt fixture: decide once, via a bounded
  // read-only probe, before any session create or delivery is possible.
  const headers: Record<string, string> = {};
  if (password) headers.Authorization = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${password}`).toString("base64")}`;
  const probe = await fetch(`${endpoint.toString().replace(/\/$/u, "")}/api/config`, { headers, signal: AbortSignal.timeout(5_000), redirect: "error" });
  let family: "v2" | "v22";
  if (probe.status === 404) {
    const health = await fetch(`${endpoint.toString().replace(/\/$/u, "")}/api/health`, { headers, signal: AbortSignal.timeout(5_000), redirect: "error" });
    let value: unknown;
    try { value = await health.json(); } catch { throw new Error("invalid OpenCode health JSON; no mutation sent"); }
    if (health.status !== 200 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("unverified OpenCode v22 health; no mutation sent");
    family = "v22";
  }
  else if (probe.status === 200) {
    let body: unknown;
    try { body = await probe.json(); }
    catch { throw new Error("invalid OpenCode API config JSON; no mutation sent"); }
    if (body === null) family = "v22";
    else if (typeof body === "object") family = "v2";
    else throw new Error("unrecognized OpenCode API config; no mutation sent");
  } else throw new Error(`OpenCode API probe HTTP ${probe.status}; no mutation sent`);
  const adapter = new OpenCodeAdapter({
    baseUrl: endpoint.toString().replace(/\/$/u, ""),
    password,
    protocol: family,
  });
  return {adapter, family};
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || process.env.AHAP_HARNESS !== "opencode") {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=opencode are required");
  }
  const {adapter, family} = await makeConfiguredAdapter();
  await serveOpenCodeAhap(adapter, process.stdin, process.stdout, family, process.env.AHAP_OPENCODE_MODEL);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "unknown startup failure";
    process.stderr.write(`[ahap-opencode] ${message}\n`);
    process.exitCode = 1;
  });
}
