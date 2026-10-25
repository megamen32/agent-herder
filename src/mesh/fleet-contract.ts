import type {MeshAddress,MeshSession} from "./protocol.js";
export type FleetHarness="codex"|"zcode"|"opencode";
/** Harnesses a fleet node can host. Extending this list is one edit here, but every
 * node must already observe that harness; a node that cannot fails closed instead of
 * silently disappearing from the fleet view. */
export const fleetHarnesses:readonly FleetHarness[]=["codex","zcode","opencode"];
/** Display/expected-host policy only. Routes and liveness come from GPTAdmin. */
export interface FleetHostDefinition {hostId:string;label:string;uiUrl?:string;nativeUser?:string;
/** A machine another session leads: our fleet reads it as offline and never probes it. */
offline?:boolean;offlineReason?:string}
export interface FleetScope {profileId:string;userId:string}
export interface FleetHost extends FleetHostDefinition {
 state:"ready"|"metadata_only"|"offline"|"unavailable"|"stale";
 fetchedAt:number|null;expiresAt:number|null;generation:number|null;
 createHarnesses:FleetHarness[];reason?:string;
}
export interface FleetSession extends MeshSession {key:string}
export interface FleetView {hosts:FleetHost[];sessions:FleetSession[];complete:boolean;limited:boolean}
export interface FleetCreateRequest {hostId:string;harness:FleetHarness;name:string;cwd:string;model?:string;inputId:string;project?:string;projectReadinessContract?:"integrator-host-readiness-v1"}
/** The project-execution receipt of one created session. The harness and the model are the ones the project route designates, so the receipt of a route that is not codex names its own harness. */
export interface FleetProjectExecutionReceipt {projectId:string;projectRoot:string;rootIdentity:string;policyRevision:string;runtimePolicyRevision:string;hostId:string;harness:FleetHarness;model:string;requiredTools:readonly string[];address:MeshAddress;launchCwd:string}
export interface FleetCreateReceipt {state:"created"|"not_attempted"|"unknown";inputId:string;address?:MeshAddress;launchCwd?:string;retryable:boolean;reason?:string;projectReadinessContract?:"integrator-host-readiness-v1";projectExecution?:FleetProjectExecutionReceipt}
/** Work target of an already existing fleet session, addressed by its full address. */
export interface FleetSessionTarget {hostId:string;cwd?:string}
/** Receipt of one work-target override. An unreachable machine is never reported as applied. */
export interface FleetSessionTargetReceipt {
  state:"updated"|"unchanged"|"unreachable"|"unsupported";
  hostId:string;
  cwd:string;
  reason?:string;
}
