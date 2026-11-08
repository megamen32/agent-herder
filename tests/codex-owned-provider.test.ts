import { describe, expect, it } from "vitest";
import { localProviderId, isCredentialFreeLocalChild } from "../src/adapters/codex-owned-provider.js";

const config = (provider: Record<string, unknown> = {}, id = "fixture") => ({config: {
  model_provider: id, model_providers: {[id]: {base_url: "http://127.0.0.1:1234/v1", requires_openai_auth: false, ...provider}},
}});

describe("owned local provider quota boundary", () => {
  it("recognizes an explicit credential-free loopback route", () => {
    expect(localProviderId(config())).toBe("fixture");
    expect(localProviderId(config({base_url: "http://[::1]:1234/v1"}))).toBe("fixture");
  });
  it.each([
    {requires_openai_auth: true}, {requires_openai_auth: undefined},
    {base_url: "https://api.openai.com/v1"}, {base_url: "http://localhost.evil/v1"},
    {base_url: "http://user:password@127.0.0.1/v1"}, {env_key: "MY_KEY"},
    {experimental_bearer_token: "present"}, {http_headers: {Authorization: "present"}},
    {env_http_headers: {Authorization: "MY_KEY"}},
    {auth: {type: "oauth"}}, {gateway_oauth: {}}, {aws: {}}, {credential_file: "/protected/key"},
  ])("keeps the subscription guard for unverified route %j", provider => {
    expect(localProviderId(config(provider))).toBeUndefined();
  });
  it("does not exempt the builtin provider or incomplete effective config", () => {
    expect(localProviderId(config({}, "openai"))).toBeUndefined();
    expect(localProviderId({})).toBeUndefined();
  });
  it("does not accept a socket or missing owned child", async () => {
    expect(await isCredentialFreeLocalChild(undefined, process.execPath, "/tmp/no-proof")).toBe(false);
  });
});
