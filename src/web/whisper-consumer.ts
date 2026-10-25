import { readFile } from "node:fs/promises";

const WHISPER_ENDPOINT = "https://whisper.bezrabotnyi.com/v1/audio/transcriptions";
const MODEL = "whisper-1";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 300_000;
const MAX_SECRET_BYTES = 64 * 1024;

export interface WhisperConsumerResult {
  text?: string;
  status?: number;
  code?: string;
}

export async function transcribeWithWhisper(input: {
  token: string;
  audio: Uint8Array;
  mimeType: string;
  fileName: string;
  fetchImpl?: typeof fetch;
}): Promise<WhisperConsumerResult> {
  if (!input.token || /[\r\n\0]/u.test(input.token) || input.audio.byteLength === 0 || input.audio.byteLength > MAX_AUDIO_BYTES) {
    return { code: "invalid_input" };
  }
  const form = new FormData();
  form.set("model", MODEL);
  form.set("response_format", "json");
  form.set("file", new Blob([Uint8Array.from(input.audio)], { type: input.mimeType }), input.fileName);
  try {
    const response = await (input.fetchImpl ?? fetch)(WHISPER_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, accept: "application/json" },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return { status: response.status, code: "upstream_rejected" };
    let value: unknown;
    try { value = await response.json(); }
    catch { return { status: response.status, code: "invalid_response" }; }
    if (!value || typeof value !== "object" || typeof (value as { text?: unknown }).text !== "string") {
      return { status: response.status, code: "invalid_response" };
    }
    const text = (value as { text: string }).text.trim();
    return text ? { text } : { status: response.status, code: "empty_transcript" };
  } catch (error) {
    return { code: error instanceof Error && error.name === "TimeoutError" ? "upstream_timeout" : "upstream_unavailable" };
  }
}

async function readSecretStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_SECRET_BYTES) throw new Error("invalid secret size");
    chunks.push(part);
  }
  return Buffer.concat(chunks, size).toString("utf8").trim();
}

async function main(): Promise<void> {
  const [filePath, mimeType, ...extra] = process.argv.slice(2);
  if (!filePath || !mimeType || extra.length > 0 || !["audio/webm", "audio/mp4", "audio/wav"].includes(mimeType)) {
    process.stdout.write(JSON.stringify({ code: "invalid_input" }));
    return;
  }
  try {
    const [token, audio] = await Promise.all([readSecretStdin(), readFile(filePath)]);
    if (!token || audio.byteLength === 0 || audio.byteLength > MAX_AUDIO_BYTES) {
      process.stdout.write(JSON.stringify({ code: "invalid_input" }));
      return;
    }
    const extension = mimeType === "audio/webm" ? "webm" : mimeType === "audio/mp4" ? "m4a" : "wav";
    const result = await transcribeWithWhisper({ token, audio, mimeType, fileName: `recording.${extension}` });
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify({ code: "consumer_failed" }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("whisper-consumer.js")) await main();
