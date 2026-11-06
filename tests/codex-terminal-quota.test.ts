import { expect, it } from "vitest";
import { codexTerminalQuotaEvidence } from "../src/adapters/codex-app-server.js";

it("keeps Codex terminal quota tied to a native completed turn and its input", () => {
  expect(codexTerminalQuotaEvidence({id:"turn-1",status:"failed",completedAt:1792699000,
    items:[{id:"user-1",type:"userMessage"}],error:{message:"Weekly quota exhausted",codexErrorInfo:"usageLimitExceeded"}},"gpt-6.1-sol"))
    .toMatchObject({classification:"quota_exhausted",nativeTurnId:"turn-1",inputId:"user-1",providerId:"codex",modelId:"gpt-6.1-sol"});
});
it.each([
  {id:"t",status:"failed",items:[{id:"u",type:"userMessage"}],error:{message:"HTTP 502 bad gateway"}},
  {id:"t",status:"inProgress",items:[{id:"u",type:"userMessage"}],error:{message:"quota exhausted"}},
  {id:"t",status:"failed",items:[],error:{message:"quota exhausted"}},
  {id:"t",status:"interrupted",items:[{id:"u",type:"userMessage"}],error:{message:"quota exhausted"}},
])("does not turn an ambiguous Codex state into quota recovery", turn => {
  expect(codexTerminalQuotaEvidence(turn,"gpt-6.1-sol")).toBeUndefined();
});

it("normalizes the exact Codex 429 retry-exhaustion envelope only for a failed native turn", () => {
  const turn = {
    id: "turn-429", status: "failed", completedAt: 1792699000,
    items: [{ id: "input-429", type: "userMessage" }],
    error: {
      message: "exceeded retry limit, last status: 429 Too Many Requests, request id: 8e065465-a4f2-4918-b94a-30d138157787",
      codexErrorInfo: { response_too_many_failed_attempts: { http_status_code: 429 } },
    },
  };
  expect(codexTerminalQuotaEvidence(turn, "gpt-6.1-terra")).toMatchObject({
    classification: "retry_limited", nativeTurnId: "turn-429", inputId: "input-429",
  });
  expect(codexTerminalQuotaEvidence({...turn, items: []}, "gpt-6.1-terra")).toBeUndefined();
  expect(codexTerminalQuotaEvidence({...turn, status: "inProgress"}, "gpt-6.1-terra")).toBeUndefined();
  expect(codexTerminalQuotaEvidence({...turn, error: {...turn.error,
    codexErrorInfo: { response_too_many_failed_attempts: {http_status_code: 502}}}}, "gpt-6.1-terra")).toBeUndefined();
});
