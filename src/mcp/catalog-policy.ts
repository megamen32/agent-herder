import type { ListToolsResult } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Discovery only. These exact peer endpoints remain registered and callable. */
export const internalReaders = new Set([
  "session_search_local", "list_active_sessions_local",
  // Operator tools of the release pipeline: never advertised to agents, but
  // the rollout workers address these exact names.
  "project_release_lease", "project_integration",
]);

/**
 * The peer capability registry: peer herders and the fleet services prove
 * native capability from the ADVERTISED catalog before calling — GPTAdmin
 * mesh discovery and the fleet cabinet snapshot require mesh_snapshot, the
 * exact-route resolution and the native peer readiness require mesh_deliver,
 * owner identity checks read fleet_node_info, inventory paging reads
 * fleet_session_page and the singleton peer requires list_agents
 * (src/mesh/gptadmin.ts, src/mesh/fleet-service.ts, src/mesh/native-peer.ts,
 * src/mesh/singleton-peer.ts). No projection layer may hide these names:
 * an unregistered endpoint never appears either way, so keeping them
 * discoverable only restores the proofs the fleet already depends on.
 * fleet-service.ts additionally reads create_session from the advertised
 * catalog to report the host's session-creation capability (createHarnesses),
 * so it stays discoverable under any projection as well.
 */
export const capabilityRegistry = new Set(["mesh_snapshot", "mesh_deliver", "fleet_node_info", "fleet_session_page", "list_agents", "create_session"]);

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

export function projectToolCatalog(result: ListToolsResult, dynamicHidden: ReadonlySet<string> = new Set()): ListToolsResult {
  const extra = extraCatalogPolicy();
  const hidden = new Set([...internalReaders, ...dynamicHidden, ...extra.hide]
    .filter(name => !extra.show.has(name) && !capabilityRegistry.has(name)));
  return { ...result, tools: result.tools.filter(tool => !hidden.has(tool.name)) };
}
