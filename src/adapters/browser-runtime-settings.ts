import { isAbsolute } from "node:path";

/** Public names for browser bindings. The private target descriptor lives in
 * the protected owner profile and is injected at launch time. */
export type VibeTargetAlias = "mac-mini" | "server-100";

export interface BrowserTransportSettings {
  macMiniSshTarget?: string;
  macMiniGatewayScript?: string;
  macMiniGatewayUrl?: string;
  vibeMacSshTarget?: string;
  vibeMacNodePath?: string;
  vibeMacCliPath?: string;
  vibeServerCliPath?: string;
}

/** Read machine-local browser bindings from the owner environment. There are
 * intentionally no deployment defaults in source control. */
export function browserTransportSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserTransportSettings {
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw || undefined;
  };
  return {
    macMiniSshTarget: value("AGENT_HERDER_MAC_MINI_SSH_TARGET"),
    macMiniGatewayScript: value("AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT"),
    macMiniGatewayUrl: value("AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_URL"),
    vibeMacSshTarget: value("AGENT_HERDER_VIBE_MAC_SSH_TARGET"),
    vibeMacNodePath: value("AGENT_HERDER_VIBE_MAC_NODE_PATH"),
    vibeMacCliPath: value("AGENT_HERDER_VIBE_MAC_CLI_PATH"),
    vibeServerCliPath: value("AGENT_HERDER_VIBE_SERVER_CLI_PATH"),
  };
}

export function validSshTarget(value: string): boolean {
  return /^[a-zA-Z_][\w.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(value);
}

export function validPrivatePath(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0") && !value.split("/").includes("..")
    && /^\/[A-Za-z0-9_./-]+$/u.test(value);
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`browser_runtime_setting_missing:${name}`);
  return value;
}

export interface ResolvedVibeSettings {
  cliPath: string;
  sshTarget?: string;
  nodePath?: string;
}

/** Resolve the private child-process descriptor for an opaque target alias. */
export function resolveVibeSettings(
  target: string,
  settings: BrowserTransportSettings = browserTransportSettingsFromEnv(),
): ResolvedVibeSettings {
  if (target === "server-100") {
    const cliPath = required("AGENT_HERDER_VIBE_SERVER_CLI_PATH", settings.vibeServerCliPath);
    if (!validPrivatePath(cliPath)) throw new Error("browser_runtime_setting_invalid_path");
    return { cliPath };
  }
  if (target !== "mac-mini") throw new Error("vibe_target_not_configured");
  const sshTarget = required("AGENT_HERDER_VIBE_MAC_SSH_TARGET", settings.vibeMacSshTarget);
  const nodePath = required("AGENT_HERDER_VIBE_MAC_NODE_PATH", settings.vibeMacNodePath);
  const cliPath = required("AGENT_HERDER_VIBE_MAC_CLI_PATH", settings.vibeMacCliPath);
  if (!validSshTarget(sshTarget) || !validPrivatePath(nodePath) || !validPrivatePath(cliPath)) {
    throw new Error("browser_runtime_setting_invalid");
  }
  return { sshTarget, nodePath, cliPath };
}

export function resolveMacMiniSettings(
  settings: BrowserTransportSettings = browserTransportSettingsFromEnv(),
): { sshTarget: string; gatewayScript: string; gatewayUrl: string } {
  const sshTarget = required("AGENT_HERDER_MAC_MINI_SSH_TARGET", settings.macMiniSshTarget);
  const gatewayScript = required("AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT", settings.macMiniGatewayScript);
  const gatewayUrl = settings.macMiniGatewayUrl ?? "http://127.0.0.1:50260/mcp";
  if (!validSshTarget(sshTarget) || !validPrivatePath(gatewayScript)) {
    throw new Error("browser_runtime_setting_invalid");
  }
  let url: URL;
  try { url = new URL(gatewayUrl); } catch { throw new Error("browser_runtime_setting_invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("browser_runtime_setting_invalid_url");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) throw new Error("browser_runtime_setting_invalid_url");
  return { sshTarget, gatewayScript, gatewayUrl: url.href };
}
