import type { RawTranscriptExport } from "./types/index.js";
import type { NativeTranscriptPageReader, TranscriptSessionScope } from "./integrator-transcript.js";
import { createChatgptTranscriptReader } from "./chatgpt-transcript-reader.js";

/** Adapt a checked Z.ai native export to the shared frozen JSON pager. */
export function createZaiTranscriptReader(input: { scope: TranscriptSessionScope; getRawTranscript: (id: string) => Promise<RawTranscriptExport | null> }): NativeTranscriptPageReader {
  let nativeId = input.scope.nativeSessionId;
  try { if (nativeId.startsWith("zai::")) nativeId = decodeURIComponent(nativeId.slice(5)); } catch { nativeId = ""; }
  if (nativeId.startsWith("route:")) nativeId = nativeId.slice(6);
  const innerScope = { ...input.scope, harness: "chatgpt", nativeSessionId: nativeId };
  const inner = createChatgptTranscriptReader({ scope: innerScope, getRawTranscript: async () => {
    const raw = await input.getRawTranscript(input.scope.nativeSessionId);
    if (!raw || !raw.complete || raw.source?.kind !== "native-api" || raw.source.format !== "json" || raw.bytes.byteLength > 16 * 1024 * 1024) return null;
    let data: any;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes)); } catch { return null; }
    if (!nativeId || data?.conversation_id !== nativeId || !data.messages || typeof data.messages !== "object" || Array.isArray(data.messages)) return null;
    const mapping: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data.messages)) {
      const message = value as any;
      if (!message || message.id !== key || typeof message.role !== "string") return null;
      const blocks = Array.isArray(message.content_blocks) ? message.content_blocks : [];
      const text = typeof message.content === "string" ? message.content : blocks.filter((block: any) => (block?.type === "text" || block?.type === "markdown") && typeof block.content === "string").map((block: any) => block.content).join("\n");
      mapping[key] = { message: { id: key, author: { role: message.role }, content: { parts: [text] } }, native: message };
    }
    return { ...raw, bytes: Buffer.from(JSON.stringify({ conversation_id: nativeId, mapping })) };
  } });
  return async ({ scope, cursor, limit }) => {
    if (scope.hostId !== input.scope.hostId || scope.harness !== "zai" || scope.nativeSessionId !== input.scope.nativeSessionId) throw new Error("Native Z.ai transcript rejected: scope mismatch");
    const page = await inner({ scope: innerScope, cursor, limit });
    return { ...page, scope };
  };
}
