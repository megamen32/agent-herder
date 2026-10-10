import type {MeshAddress} from '../../mesh/protocol.js';
import type {FleetHostDefinition} from '../../mesh/fleet-contract.js';
/** A native receipt opens only its own machine, including an empty thread not yet in discovery. */
export function fleetSessionLink(host:FleetHostDefinition|undefined,address:MeshAddress):string|undefined{
 if(!host?.uiUrl||host.hostId!==address.hostId)return undefined;
 return host.uiUrl.replace(/\/$/,'')+'/#/session/'+encodeURIComponent(address.harness+':'+address.nativeSessionId);
}
