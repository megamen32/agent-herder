import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";

const PROTOCOL_HEADER_SIZE = 13;
const REGULAR_MESSAGE_TYPE = 1;
const INITIALIZE_MESSAGE_TYPE = 200;
const RESPONSE_MESSAGE_TYPE = 201;
const ERROR_MESSAGE_TYPE = 202;
const CANCELED_MESSAGE_TYPE = 203;

export interface ZcodeAppServerClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface ZcodeClientLike {
  start(): Promise<void>;
  call(channel: string, method: string, args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DecodedValue {
  value: unknown;
  offset: number;
}

/** ZCode's compact unsigned variable-length quantity encoding. */
function encodeVariableLengthQuantity(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ZCode protocol requires a non-negative integer, got ${String(value)}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let next = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeVariableLengthQuantity(data: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  for (let i = 0; i < 8; i += 1) {
    if (cursor >= data.byteLength) throw new Error("Truncated ZCode variable-length quantity");
    const next = data[cursor++];
    value += (next & 0x7f) * multiplier;
    if ((next & 0x80) === 0) return { value, offset: cursor };
    multiplier *= 128;
  }
  throw new Error("Invalid ZCode variable-length quantity");
}

/** Serialize one value using the wire format used by ZCode's SocketProtocol. */
export function encodeZcodeValue(value: unknown): Buffer {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([1]), encodeVariableLengthQuantity(bytes.byteLength), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([2]), encodeVariableLengthQuantity(bytes.byteLength), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from([4]),
      encodeVariableLengthQuantity(value.length),
      ...value.map((item) => encodeZcodeValue(item)),
    ]);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return Buffer.concat([Buffer.from([6]), encodeVariableLengthQuantity(value)]);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`Unsupported ZCode protocol value type: ${typeof value}`);
  }
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from([5]), encodeVariableLengthQuantity(bytes.byteLength), bytes]);
}

/** Decode one value from the ZCode wire format. */
export function decodeZcodeValue(data: Uint8Array, offset = 0): DecodedValue {
  if (offset >= data.byteLength) throw new Error("Truncated ZCode serialized value");
  const type = data[offset++];
  if (type === 0) return { value: undefined, offset };
  if (type === 1 || type === 2) {
    const length = decodeVariableLengthQuantity(data, offset);
    const end = length.offset + length.value;
    if (end > data.byteLength) throw new Error("Truncated ZCode byte/string value");
    const bytes = data.slice(length.offset, end);
    return { value: type === 1 ? Buffer.from(bytes).toString("utf8") : Buffer.from(bytes), offset: end };
  }
  if (type === 4) {
    const length = decodeVariableLengthQuantity(data, offset);
    const values: unknown[] = [];
    let cursor = length.offset;
    for (let i = 0; i < length.value; i += 1) {
      const decoded = decodeZcodeValue(data, cursor);
      values.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value: values, offset: cursor };
  }
  if (type === 5) {
    const length = decodeVariableLengthQuantity(data, offset);
    const end = length.offset + length.value;
    if (end > data.byteLength) throw new Error("Truncated ZCode JSON value");
    return { value: JSON.parse(Buffer.from(data.slice(length.offset, end)).toString("utf8")), offset: end };
  }
  if (type === 6) {
    const decoded = decodeVariableLengthQuantity(data, offset);
    return { value: decoded.value, offset: decoded.offset };
  }
  throw new Error(`Unknown ZCode serialized value type ${type}`);
}

/** Encode one regular channel request frame. */
export function encodeZcodeRpcCall(id: number, channel: string, method: string, args: unknown[]): Buffer {
  const body = Buffer.concat([
    encodeZcodeValue([100, id, channel, method]),
    encodeZcodeValue(args),
  ]);
  const frame = Buffer.alloc(PROTOCOL_HEADER_SIZE + body.byteLength);
  frame.writeUInt8(REGULAR_MESSAGE_TYPE, 0);
  frame.writeUInt32BE(0, 1);
  frame.writeUInt32BE(0, 5);
  frame.writeUInt32BE(body.byteLength, 9);
  body.copy(frame, PROTOCOL_HEADER_SIZE);
  return frame;
}

function errorFromPayload(payload: unknown, fallback: string): Error {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : undefined;
    const error = new Error(message || fallback);
    if (typeof record.code === "string") {
      Object.assign(error, { code: record.code });
    }
    if (record.data !== undefined) {
      Object.assign(error, { data: record.data });
    }
    return error;
  }
  return new Error(fallback);
}

/**
 * Native stdio client for ZCode's app-server channel protocol.
 *
 * The app-server emits a JSON hello line, then switches to a 13-byte
 * length-prefixed binary protocol. This class intentionally owns that
 * framing instead of treating ZCode as MCP/JSON-RPC-over-newline.
 */
