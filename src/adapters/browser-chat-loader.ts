import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserChatAdapter, type BrowserChatDriver } from "./browser-chat.js";
import { BrowserChatRouter, type BrowserChatEndpoint } from "./browser-chat-router.js";

export const BROWSER_CHAT_PROVIDERS_ENV = "AGENT_HERDER_BROWSER_CHAT_PROVIDERS";

type Config = { id: string; name: string; cwd: string; module: string };

function configuredProviders(raw: string): Config[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length < 1 || data.length > 12) {
    throw new Error("Browser chat providers must be a nonempty array of at most 12 entries");
  }
  return data.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Invalid browser provider");
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id)) throw new Error("Invalid browser provider ID");
    if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Browser provider name required");
    if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new Error("Browser provider CWD must be absolute");
    if (typeof value.module !== "string" || !isAbsolute(value.module)) throw new Error("Browser driver module must be an absolute local path");
    return { id: value.id, name: value.name, cwd: value.cwd, module: value.module };
  });
}

/** Load locally installed, trusted browser drivers; never touches or creates a browser profile. */
export async function loadBrowserChatAdapter(raw = process.env[BROWSER_CHAT_PROVIDERS_ENV]): Promise<BrowserChatAdapter | null> {
  if (!raw?.trim()) return null;
  const configs = configuredProviders(raw);
  const endpoints: BrowserChatEndpoint[] = [];
  const seen = new Set<string>();
  // Reject duplicates before importing any provider code.
  for (const config of configs) {
    if (seen.has(config.id)) throw new Error(`Duplicate browser provider '${config.id}'`);
    seen.add(config.id);
  }
  for (const config of configs) {
    const exports = await import(pathToFileURL(config.module).href);
    if (typeof exports.createBrowserChatDriver !== "function") {
      throw new Error(`Browser provider '${config.id}' must export createBrowserChatDriver`);
    }
    const driver: BrowserChatDriver = await exports.createBrowserChatDriver({ id: config.id, cwd: config.cwd });
    if (!driver || typeof driver.listChats !== "function" || typeof driver.sendMessage !== "function") {
      throw new Error(`Browser provider '${config.id}' does not implement listChats/sendMessage`);
    }
    endpoints.push({ id: config.id, name: config.name, cwd: config.cwd, driver });
  }
  return new BrowserChatAdapter(
    new BrowserChatRouter(endpoints),
    { id: "browser-chat", name: "Browser chats", harness: "browser-chat", cwd: "/browser-chat" },
  );
}
