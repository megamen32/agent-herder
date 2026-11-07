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
  SessionMessageView,
} from "./types/index.js";

type OpenCodePort = Pick<OpenCodeAdapter,
  "init" | "createSession" | "sendMessage" | "getSession" | "getSessionMessages">;

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
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let initialized = false;
  let stopped = false;

  const write = (value: unknown) => output.write(`${JSON.stringify(value)}\n`);
  const error = (id: RpcId | null, code: number, message: string, data?: unknown) =>
    write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  for await (const line of lines) {
    if (!line.trim() || stopped) continue;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      error(null, -32700, "parse error");
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
      write({ jsonrpc: "2.0", id, result: {
        harness: "opencode",
        name: "OpenCode bounded adapter",
        capabilities: { methods: METHODS, controlCapabilities: CONTROL_CAPABILITIES },
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
          result = await adapter.createSession(options);
          break;
        }
        case "sendMessage": {
          const options = params.options;
          if (typeof params.id !== "string" || !params.id.trim() || !isQueuedInput(options)) {
            error(id, -32602, "sendMessage requires session id, queue=true, message, and stable inputId");
            continue;
          }
          // Queue is the only supported mode. activeTurnOnly suppresses the
          // legacy adapter's optional wakeInboxItem PATCH; this call never
          // steers, resumes, falls back, or retries.
          const queued: SendMessageOptions = {
            ...options,
            queue: true,
            activeTurnOnly: true,
          };
          result = await adapter.sendMessage(params.id, queued);
          const receipt = result as SendMessageResult;
          if (receipt.inputId !== options.inputId) {
            result = { ...receipt, inputId: options.inputId as string };
          }
          break;
        }
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
        default:
          error(id, -32601, "method not implemented");
          continue;
      }
      write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch {
      const mutation = request.method === "createSession" || request.method === "sendMessage";
      error(id, -32000, "OpenCode adapter call failed", mutation
        ? { outcome: "unknown", retryable: false }
        : { outcome: "read_failed" });
    }
  }
}

function isCreateOptions(value: unknown): value is CreateSessionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return typeof options.name === "string" && options.name.trim().length > 0
    && typeof options.cwd === "string" && isAbsolute(options.cwd);
}

function isQueuedInput(value: unknown): value is SendMessageOptions & { inputId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  return options.queue === true
    && typeof options.message === "string" && options.message.length > 0
    && options.message.length <= 4 * 1024 * 1024
    && typeof options.inputId === "string" && options.inputId.trim().length > 0
    && options.inputId.length <= 4096;
}

function makeConfiguredAdapter(): OpenCodeAdapter {
  const baseUrl = process.env.AHAP_OPENCODE_BASE_URL?.trim();
  if (!baseUrl) throw new Error("AHAP_OPENCODE_BASE_URL must bind this runner to one OpenCode instance");
  const endpoint = new URL(baseUrl);
  if (!(["http:", "https:"].includes(endpoint.protocol)) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) {
    throw new Error("AHAP_OPENCODE_BASE_URL must be an absolute HTTP(S) endpoint without credentials, query, or fragment");
  }
  // Explicit v2 prevents the legacy HTML compatibility retry from replaying a
  // mutation against the same endpoint after an ambiguous native response.
  return new OpenCodeAdapter({
    baseUrl: endpoint.toString().replace(/\/$/u, ""),
    password: process.env.AHAP_OPENCODE_PASSWORD,
    protocol: "v2",
  });
}

async function main(): Promise<void> {
  if (process.env.AHAP_VERSION !== "0.1" || process.env.AHAP_HARNESS !== "opencode") {
    throw new Error("AHAP_VERSION=0.1 and AHAP_HARNESS=opencode are required");
  }
  await serveOpenCodeAhap(makeConfiguredAdapter());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "unknown startup failure";
    process.stderr.write(`[ahap-opencode] ${message}\n`);
    process.exitCode = 1;
  });
}
