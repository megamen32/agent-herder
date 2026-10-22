import { describe, expect, it } from "vitest";
import { splitProviderModel, terminalQuotaFailure } from "../src/adapters/quota-failure.js";

describe("terminal quota evidence", () => {
  const exact = {
    terminal: true,
    status: "error" as const,
    nativeTurnId: "turn-failed-1",
    inputId: "input-1",
    providerId: "omniroute",
    modelId: "minimax/MiniMax-M3.1-Flash",
    modelErrorType: "rate_limited",
    errorMessage: "Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-24 02:06:22",
  };

  it("requires exact terminal identities and explicit provider quota exhaustion", () => {
    expect(terminalQuotaFailure(exact)).toEqual({
      classification: "quota_exhausted",
      status: "error",
      nativeTurnId: "turn-failed-1",
      inputId: "input-1",
      providerId: "omniroute",
      modelId: "minimax/MiniMax-M3.1-Flash",
    });
    expect(terminalQuotaFailure({ ...exact, terminal: false })).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, status: "running" })).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, inputId: undefined })).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, providerId: undefined })).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, modelId: undefined })).toBeUndefined();
  });

  it.each([401, 403, 502])("does not classify HTTP %s as quota exhaustion", (statusCode) => {
    expect(terminalQuotaFailure({ ...exact, statusCode })).toBeUndefined();
  });
  it("accepts HTTP 429 only with explicit quota evidence", () => {
    expect(terminalQuotaFailure({ ...exact, statusCode: 429, errorCode: "quota_exhausted" })).toMatchObject({
      classification: "quota_exhausted",
      status: "error",
    });
    expect(terminalQuotaFailure({ ...exact, statusCode: 429, errorMessage: "Weekly limit exhausted" })).toMatchObject({
      classification: "quota_exhausted",
      status: "error",
    });
    expect(terminalQuotaFailure({ ...exact, statusCode: 429, errorCode: undefined, modelErrorType: undefined, errorMessage: "Too many requests" })).toBeUndefined();
  });
  it("does not mistake an HTTP status encoded in the provider code for quota evidence", () => {
    expect(terminalQuotaFailure({ ...exact, statusCode: undefined, errorCode: "HTTP_429", errorMessage: "Too many requests" })).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, statusCode: undefined, errorCode: "HTTP_429" })).toMatchObject({ classification: "quota_exhausted" });
  });

  it.each([
    { errorType: "authentication_error", errorMessage: "monthly quota exhausted" },
    { errorType: "network_error", errorMessage: "monthly quota exhausted" },
    { errorType: "unknown_error", errorMessage: "monthly quota exhausted" },
    { errorMessage: "Too many requests" },
    { errorMessage: "Context limit exceeded" },
  ])("rejects ambiguous, authentication, transport and generic limit errors", (failure) => {
    expect(terminalQuotaFailure({ ...exact, ...failure })).toBeUndefined();
  });

  it("uses only timezone-qualified reset timestamps", () => {
    expect(terminalQuotaFailure({ ...exact, resetAt: "2026-10-24 02:06:22" })?.resetAt).toBeUndefined();
    expect(terminalQuotaFailure({ ...exact, resetAt: "2026-10-24T02:06:22+03:00" })?.resetAt).toBe("2026-10-23T23:06:22.000Z");
  });

  it("splits a fully qualified model on its first slash", () => {
    expect(splitProviderModel("omniroute/minimax/MiniMax-M3.1-Flash$high")).toEqual({
      providerId: "omniroute",
      modelId: "minimax/MiniMax-M3.1-Flash$high",
    });
    expect(splitProviderModel("MiniMax-M3.1-Flash")).toBeUndefined();
  });
});

it("accepts the exact native GLM1310 quota payload inside a generic UNKNOWN_ERROR envelope",()=>{
 const native={terminal:true,status:"error",nativeTurnId:"exact-native-turn",inputId:"exact-input",providerId:"account:zai-individual-coding-plan",modelId:"GLM-5.3",errorType:"unknown_error",errorCode:"UNKNOWN_ERROR",modelErrorType:"rate_limited",errorMessage:"[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-24 02:06:22]"};
 expect(terminalQuotaFailure(native)).toMatchObject({classification:"quota_exhausted",nativeTurnId:"exact-native-turn"});
 expect(terminalQuotaFailure({...native,statusCode:502})).toBeUndefined();
 expect(terminalQuotaFailure({...native,errorMessage:"network failed; [1310] Weekly/Monthly Limit Exhausted"})).toBeUndefined();
 expect(terminalQuotaFailure({...native,providerId:"foreign",modelId:"other"})).toBeUndefined();
});
