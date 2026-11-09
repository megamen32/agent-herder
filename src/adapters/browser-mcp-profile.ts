import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** The owner supplies the exact registered endpoint. It selects the browser
 * profile server-side; account identity is separately verified inside the tab. */
export function validateBrowserMcpUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("browser_mcp_endpoint_invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "mcp.bezrabotnyi.com"
    || url.port || url.username || url.password || url.search || url.hash
    || !/^\/server\/[a-z0-9][a-z0-9_-]*\/mcp$/u.test(url.pathname)) {
    throw new Error("browser_mcp_endpoint_invalid");
  }
  return url.href;
}

/** Match the runtime's protected-file credential boundary without importing an
 * automation runtime into an AHAP adapter. Never emit the credential in errors. */
export async function readProtectedBrowserMcpToken(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("browser_mcp_protected_profile_required");
  let input: unknown;
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024
      || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("browser_mcp_protected_profile_required");
    }
    input = JSON.parse(await readFile(path, "utf8"));
  } catch { throw new Error("browser_mcp_protected_profile_unavailable"); }
  const authorization = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).authorization : undefined;
  if (typeof authorization !== "string" || /[\u0000-\u001f\u007f]/u.test(authorization)) {
    throw new Error("browser_mcp_authorization_unavailable");
  }
  const token = authorization.replace(/^Bearer\s+/iu, "").trim();
  if (!token || /\s/u.test(token)) throw new Error("browser_mcp_authorization_unavailable");
  return token;
}
