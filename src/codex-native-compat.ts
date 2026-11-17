import {createHash} from "node:crypto";

export const PORTABLE_SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools and the summary produced by the other language model. Use this to build on the work that was already done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist you in answering the query:";

export interface PortableCompactionGuards {
  compactionId: string;
  compactionSha256: string;
  decodedSha256: string;
}

export interface PortableNormalizationProof {
  removedIdCount: number;
  inputCount: number;
  onlyReplayIdsAndExactOcx1DecodingChanged: true;
  losslessPortableDecode: true;
  nativeEncryptedContentUnchanged: true;
  callIdsUnchanged: true;
  decodedSha256: string;
}

const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function normalizePortableResponsesBody(raw: Uint8Array, guards: PortableCompactionGuards, expectedModel: string): { body: Uint8Array; proof: PortableNormalizationProof } {
  let body: any;
  try { body = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)); } catch { throw new Error("invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.store !== false || body.stream !== true || body.model !== expectedModel) throw new Error("unexpected_request_shape");
  if (body.previous_response_id != null || !Array.isArray(body.input) || body.input.length === 0) throw new Error("stateful_or_partial_input_refused");
  const items = body.input;
  const matches = items.filter((item: any) => item?.type === "compaction" && item?.id === guards.compactionId && typeof item.encrypted_content === "string");
  if (matches.length !== 1) throw new Error("original_compaction_missing");
  const portable = matches[0];
  if (digest(portable.encrypted_content) !== guards.compactionSha256 || !portable.encrypted_content.startsWith("ocx1:")) throw new Error("portable_envelope_hash_mismatch");
  const encoded = portable.encrypted_content.slice(5);
  let decoded: Uint8Array;
  try { decoded = Buffer.from(encoded, "base64"); if (Buffer.from(decoded).toString("base64") !== encoded) throw new Error("roundtrip"); new TextDecoder("utf-8", {fatal: true}).decode(decoded); } catch { throw new Error("portable_encoding_invalid"); }
  if (digest(decoded) !== guards.decodedSha256) throw new Error("portable_decoded_hash_mismatch");
  if (items.some((item: any) => item !== portable && ["compaction", "compaction_summary", "context_compaction"].includes(item?.type))) throw new Error("additional_unknown_compaction_refused");
  const nativeEncrypted = items.filter((item: any) => item !== portable && typeof item?.encrypted_content === "string").map((item: any) => item.encrypted_content);
  const callIds = items.map((item: any) => item?.call_id ?? null);
  const after = clone(body);
  let removed = 0;
  for (const item of after.input) if (Object.prototype.hasOwnProperty.call(item, "id")) { delete item.id; removed++; }
  if (!removed) throw new Error("no_replay_ids_to_normalize");
  const summary = new TextDecoder("utf-8", {fatal: true}).decode(decoded);
  after.input[items.indexOf(portable)] = {type: "message", role: "user", content: [{type: "input_text", text: PORTABLE_SUMMARY_PREFIX + "\\n\\n" + summary}]};
  if (after.input.filter((item: any) => typeof item?.encrypted_content === "string").map((item: any) => item.encrypted_content).some((value: string) => nativeEncrypted.includes(value) === false)) throw new Error("native_encrypted_content_changed");
  if (after.input.map((item: any) => item?.call_id ?? null).join("\\0") !== callIds.join("\\0")) throw new Error("call_ids_changed");
  const output = new TextEncoder().encode(JSON.stringify(after));
  return {body: output, proof: {removedIdCount: removed, inputCount: items.length, onlyReplayIdsAndExactOcx1DecodingChanged: true, losslessPortableDecode: true, nativeEncryptedContentUnchanged: true, callIdsUnchanged: true, decodedSha256: guards.decodedSha256}};
}
