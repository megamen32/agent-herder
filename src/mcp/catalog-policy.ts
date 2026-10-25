import type { ListToolsResult } from "@modelcontextprotocol/server";

/** Discovery only. These exact peer endpoints remain registered and callable. */
const internalReaders = new Set(["session_search_local", "list_active_sessions_local"]);

export function projectToolCatalog(result: ListToolsResult): ListToolsResult {
  return { ...result, tools: result.tools.filter(tool => !internalReaders.has(tool.name)) };
}
