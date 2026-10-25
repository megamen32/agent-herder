import { expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { COMPOSER_TRANSCRIPTION_MAX_BYTES, readComposerAudioUpload, type ComposerAudioUpload } from "../src/web/composer-transcription.js";
import { transcribeWithWhisper } from "../src/web/whisper-consumer.js";

async function listen(server: ReturnType<typeof createWebServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function close(server: ReturnType<typeof createWebServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function audioForm(type = "audio/webm;codecs=opus", bytes = new Uint8Array([1, 2, 3])): FormData {
  const form = new FormData();
  form.set("audio", new Blob([bytes], { type }), "voice.webm");
  return form;
}

async function asIncomingMessage(request: Request): Promise<import("node:http").IncomingMessage> {
  const body = Buffer.from(await request.arrayBuffer());
  return {
    headers: Object.fromEntries(request.headers.entries()),
    resume() {},
    async *[Symbol.asyncIterator]() { yield body; },
  } as unknown as import("node:http").IncomingMessage;
}

it("posts one same-origin protected audio upload and returns transcript text without sending a message", async () => {
  const transcriber = vi.fn(async (upload: ComposerAudioUpload) => ({ text: `recognized ${upload.mimeType}` }));
  const sendMessage = vi.fn();
  const authGate = vi.fn(async (request, response) => {
    if (request.headers.cookie !== "owner-session=valid") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Войдите в кабинет владельца флота" }));
      return true;
    }
    return false;
  });
  const server = createWebServer({
    adapters: new Map(), converter: {} as never,
    supervisor: { sendMessage } as never,
    fleetHttpGuard: authGate,
    composerTranscriber: transcriber,
  });
  const origin = await listen(server);
  try {
    const denied = await fetch(`${origin}/api/composer/transcription`, { method: "POST", body: audioForm() });
    expect(denied.status).toBe(401);
    expect(transcriber).not.toHaveBeenCalled();

    const response = await fetch(`${origin}/api/composer/transcription`, {
      method: "POST", headers: { cookie: "owner-session=valid" }, body: audioForm(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: "recognized audio/webm" });
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(transcriber.mock.calls[0]![0]).toMatchObject({ mimeType: "audio/webm", fileName: "recording.webm", bytes: Buffer.from([1, 2, 3]) });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(authGate).toHaveBeenCalledTimes(2);
  } finally { await close(server); }
});

it("rejects unsupported audio and oversized requests before invoking Whisper", async () => {
  const unsupported = createWebServer({ adapters: new Map(), converter: {} as never, supervisor: {} as never });
  const origin = await listen(unsupported);
  try {
    const response = await fetch(`${origin}/api/composer/transcription`, { method: "POST", body: audioForm("audio/ogg") });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("WebM/Opus") });
  } finally { await close(unsupported); }

  const resume = vi.fn();
  const oversized = {
    headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(COMPOSER_TRANSCRIPTION_MAX_BYTES + 65_537) },
    resume,
  } as never;
  await expect(readComposerAudioUpload(oversized)).rejects.toMatchObject({ status: 413 });
  expect(resume).toHaveBeenCalledTimes(1);
});

it("propagates browser cancellation to the single active transcription and never retries", async () => {
  let started!: () => void;
  let cancelled!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const cancelledPromise = new Promise<void>((resolve) => { cancelled = resolve; });
  const transcriber = vi.fn(async (_upload: ComposerAudioUpload, signal: AbortSignal) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) { cancelled(); reject(new Error("cancelled")); return; }
      signal.addEventListener("abort", () => { cancelled(); reject(new Error("cancelled")); }, { once: true });
    });
    return { text: "unreachable" };
  });
  const server = createWebServer({ adapters: new Map(), converter: {} as never, supervisor: {} as never, composerTranscriber: transcriber });
  const origin = await listen(server);
  const controller = new AbortController();
  try {
    const request = fetch(`${origin}/api/composer/transcription`, { method: "POST", body: audioForm(), signal: controller.signal }).catch(() => undefined);
    await startedPromise;
    controller.abort();
    await cancelledPromise;
    await request;
    expect(transcriber).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); await close(server); }
});

it("accepts MP4 and WAV MIME types, and rejects empty or extra multipart fields", async () => {
  for (const mime of ["audio/mp4", "audio/wav"]) {
    const request = new Request("http://local", { method: "POST", body: audioForm(mime) });
    const upload = await readComposerAudioUpload(await asIncomingMessage(request));
    expect(upload.mimeType).toBe(mime);
  }
  const empty = audioForm("audio/mp4", new Uint8Array());
  const emptyRequest = new Request("http://local", { method: "POST", body: empty });
  await expect(readComposerAudioUpload(await asIncomingMessage(emptyRequest))).rejects.toMatchObject({ status: 400 });

  const extra = audioForm(); extra.set("other", "unexpected");
  const extraRequest = new Request("http://local", { method: "POST", body: extra });
  await expect(readComposerAudioUpload(await asIncomingMessage(extraRequest))).rejects.toMatchObject({ status: 400 });
});

it("uses only the fixed Whisper URL/model, keeps auth out of the URL, and exposes no upstream error body", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requestUrl = String(input); requestInit = init;
    return new Response(JSON.stringify({ text: "привет" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await transcribeWithWhisper({ token: "synthetic-test-token", audio: new Uint8Array([1, 2, 3]), mimeType: "audio/webm", fileName: "recording.webm", fetchImpl });
  expect(result).toEqual({ text: "привет" });
  expect(requestUrl).toBe("https://whisper.bezrabotnyi.com/v1/audio/transcriptions");
  expect(requestInit?.redirect).toBe("error");
  expect(requestInit?.headers).toEqual({ authorization: "Bearer synthetic-test-token", accept: "application/json" });
  const form = requestInit?.body as FormData;
  expect(form.get("model")).toBe("whisper-1");
  expect(form.get("response_format")).toBe("json");
  const file = form.get("file") as File;
  expect(file.name).toBe("recording.webm");
  expect(file.type).toBe("audio/webm");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));

  const refused = await transcribeWithWhisper({
    token: "synthetic-test-token", audio: new Uint8Array([1]), mimeType: "audio/mp4", fileName: "recording.m4a",
    fetchImpl: (async () => new Response("private upstream diagnostic", { status: 401 })) as typeof fetch,
  });
  expect(refused).toEqual({ status: 401, code: "upstream_rejected" });
  expect(JSON.stringify(refused)).not.toContain("private upstream diagnostic");

  const timedOut = await transcribeWithWhisper({
    token: "synthetic-test-token", audio: new Uint8Array([1]), mimeType: "audio/wav", fileName: "recording.wav",
    fetchImpl: (async () => { throw new DOMException("synthetic timeout", "TimeoutError"); }) as typeof fetch,
  });
  expect(timedOut).toEqual({ code: "upstream_timeout" });
});
