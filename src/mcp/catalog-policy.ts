import type { ListToolsResult } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Discovery only. These exact peer endpoints remain registered and callable. */
const internalReaders = new Set(["session_search_local", "list_active_sessions_local"]);

interface CatalogPolicyFile {
  hide?: unknown;
  show?: unknown;
}

function catalogPolicyFile(): string {
  return process.env.AGENT_HERDER_CATALOG_POLICY_FILE
    || join(homedir(), ".config", "agent-herder", "catalog-policy.json");
}

// Read per tools/list request so the discovery set can be tuned without a
// restart. A missing or invalid file hides nothing extra. Hidden tools stay
// registered and callable; only discovery (tools/list) is projected.
function extraCatalogPolicy(): { hide: Set<string>; show: Set<string> } {
  try {
    const raw: CatalogPolicyFile = JSON.parse(readFileSync(catalogPolicyFile(), "utf8"));
    const hide = Array.isArray(raw.hide) ? raw.hide.filter((x): x is string => typeof x === "string") : [];
    const show = Array.isArray(raw.show) ? raw.show.filter((x): x is string => typeof x === "string") : [];
    return { hide: new Set(hide), show: new Set(show) };
  } catch {
    return { hide: new Set(), show: new Set() };
  }
}

export function projectToolCatalog(result: ListToolsResult): ListToolsResult {
  const extra = extraCatalogPolicy();
  const hidden = new Set([...internalReaders, ...extra.hide].filter(name => !extra.show.has(name)));
  return { ...result, tools: result.tools.filter(tool => !hidden.has(tool.name)) };
}
