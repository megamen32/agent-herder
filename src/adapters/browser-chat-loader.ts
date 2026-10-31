import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserChatAdapter, type BrowserChatDriver } from "./browser-chat.js";

export const BROWSER_CHAT_PROVIDERS_ENV = "AGENT_HERDER_BROWSER_CHAT_PROVIDERS";

type Config = { id: "chatgpt" | "zai"; name: string; cwd: string; module: string };

function configuredProviders(raw: string): Config[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length < 1 || data.length > 12) {
    throw new Error("Browser chat providers must be a nonempty array of at most 12 entries");
  }
  return data.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Invalid browser provider");
    const value = entry as Record<string, unknown>;
    if (value.id !== "chatgpt" && value.id !== "zai") throw new Error("Unsupported browser provider ID; supported: chatgpt, zai");
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Browser provider name required");
    if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new Error("Browser provider CWD must be absolute");
    if (typeof value.module !== "string" ||
      (!["builtin:zai-cdp", "builtin:chatgpt-mac-cdp"].includes(value.module) && !isAbsolute(value.module))) {
      throw new Error("Browser driver module must be an absolute local path or an allowed built-in");
    }
    return { id: value.id, name: value.name, cwd: value.cwd, module: value.module };
  });
}

/** Validate all declared providers before loading any untrusted local module. */
export function configuredBrowserProviderIds(raw = process.env[BROWSER_CHAT_PROVIDERS_ENV]): Array<"chatgpt" | "zai"> {
  if (!raw?.trim()) return [];
  const configs = configuredProviders(raw);
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.id)) throw new Error(`Duplicate browser provider '${config.id}'`);
    seen.add(config.id);
  }
  return configs.map(config => config.id);
}

/** One provider instance of the common base, NOT a multiplexed harness.
 * Each provider keeps independent capabilities, lifecycle and UI registry ID.
 */
export async function loadBrowserChatProviderAdapter(
  id: "chatgpt" | "zai", raw = process.env[BROWSER_CHAT_PROVIDERS_ENV],
): Promise<BrowserChatAdapter> {
  if (!raw?.trim()) throw new Error(`Browser provider '${id}' is not configured`);
  configuredBrowserProviderIds(raw);
  const config = configuredProviders(raw).find(entry => entry.id === id);
  if (!config) throw new Error(`Browser provider '${id}' is not configured`);
  const exports = config.module === "builtin:zai-cdp"
    ? await import("./zai-cdp-driver.js")
    : config.module === "builtin:chatgpt-mac-cdp"
      ? await import("./chatgpt-mac-cdp-driver.js")
      : await import(pathToFileURL(config.module).href);
  if (typeof exports.createBrowserChatDriver !== "function") {
    throw new Error(`Browser provider '${id}' must export createBrowserChatDriver`);
  }
  const driver: BrowserChatDriver = await exports.createBrowserChatDriver({id, cwd:config.cwd});
  if (!driver || typeof driver.listChats !== "function" || typeof driver.sendMessage !== "function") {
    throw new Error(`Browser provider '${id}' does not implement listChats/sendMessage`);
  }
  return new BrowserChatAdapter(driver, {
    id, name:config.name, harness:id, cwd:config.cwd,
  }, config.cwd, true);
}

/** Resolve both independent adapters; a failed site must not mask the other
 * during startup, so production initializes them independently by ID.
 */
export async function loadBrowserChatAdapters(
  raw = process.env[BROWSER_CHAT_PROVIDERS_ENV],
): Promise<BrowserChatAdapter[]> {
  return Promise.all(configuredBrowserProviderIds(raw).map(id=>loadBrowserChatProviderAdapter(id,raw)));
}
