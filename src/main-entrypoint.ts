import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Node resolves ESM modules through symlinks, while argv[1] retains launch spelling. */
export function isMainEntrypoint(moduleUrl: string, entrypoint = process.argv[1]): boolean {
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // Import-only callers or removed launch paths must not accidentally start main.
    return false;
  }
}
