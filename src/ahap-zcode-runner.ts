import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type { CreateSessionOptions, SendMessageOptions, SendMessageResult } from "./types/common.js";
import { ZcodeAdapter } from "./adapters/zcode.js";

type RpcId = string | number;
interface RpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type ZcodeAhapPort = Pick<ZcodeAdapter, "init" | "createSession" | "sendMessage" | "getSession" | "getSessionMessages" | "dispose">;

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
  const write = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
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
        capabilities: { methods: METHODS, controlCapabilities: CONTROL_CAPABILITIES },
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
          if (typeof params.id !== "string" || !params.id.trim() || !isQueuedInput(params.options)) {
            error(id, -32602, "sendMessage requires exact session id, Queue, message, and stable inputId");
            continue;
          }
          const options: SendMessageOptions = {
            message: params.options.message,
            queue: true,
            activeTurnOnly: true,
            inputId: params.options.inputId,
            origin: "automation",
          };
          const receipt: SendMessageResult = await adapter.sendMessage(params.id, options);
          // Keep the legacy adapter's receipt fields verbatim. In particular,
          // inputId is correlation and is never renamed as a native message ID.
          result = receipt;
          break;
        }
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
    } catch {
      const mutation = request.method === "createSession" || request.method === "sendMessage";
      error(id, -32000, "ZCode adapter call failed", mutation
        ? { outcome: "unknown", retryable: false }
        : { outcome: "read_failed" });
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

function isQueuedInput(value: unknown): value is SendMessageOptions & { inputId: string; queue: true } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return options.queue === true
    && options.steer !== true
    && typeof options.message === "string" && options.message.length > 0
    && options.message.length <= MAX_FRAME_BYTES
    && typeof options.inputId === "string" && options.inputId.trim().length > 0
    && options.inputId.length <= 4096;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function makeConfiguredAdapter(): ZcodeAdapter {
  const command = process.env.AHAP_ZCODE_SERVER_NODE?.trim();
  const entry = process.env.AHAP_ZCODE_SERVER_ENTRY?.trim();
  const cwd = process.env.AHAP_ZCODE_CWD?.trim();
  if (!command?.startsWith("/") || !entry?.startsWith("/") || !cwd?.startsWith("/")) {
    throw new Error("AHAP_ZCODE_SERVER_NODE, AHAP_ZCODE_SERVER_ENTRY and AHAP_ZCODE_CWD must be absolute paths");
  }
  return new ZcodeAdapter({ command, args: [entry], cwd });
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
