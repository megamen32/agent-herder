import {createHash} from "node:crypto";

export const PORTABLE_SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const PORTABLE_SUMMARY_PREFIX_SHA256 = createHash("sha256").update(PORTABLE_SUMMARY_PREFIX).digest("hex");
export interface PortableCompactionGuards { compactionId: string; compactionSha256: string; decodedSha256: string; }
export interface PortableNormalizationProof { removedIdCount:number; inputCount:number; onlyReplayIdsAndExactOcx1DecodingChanged:true; losslessPortableDecode:boolean; nativeEncryptedContentUnchanged:true; callIdsUnchanged:true; decodedSha256:string; }
const digest=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const comparable=(item:any)=>{ const x=clone(item); if (x?.type !== "item_reference") delete x?.id; return x; };
const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);

export function normalizePortableResponsesBody(raw:Uint8Array, guards:PortableCompactionGuards, expectedModel:string):{body:Uint8Array;proof:PortableNormalizationProof} {
  let body:any; try { body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)); } catch { throw new Error("invalid_json"); }
  if (!body || typeof body!=="object" || Array.isArray(body) || body.store!==false || body.stream!==true || body.model!==expectedModel) throw new Error("unexpected_request_shape");
  if (body.previous_response_id!=null || !Array.isArray(body.input) || !body.input.length) throw new Error("stateful_or_partial_input_refused");
  const items=body.input; const matches=items.filter((x:any)=>x?.type==="compaction"&&x?.id===guards.compactionId&&typeof x.encrypted_content==="string");
  const unknown=items.some((x:any)=>typeof x?.encrypted_content==="string"&&x.encrypted_content.startsWith("ocx")&&!(x===matches[0]&&x.encrypted_content.startsWith("ocx1:")));
  if (unknown) throw new Error("unknown_portable_envelope_refused"); if (matches.length>1) throw new Error("duplicate_original_compaction");
  const portable=matches[0] as any|undefined;
  if (portable && (digest(portable.encrypted_content)!==guards.compactionSha256 || !portable.encrypted_content.startsWith("ocx1:"))) throw new Error("portable_envelope_hash_mismatch");
  let summary:string|undefined;
  if (portable) { const encoded=portable.encrypted_content.slice(5); let decoded:Uint8Array; try { decoded=Buffer.from(encoded,"base64"); if (Buffer.from(decoded).toString("base64")!==encoded) throw new Error(); summary=new TextDecoder("utf-8",{fatal:true}).decode(decoded); } catch { throw new Error("portable_encoding_invalid"); } if (digest(new TextEncoder().encode(summary))!==guards.decodedSha256) throw new Error("portable_decoded_hash_mismatch"); if (Object.keys(portable).sort().join(",")!=="encrypted_content,id,type") throw new Error("portable_item_has_unreviewed_fields"); }
  const after=clone(body); let removed=0;
  for (const item of after.input) if (item?.type!=="item_reference"&&Object.prototype.hasOwnProperty.call(item,"id")) { delete item.id; removed++; }
  if (portable&&summary!==undefined) after.input[items.indexOf(portable)]={type:"message",role:"user",content:[{type:"input_text",text:PORTABLE_SUMMARY_PREFIX+String.fromCharCode(10,10)+summary}]};
  for (let i=0;i<items.length;i++) if (!portable || i!==items.indexOf(portable)) if (!same(comparable(items[i]),comparable(after.input[i]))) throw new Error("non_transport_history_change");
  const callBefore=items.map((x:any)=>x?.call_id??null), callAfter=after.input.map((x:any)=>x?.call_id??null); if (!same(callBefore,callAfter)) throw new Error("call_ids_changed");
  return {body:new TextEncoder().encode(JSON.stringify(after)),proof:{removedIdCount:removed,inputCount:items.length,onlyReplayIdsAndExactOcx1DecodingChanged:true,losslessPortableDecode:Boolean(portable),nativeEncryptedContentUnchanged:true,callIdsUnchanged:true,decodedSha256:guards.decodedSha256}};
}
