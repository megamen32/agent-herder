import type {MeshAddress,MeshSession} from "./protocol.js";
export type FleetHarness="codex"|"zcode"|"opencode";
export const fleetHarnesses:readonly FleetHarness[]=["codex","zcode","opencode"];
/** Display/expected-host policy only. Routes and liveness come from GPTAdmin. */
export interface FleetHostDefinition {hostId:string;label:string;uiUrl?:string;nativeUser?:string}
export interface FleetScope {profileId:string;userId:string}
export interface FleetHost extends FleetHostDefinition {
 state:"ready"|"metadata_only"|"offline"|"unavailable"|"stale";
 fetchedAt:number|null;expiresAt:number|null;generation:number|null;
 createHarnesses:FleetHarness[];reason?:string;
}
export interface FleetSession extends MeshSession {key:string}
export interface FleetView {hosts:FleetHost[];sessions:FleetSession[];complete:boolean;limited:boolean}
export interface FleetCreateRequest {hostId:string;harness:FleetHarness;name:string;cwd:string;model?:string;inputId:string}
export interface FleetCreateReceipt {state:"created"|"not_attempted"|"unknown";inputId:string;address?:MeshAddress;launchCwd?:string;retryable:boolean;reason?:string}
