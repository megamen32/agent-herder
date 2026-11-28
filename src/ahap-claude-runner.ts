import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ClaudeSDKAdapter } from "./adapters/claude-sdk.js";
import { AHAP_MAX_FRAME_BYTES, AhapReadError, legacyRead, writeAhapFrame } from "./ahap-legacy-read.js";

const target = z.object({ id: z.string().uuid() });
const createOptions = z.object({
  cwd: z.string().refine(isAbsolute), name: z.string().trim().min(1).max(256),
  model: z.string().min(1).optional(), effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: z.enum(["default", "plan", "acceptEdits", "dontAsk"]).optional(),
  thinkingBudget: z.number().int().min(0).max(128000).optional(),
}).strict();
const input = z.object({
  message: z.string().min(1), inputId: z.string().min(1).max(4096), queue: z.boolean(),
  origin: z.literal("automation").optional(),
  steer: z.boolean().optional(), activeTurnOnly: z.boolean().optional(), expectedTurnId: z.string().optional(),
}).strict();
const methods = ["init", "listSessions", "getSession", "getRawTranscript", "getSessionMessages",
  "createSession", "sendMessage", "getCoordinationActiveTurnId", "cancelTurn", "stopSession",
  "resumeSession", "getPermissionState", "respondPermission"];

export async function serveClaudeAhap(adapter: ClaudeSDKAdapter, stdin: Readable, stdout: Writable) {
  let initialized = false;
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let id: number | string | null = null;
      try {
        if (Buffer.byteLength(line) + 1 > AHAP_MAX_FRAME_BYTES) throw new AhapReadError(-32600, "Frame too large");
        const request = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string()]),
          method: z.string(), params: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(line));
        id = request.id;
        const params = request.params ?? {};
        let result: unknown;
        if (request.method === "initialize") {
          if (initialized || params.harness !== "claude" || params.ahapVersion !== "0.1") throw new AhapReadError(-32602, "Expected Claude AHAP 0.1");
          initialized = true;
          result = { harness: "claude", name: adapter.name, capabilities: {
            nativeProtocol: "claude-agent-sdk", methods, deliveryModes: ["queue", "steer"],
            controlCapabilities: { ...adapter.controlCapabilities, cancelTurn: true },
          } };
        } else if (!initialized) throw new AhapReadError(-32600, "Initialize first");
        else switch (request.method) {
          case "init": await adapter.init(); break;
          case "shutdown": writeAhapFrame(stdout, { jsonrpc: "2.0", id, result: null }); return;
          case "listSessions": case "getRawTranscript": result = await legacyRead(adapter, request.method, params); break;
          case "getSession": result = await adapter.getSession(target.parse(params).id); break;
          case "getSessionMessages": {
            const p = target.extend({ limit: z.number().int().min(1).max(200).optional(), recoverInputId: z.string().min(1).max(4096).optional() }).parse(params);
            result = await adapter.getSessionMessages(p.id, p.limit, p.recoverInputId); break;
          }
          case "createSession": result = await adapter.createSession(createOptions.parse(params.options)); break;
          case "sendMessage": {
            const p = target.extend({ options: input }).parse(params);
            if (p.options.expectedTurnId && p.options.expectedTurnId !== await adapter.getCoordinationActiveTurnId(p.id)) {
              result = { ok: false, notSubmitted: true, error: "Selected Claude turn changed" }; break;
            }
            result = await adapter.sendMessage(p.id, p.options); break;
          }
          case "getCoordinationActiveTurnId": result = await adapter.getCoordinationActiveTurnId(target.parse(params).id); break;
          case "cancelTurn": {
            const p = target.extend({ inputMessageId: z.string().uuid() }).parse(params);
            const matches = p.inputMessageId === await adapter.getCoordinationActiveTurnId(p.id);
            result = { sessionId: p.id, inputMessageId: p.inputMessageId, cancelled: matches && (await adapter.stopSession(p.id)).ok }; break;
          }
          case "stopSession": result = await adapter.stopSession(target.parse(params).id); break;
          case "resumeSession": result = await adapter.resumeSession(target.parse(params).id); break;
          case "getPermissionState": result = await adapter.getPermissionState(target.parse(params).id); break;
          case "respondPermission": {
            const p = target.extend({ permissionId: z.string(), response: z.enum(["allow", "deny"]) }).parse(params);
            result = await adapter.respondPermission(p.id, p.permissionId, p.response); break;
          }
          default: throw new AhapReadError(-32601, "Unknown Claude adapter method");
        }
        writeAhapFrame(stdout, { jsonrpc: "2.0", id, result: result ?? null });
      } catch (error) {
        const code = error instanceof AhapReadError ? error.code : error instanceof SyntaxError ? -32700 : error instanceof z.ZodError ? -32602 : -32000;
        writeAhapFrame(stdout, { jsonrpc: "2.0", id, error: { code, message: error instanceof AhapReadError ? error.message : "Claude adapter request failed" } });
      }
    }
  } finally { lines.close(); await adapter.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await serveClaudeAhap(new ClaudeSDKAdapter(), process.stdin, process.stdout);
}
