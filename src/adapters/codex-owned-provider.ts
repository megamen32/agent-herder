import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only an explicit unauthenticated loopback provider can use this exception. */
export function localProviderId(response: unknown): string | undefined {
  const config = record(record(response).config);
  const id = config.model_provider;
  if (typeof id !== "string" || !id || id === "openai" || id === "azure") return;
  const provider = record(record(config.model_providers)[id]);
  if (provider.requires_openai_auth !== false || provider.env_key || provider.experimental_bearer_token
      || provider.auth || provider.gateway_oauth || provider.aws || provider.credential_file
      || Object.keys(record(provider.http_headers)).length || Object.keys(record(provider.env_http_headers)).length) return;
  try {
    const url = new URL(String(provider.base_url));
    if (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)
        && !url.username && !url.password) return id;
  } catch { /* Not a verified local provider. */ }
}

/** Hosts that bill the official OpenAI Codex subscription. A request routed to
 * one of them spends that account's quota whatever the provider id says. */
function isSubscriptionHost(host: string): boolean {
  if (host === "api.openai.com" || host === "auth.openai.com" || host === "chat.openai.com" || host === "chatgpt.com") return true;
  return host.endsWith(".openai.com") || host.endsWith(".chatgpt.com");
}

/** The provider routes a Codex configuration declares. */
export interface CodexProviderRoutes {
  /** The provider a fresh thread inherits from the configuration. */
  defaultProviderId?: string;
  /** The declared endpoint of every configured provider, by provider id. */
  baseUrls: Record<string, string>;
}

const unquote = (value: string): string | undefined => {
  const text = value.trim();
  const double = /^"([^"]*)"$/.exec(text);
  if (double) return double[1];
  const single = /^'([^']*)'$/.exec(text);
  if (single) return single[1];
  return undefined;
};

/**
 * The provider routes declared by a Codex configuration.
 *
 * Only the top-level keys and the `[model_providers.<id>]` tables are read; a
 * configuration that does not declare a route leaves it unproven, and an
 * unproven route keeps the subscription guard.
 */
export function parseCodexProviderRoutes(configText: string): CodexProviderRoutes {
  const baseUrls: Record<string, string> = {};
  let defaultProviderId: string | undefined;
  let table = "";
  for (const raw of configText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const end = line.indexOf("]");
      table = end < 0 ? "" : line.slice(1, end).trim();
      continue;
    }
    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const value = entry[2].trim();
    if (!table) {
      if (key === "model_provider") defaultProviderId = unquote(value) ?? value;
      continue;
    }
    const provider = /^model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/.exec(table);
    if (!provider) continue;
    const id = provider[1] ?? provider[2] ?? provider[3];
    if (key !== "base_url") continue;
    const base = unquote(value);
    if (base) baseUrls[id] = base;
  }
  return { defaultProviderId, baseUrls };
}

/**
 * A provider route that is billed outside the official Codex subscription.
 *
 * The reserve guard protects the owner's subscription account. A thread pinned
 * to an explicitly configured third-party route (the OpenCodex hub, which keeps
 * its own account pool and its own per-account quota) spends that route's
 * budget, so the subscription quota is not its budget and must not block it.
 *
 * The route is proven, never assumed: the provider id must not be the builtin
 * subscription provider, the configuration must declare it, and its explicit
 * base_url must not point at the official OpenAI/ChatGPT endpoints. Every other
 * route, including an undeclared or unreadable one, keeps the guard.
 */
export function subscriptionIndependentProviderId(routes: CodexProviderRoutes, providerId?: unknown): string | undefined {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  if (!id || id === "openai" || id === "azure") return;
  const base = routes.baseUrls[id];
  if (typeof base !== "string" || !base.trim()) return;
  let url: URL;
  try { url = new URL(base.trim()); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.username || url.password) return;
  const host = url.hostname.toLowerCase();
  if (!host || isSubscriptionHost(host)) return;
  return id;
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Observe the actual owned process on each operation; never accept a config flag
 * or a previous preflight as evidence. A loopback-only network namespace cannot
 * reach the subscription provider even if an external configuration changes. */
export async function isCredentialFreeLocalChild(child: ChildProcessWithoutNullStreams | undefined,
  executable: string, codeHome: string): Promise<boolean> {
  if (process.platform !== "linux" || !child?.pid || child.killed || child.exitCode !== null
      || !child.stdin.writable || !isAbsolute(executable) || !isAbsolute(codeHome)) return false;
  try {
    const proc = `/proc/${child.pid}`;
    const [exe, expectedExe, status, environ, devices, ns, ownNs] = await Promise.all([
      readlink(`${proc}/exe`), realpath(executable), readFile(`${proc}/status`, "utf8"),
      readFile(`${proc}/environ`, "utf8"), readFile(`${proc}/net/dev`, "utf8"),
      readlink(`${proc}/ns/net`), readlink("/proc/self/ns/net"),
    ]);
    if (exe !== expectedExe || !new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(status) || ns !== ownNs) return false;
    const interfaces = devices.split("\n").filter(line => line.includes(":"))
      .map(line => line.slice(0, line.indexOf(":")).trim());
    if (interfaces.length !== 1 || interfaces[0] !== "lo") return false;
    const env = Object.fromEntries(environ.split("\0").filter(Boolean).map(pair => {
      const offset = pair.indexOf("="); return [pair.slice(0, offset), pair.slice(offset + 1)];
    }));
    if (!env.HOME || !isAbsolute(env.HOME) || !env.CODEX_HOME
        || resolve(env.CODEX_HOME) !== resolve(codeHome)) return false;
    if (["OPENAI_API_KEY", "OPENAI_API_KEY_ORG", "CODEX_API_KEY"].some(key => env[key] || process.env[key])) return false;
    if (!await absent(join(codeHome, "auth.json")) || !await absent(join(env.HOME, ".codex", "auth.json"))) return false;
    return !child.killed && child.exitCode === null && child.stdin.writable;
  } catch { return false; }
}
