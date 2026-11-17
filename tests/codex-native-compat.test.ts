import {createHash} from "node:crypto";
import {expect, it} from "vitest";
import {normalizePortableResponsesBody, PORTABLE_SUMMARY_PREFIX} from "../src/codex-native-compat.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const encoded = Buffer.from("broker portable summary", "utf8").toString("base64");
const guards = {compactionId: "cmp_1", compactionSha256: sha("ocx1:" + encoded), decodedSha256: sha(Buffer.from("broker portable summary", "utf8"))};

it("normalizes only replay ids and the pinned ocx1 envelope", () => {
  const raw = new TextEncoder().encode(JSON.stringify({store: false, stream: true, model: "gpt-6.1-terra", input: [
    {type: "message", id: "msg_1", role: "user", content: [{type: "input_text", text: "marker"}]},
    {type: "compaction", id: "cmp_1", encrypted_content: "ocx1:" + encoded},
    {type: "function_call", id: "call_1", call_id: "call_1", encrypted_content: "native-opaque"},
  ]}));
  const result = normalizePortableResponsesBody(raw, guards, "gpt-6.1-terra");
  const body = JSON.parse(new TextDecoder().decode(result.body));
  expect(body.input[0].id).toBeUndefined();
  expect(body.input[2].id).toBeUndefined();
  expect(body.input[2].encrypted_content).toBe("native-opaque");
  expect(body.input[2].call_id).toBe("call_1");
  expect(body.input[1].content[0].text).toBe(PORTABLE_SUMMARY_PREFIX + String.fromCharCode(10, 10) + "broker portable summary");
  expect(result.proof.losslessPortableDecode).toBe(true);
});

it("refuses unknown portable envelopes and stateful requests", () => {
  const body = JSON.stringify({store: false, stream: true, model: "gpt-6.1-terra", previous_response_id: "resp_1", input: []});
  expect(() => normalizePortableResponsesBody(new TextEncoder().encode(body), guards, "gpt-6.1-terra")).toThrow("stateful_or_partial_input_refused");
  const unknown = JSON.stringify({store: false, stream: true, model: "gpt-6.1-terra", input: [{type: "compaction", id: "cmp_1", encrypted_content: "native-ciphertext"}, {id: "x", type: "message"}]});
  expect(() => normalizePortableResponsesBody(new TextEncoder().encode(unknown), guards, "gpt-6.1-terra")).toThrow("portable_envelope_hash_mismatch");
});

it("preserves mixed native history when the old portable item is absent", () => {
  const raw = new TextEncoder().encode(JSON.stringify({store: false, stream: true, model: "gpt-6.1-terra", input: [
    {type: "message", id: "msg_1", role: "user", content: [{type: "input_text", text: "marker"}]},
    {type: "compaction", id: "native_cmp", encrypted_content: "native-opaque"},
    {type: "function_call", id: "call_item", call_id: "call_native", encrypted_content: "native-opaque-2"},
  ]}));
  const result = normalizePortableResponsesBody(raw, guards, "gpt-6.1-terra");
  const body = JSON.parse(new TextDecoder().decode(result.body));
  expect(body.input[1]).toEqual({type: "compaction", id: undefined, encrypted_content: "native-opaque"});
  expect(body.input[2]).toEqual({type: "function_call", id: undefined, call_id: "call_native", encrypted_content: "native-opaque-2"});
  expect(result.proof.losslessPortableDecode).toBe(false);
});

it('uses the frozen prefix bytes and preserves item references', () => {
  expect(sha(PORTABLE_SUMMARY_PREFIX)).toBe('e9b088e794a6bb9082ac053fcc760bd818d7e720ee4bcdc72c6e480de7b7cb0e');
  const raw = new TextEncoder().encode(JSON.stringify({store:false,stream:true,model:'gpt-6.1-terra',input:[
    {type:'item_reference',id:'ref_1'},
    {type:'message',role:'user',content:[{type:'input_text',text:'new'}]}
  ]}));
  const body = JSON.parse(new TextDecoder().decode(normalizePortableResponsesBody(raw, guards, 'gpt-6.1-terra').body));
  expect(body.input[0].id).toBe('ref_1');
});

it('refuses unreviewed fields on the pinned portable item', () => {
  const raw = new TextEncoder().encode(JSON.stringify({store:false,stream:true,model:'gpt-6.1-terra',input:[
    {type:'compaction',id:'cmp_1',encrypted_content:'ocx1:'+encoded,extra:'must-refuse'}
  ]}));
  expect(() => normalizePortableResponsesBody(raw, guards, 'gpt-6.1-terra')).toThrow('portable_item_has_unreviewed_fields');
});
