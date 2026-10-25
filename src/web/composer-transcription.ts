import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";

export const COMPOSER_TRANSCRIPTION_PATH = "/api/composer/transcription";
export const COMPOSER_TRANSCRIPTION_MAX_BYTES = 25 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const SECRET_NAME = "whisper.bezrabotnyi.com";
const SSS_RUN = "/home/roomhacker/.local/bin/sss-run";
const OUTER_TIMEOUT_MS = 305_000;
const CONSUMER_PATH = fileURLToPath(new URL("./whisper-consumer.js", import.meta.url));

export type ComposerAudioMime = "audio/webm" | "audio/mp4" | "audio/wav";

export interface ComposerAudioUpload {
  bytes: Buffer;
  mimeType: ComposerAudioMime;
  fileName: string;
}

export class ComposerTranscriptionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ComposerTranscriptionError";
  }
}

export async function readComposerAudioUpload(request: IncomingMessage): Promise<ComposerAudioUpload> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^multipart\/form-data\s*;/iu.test(contentType)) {
    throw new ComposerTranscriptionError(415, "Отправьте аудиозапись через поле audio.");
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  const maxRequestBytes = COMPOSER_TRANSCRIPTION_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;
  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    request.resume();
    throw new ComposerTranscriptionError(413, "Аудиозапись превышает лимит 25 МиБ.");
  }

  const bytes = await readBoundedBody(request, maxRequestBytes);
  let form: FormData;
  try {
    const parsed = new Request("http://agent-herder.invalid", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes as unknown as BodyInit,
    });
    form = await parsed.formData();
  } catch {
    throw new ComposerTranscriptionError(400, "Не удалось прочитать аудиозапись.");
  }
  const keys = [...form.keys()];
  const entries = form.getAll("audio");
  if (keys.length !== 1 || keys[0] !== "audio" || entries.length !== 1 || !(entries[0] instanceof Blob)) {
    throw new ComposerTranscriptionError(400, "Нужно передать один аудиофайл в поле audio.");
  }
  const file = entries[0] as File;
  if (file.size === 0) throw new ComposerTranscriptionError(400, "Аудиозапись пуста.");
  if (file.size > COMPOSER_TRANSCRIPTION_MAX_BYTES) throw new ComposerTranscriptionError(413, "Аудиозапись превышает лимит 25 МиБ.");

  const mimeType = normalizeAudioMime(file.type);
  if (!mimeType) throw new ComposerTranscriptionError(415, "Поддерживаются записи WebM/Opus, MP4/AAC и WAV.");
  const extension = mimeType === "audio/webm" ? "webm" : mimeType === "audio/mp4" ? "m4a" : "wav";
  return { bytes: Buffer.from(await file.arrayBuffer()), mimeType, fileName: `recording.${extension}` };
}

function normalizeAudioMime(raw: string): ComposerAudioMime | undefined {
  const [essence, ...parameters] = raw.toLowerCase().split(";").map((part) => part.trim());
  if (essence === "audio/webm") {
    const codecs = parameters.find((part) => part.startsWith("codecs="));
    if (codecs && !/^codecs=["']?opus["']?$/u.test(codecs)) return undefined;
    return "audio/webm";
  }
  if (essence === "audio/mp4") return "audio/mp4";
  if (essence === "audio/wav" || essence === "audio/x-wav") return "audio/wav";
  return undefined;
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > limit) {
      request.resume();
      throw new ComposerTranscriptionError(413, "Запрос превышает допустимый размер.");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, total);
}

export interface ComposerTranscriptionResult {
  text: string;
}

export type ComposerTranscriber = (upload: ComposerAudioUpload, signal: AbortSignal) => Promise<ComposerTranscriptionResult>;

export const transcribeComposerAudio: ComposerTranscriber = async (upload, signal) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-herder-transcription-"));
  let child: ChildProcess | undefined;
  let abortChild: (() => void) | undefined;
  const filePath = join(directory, upload.fileName);
  try {
    if (signal.aborted) throw new ComposerTranscriptionError(499, "Распознавание отменено.");
    await writeFile(filePath, upload.bytes, { mode: 0o600, flag: "wx" });
    const output = await new Promise<string>((resolve, reject) => {
      child = nodeSpawn(SSS_RUN, [SECRET_NAME, "--", process.execPath, CONSUMER_PATH, filePath, upload.mimeType], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      });
      let stdout = "";
      let settled = false;
      let timeout: NodeJS.Timeout;
      const onAbort = () => finish(new ComposerTranscriptionError(499, "Распознавание отменено."));
      const cleanupListeners = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (error) {
          void terminateChild(child).finally(() => reject(error));
        } else resolve(stdout);
      };
      timeout = setTimeout(() => finish(new ComposerTranscriptionError(504, "Распознавание не завершилось за отведённое время.")), OUTER_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      abortChild = onAbort;
      child.once("error", () => finish(new ComposerTranscriptionError(503, "Сервис распознавания сейчас недоступен.")));
      child.once("close", (code) => {
        if (code !== 0) return finish(new ComposerTranscriptionError(502, "Сервис распознавания не смог обработать запись."));
        finish();
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > 512 * 1024) finish(new ComposerTranscriptionError(502, "Сервис вернул слишком большой ответ."));
      });
      if (signal.aborted) onAbort();
    });
    let result: unknown;
    try { result = JSON.parse(output); }
    catch { throw new ComposerTranscriptionError(502, "Сервис распознавания вернул некорректный ответ."); }
    if (!result || typeof result !== "object" || typeof (result as { text?: unknown }).text !== "string") {
      const code = (result as { code?: unknown } | null)?.code;
      const status = (result as { status?: unknown } | null)?.status;
      if (code === "upstream_timeout") throw new ComposerTranscriptionError(504, "Сервис распознавания не ответил вовремя.");
      if (code === "empty_transcript") throw new ComposerTranscriptionError(422, "В записи не удалось распознать речь.");
      if (code === "upstream_unavailable" || code === "consumer_failed") throw new ComposerTranscriptionError(503, "Сервис распознавания сейчас недоступен.");
      if (status === 429 || (typeof status === "number" && status >= 500)) throw new ComposerTranscriptionError(503, "Сервис распознавания временно занят.");
      throw new ComposerTranscriptionError(502, "Сервис распознавания не смог обработать запись.");
    }
    const text = (result as { text: string }).text.trim();
    if (!text) throw new ComposerTranscriptionError(422, "В записи не удалось распознать речь.");
    if (text.length > 500_000) throw new ComposerTranscriptionError(502, "Сервис вернул слишком большой текст.");
    return { text };
  } catch (error) {
    if (signal.aborted) throw new ComposerTranscriptionError(499, "Распознавание отменено.");
    if (error instanceof ComposerTranscriptionError) throw error;
    throw new ComposerTranscriptionError(503, "Сервис распознавания сейчас недоступен.");
  } finally {
    if (abortChild) signal.removeEventListener("abort", abortChild);
    await rm(directory, { recursive: true, force: true });
  }
};

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceKill) clearTimeout(forceKill);
      clearTimeout(lastResort);
      child.removeListener("close", finish);
      resolve();
    };
    const lastResort = setTimeout(finish, 2500);
    child.once("close", finish);
    try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    forceKill = setTimeout(() => {
      try { process.kill(-child!.pid!, "SIGKILL"); } catch { child!.kill("SIGKILL"); }
    }, 1000);
  });
}