export class ZcodeAppServerClient implements ZcodeClientLike {
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private child?: ChildProcessWithoutNullStreams;
  private outputBuffer = Buffer.alloc(0);
  private handshakeDone = false;
  private ready = false;
  private startPromise?: Promise<void>;
  private serverReady?: () => void;
  private serverReadyError?: (error: Error) => void;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(options: ZcodeAppServerClientOptions) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const child = spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.outputBuffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.ready = false;

    let settled = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      this.serverReady = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.serverReadyError = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (process.env.AGENT_HERDER_ZCODE_DEBUG === "1") {
        process.stderr.write(`[agent-herder][zcode] ${chunk.toString("utf8")}`);
      }
    });
    child.on("error", (error) => {
      this.serverReadyError?.(error);
      this.rejectPending(error);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(`ZCode app-server exited before ready: ${code ?? signal ?? "unknown"}`);
      this.ready = false;
      this.handshakeDone = false;
      this.serverReadyError?.(error);
      this.rejectPending(error);
      if (this.child === child) this.child = undefined;
    });

    try {
      await this.withTimeout(readyPromise, this.startupTimeoutMs, "ZCode app-server handshake timed out");
      this.ready = true;
    } catch (error) {
      await this.disposeChild(child);
      throw error;
    } finally {
      this.serverReady = undefined;
      this.serverReadyError = undefined;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.outputBuffer = Buffer.concat([this.outputBuffer, chunk]);
    if (!this.handshakeDone) {
      const newline = this.outputBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.outputBuffer.subarray(0, newline).toString("utf8").trim();
      this.outputBuffer = this.outputBuffer.subarray(newline + 1);
      let hello: unknown;
      try {
        hello = JSON.parse(line);
      } catch {
        this.serverReadyError?.(new Error("Invalid ZCode app-server hello"));
        return;
      }
      if (!hello || typeof hello !== "object" || (hello as Record<string, unknown>).type !== "zcode-hello") {
        this.serverReadyError?.(new Error("Unexpected ZCode app-server hello"));
        return;
      }
      const child = this.child;
      if (!child) return;
      child.stdin.write(`${JSON.stringify({
        type: "zcode-hello-ack",
        version: "agent-herder",
        clientId: `agent-herder-${process.pid}`,
      })}\n`);
      this.handshakeDone = true;
    }
    this.consumeFrames();
  }

  private consumeFrames(): void {
    while (this.outputBuffer.byteLength >= PROTOCOL_HEADER_SIZE) {
      const type = this.outputBuffer.readUInt8(0);
      const length = this.outputBuffer.readUInt32BE(9);
      const frameLength = PROTOCOL_HEADER_SIZE + length;
      if (this.outputBuffer.byteLength < frameLength) return;
      const body = this.outputBuffer.subarray(PROTOCOL_HEADER_SIZE, frameLength);
      this.outputBuffer = this.outputBuffer.subarray(frameLength);
      if (type !== REGULAR_MESSAGE_TYPE) continue;
      try {
        const header = decodeZcodeValue(body, 0);
        const payload = decodeZcodeValue(body, header.offset);
        this.handleMessage(header.value, payload.value);
      } catch (error) {
        this.serverReadyError?.(error instanceof Error ? error : new Error(String(error)));
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleMessage(headerValue: unknown, payload: unknown): void {
    if (!Array.isArray(headerValue)) return;
    const type = headerValue[0];
    if (type === INITIALIZE_MESSAGE_TYPE) {
      this.serverReady?.();
      return;
    }
    if (type !== RESPONSE_MESSAGE_TYPE && type !== ERROR_MESSAGE_TYPE && type !== CANCELED_MESSAGE_TYPE) return;
    const requestId = headerValue[1];
    if (typeof requestId !== "number") return;
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    if (type === RESPONSE_MESSAGE_TYPE) {
      request.resolve(payload);
    } else {
      request.reject(errorFromPayload(payload, type === ERROR_MESSAGE_TYPE ? "ZCode RPC request failed" : "ZCode RPC request canceled"));
    }
  }

  async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
    await this.start();
    const child = this.child;
    if (!child || !this.ready) throw new Error("ZCode app-server is not ready");
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`ZCode RPC request timed out: ${channel}.${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        child.stdin.write(encodeZcodeRpcCall(requestId, channel, method, args));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.ready = false;
    this.handshakeDone = false;
    this.child = undefined;
    this.serverReadyError?.(new Error("ZCode app-server closed"));
    this.rejectPending(new Error("ZCode app-server closed"));
    if (child) await this.disposeChild(child);
  }

  private async disposeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  private rejectPending(error: Error): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
