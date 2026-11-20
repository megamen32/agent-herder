import { describe, expect, it } from "vitest";
import { localProviderId, isCredentialFreeLocalChild, parseCodexProviderRoutes, subscriptionIndependentProviderId } from "../src/adapters/codex-owned-provider.js";

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

describe("subscription independent provider route", () => {
  const configText = (body: string) => parseCodexProviderRoutes(body);
  const route = (base_url: string, id = "opencodex") => configText(`
model_provider = "${id}"

[model_providers.${id}]
base_url = "${base_url}"
`);
  it("recognizes a configured third-party route that the Codex subscription does not bill", () => {
    expect(subscriptionIndependentProviderId(route("http://192.168.2.75:10100/v1"), "opencodex")).toBe("opencodex");
    expect(subscriptionIndependentProviderId(route("https://hub.example.com/v1"), "opencodex")).toBe("opencodex");
  });
  it("honours the provider the thread pinned instead of the configured default", () => {
    expect(subscriptionIndependentProviderId(route("http://192.168.2.75:10100/v1"), "opencodex")).toBe("opencodex");
    expect(subscriptionIndependentProviderId(route("http://192.168.2.75:10100/v1"), "openai")).toBeUndefined();
    expect(subscriptionIndependentProviderId(route("http://192.168.2.75:10100/v1"), "")).toBeUndefined();
  });
  it("reads the declared endpoint of every configured provider", () => {
    const routes = configText(`
model_provider = "opencodex"

[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://192.168.2.75:10100/v1"
wire_api = "responses"

[model_providers.other]
base_url = "https://api.openai.com/v1"
`);
    expect(routes.defaultProviderId).toBe("opencodex");
    expect(routes.baseUrls.opencodex).toBe("http://192.168.2.75:10100/v1");
    expect(routes.baseUrls.other).toBe("https://api.openai.com/v1");
  });
  it.each([
    ["builtin subscription provider", route("http://192.168.2.75:10100/v1", "openai")],
    ["azure", route("http://192.168.2.75:10100/v1", "azure")],
    ["official api host", route("https://api.openai.com/v1")],
    ["official chatgpt host", route("https://chatgpt.com/backend-api/codex")],
    ["official subdomain", route("https://foo.openai.com/v1")],
    ["official chatgpt subdomain", route("https://foo.chatgpt.com/v1")],
    ["unparsable base url", route("not-a-url")],
    ["non http scheme", route("ftp://192.168.2.75:10100/v1")],
    ["credentials in url", route("http://user:password@192.168.2.75:10100/v1")],
    ["undeclared provider", configText('model_provider = "opencodex"')],
    ["no configuration at all", configText("")],
  ])("keeps the subscription guard for %s", (_name, routes) => {
    expect(subscriptionIndependentProviderId(routes, "opencodex")).toBeUndefined();
  });
});
