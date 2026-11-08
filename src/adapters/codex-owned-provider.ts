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
