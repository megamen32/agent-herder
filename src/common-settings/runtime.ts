/**
 * The runtime of the common settings on one node.
 *
 * The module builds the service of the node from the environment and starts
 * the round of taking the document. A node that has no common settings
 * configured has no service at all: it answers that it has none and it never
 * writes a file of the product.
 */

import { hostname } from "node:os";
import { join } from "node:path";

import { AutomationLaunchPolicyStore } from "../automation-launch-policy.js";
import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { directFleetPeers } from "../mesh/fleet-direct-transport.js";
import { SettingsStore } from "../web/settings-store.js";
import { CommonSettingsStateStore, type CommonSettingsRole } from "./node-state.js";
import { CommonSettingsNodeService, launchPolicyTarget } from "./node-service.js";
import { COMMON_SETTINGS_SYNC_INTERVAL_MS, readCommonSettingsConfig } from "./service.js";
import { DirectCommonSettingsTransport, type CommonSettingsTransport } from "./transport.js";

/** The peers of the fleet: the node and the address of its runtime. */
function fleetPeers(): { hostId: string; target: string }[] {
  return directFleetPeers
    .filter((peer) => peer.hostId !== "MacBook-Pro-User.local")
    .map((peer) => ({ hostId: peer.hostId, target: `mcp:shell:${peer.hostId}:AgentHerder` }));
}

/** The address of the node that owns the document. */
function ownerTarget(ownerHostId: string | null, localHostId: string): string | null {
  if (!ownerHostId || ownerHostId === localHostId) return null;
  const peer = directFleetPeers.find((candidate) => candidate.hostId === ownerHostId);
  return peer ? `mcp:shell:${peer.hostId}:AgentHerder` : null;
}

let sharedService: CommonSettingsNodeService | null | undefined;

/**
 * The service of the common settings of this node.
 *
 * The service is built once: the node has one owner of the document and one
 * round of taking it. A node without the owner named in the environment has
 * no service and claims nothing.
 */
export function commonSettingsService(options: {
  env?: NodeJS.ProcessEnv;
  hostId?: string;
  store?: SettingsStore;
  launchPolicy?: { read(): Promise<{ kind: "valid" | "absent" | "invalid"; policy?: unknown; etag?: string; error?: string }>; replace(value: unknown, options: { ifMatch?: string }): Promise<{ policy: unknown; etag: string }> };
  hooks?: { read(): Promise<{ known: boolean; prohibitionsEnabled: boolean; disabledHooks: string[]; reason?: string }>; apply(state: { prohibitionsEnabled: boolean; disabledHooks: string[] }): Promise<{ ok: boolean; reason?: string }> };
  transport?: CommonSettingsTransport;
  statePath?: string;
} = {}): CommonSettingsNodeService | null {
  if (sharedService !== undefined) return sharedService;
  const env = options.env ?? process.env;
  const hostId = options.hostId ?? hostname();
  const { ownerHostId, role } = readCommonSettingsConfig(env, hostId);
  if (role === "none") {
    sharedService = null;
    return sharedService;
  }
  const store = options.store ?? new SettingsStore({ actor: hostId, hostId });
  const transport = options.transport ?? new DirectCommonSettingsTransport();
  // The document of the owner is one document: the panel of the owner shows the
  // same revision that the nodes of the fleet take, or the confirmation never
  // closes. The policy of the launch is a part of the document, so the owner
  // reads it from the same file the panel reads. A member keeps the
  // application of its own values as it was: it takes the values of the
  // document, not the policy of the owner.
  const launchPolicy = options.launchPolicy
    ?? (role === "owner"
      ? launchPolicyTarget(new AutomationLaunchPolicyStore(join(resolveAutopilotStateDir(), "automation-launch-policy.json")))
      : undefined);
  sharedService = new CommonSettingsNodeService({
    hostId,
    role: role as CommonSettingsRole,
    ownerHostId,
    ownerTarget: ownerTarget(ownerHostId, hostId),
    stateStore: new CommonSettingsStateStore(options.statePath ? { path: options.statePath } : {}),
    target: store,
    ...(launchPolicy ? { launchPolicy } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    transport,
  });
  return sharedService;
}

/**
 * The round of taking the document.
 *
 * The node takes the document of the owner by itself: a node that was off or
 * that had no connection takes the current revision when it comes back, and
 * nobody does it by hand. The round is silent when nothing moved.
 */
export function startCommonSettingsSyncLoop(
  service: CommonSettingsNodeService,
  options: { intervalMs?: number; now?: () => Date } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? COMMON_SETTINGS_SYNC_INTERVAL_MS;
  let running = false;
  const round = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await service.catchUp();
    } catch (error) {
      console.error(`[agent-herder] Общие настройки: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void round(); }, intervalMs);
  timer.unref?.();
  void round();
  return { stop: () => clearInterval(timer) };
}
