import { expect, it } from "vitest";
import { normalizeSendAdmission } from "../src/adapters/quota-failure.js";

it("advances only a definite unsubmitted explicit quota refusal", () => {
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,nonRetryable:true,error:"Weekly quota exhausted"})).toMatchObject({admission:"not_submitted",quotaFailure:{classification:"quota_exhausted"}});
  expect(normalizeSendAdmission({ok:false,error:"HTTP 429 Weekly quota exhausted"})).toMatchObject({admission:"unknown"});
  expect(normalizeSendAdmission({ok:false,error:"HTTP 429 Weekly quota exhausted"}).quotaFailure).toBeUndefined();
});
it("native admission and uncertain receipt dominate contradictory refusal", () => {
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,admitted:true,error:"quota exhausted"})).toMatchObject({admission:"accepted",notSubmitted:false});
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,nativeInputMessageId:"msg_native",error:"quota exhausted"})).toMatchObject({admission:"accepted",notSubmitted:false});
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,admissionUnknown:true,error:"quota exhausted"})).toMatchObject({admission:"unknown",notSubmitted:false});
  expect(normalizeSendAdmission({ok:true,pending:true,notSubmitted:true})).toMatchObject({admission:"pending",notSubmitted:false});
});
it("auth and generic rate limits never become quota refusals", () => {
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,error:"HTTP 502 quota exhausted"}).quotaFailure).toBeUndefined();
  expect(normalizeSendAdmission({ok:false,notSubmitted:true,error:"Too many requests"}).quotaFailure).toBeUndefined();
});
