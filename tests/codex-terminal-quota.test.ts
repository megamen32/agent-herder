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
