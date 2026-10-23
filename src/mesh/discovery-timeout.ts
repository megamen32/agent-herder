/** Keep discovery bounded while allowing a normal thirty-second provider window. */
export function meshDiscoveryTimeoutMs(value=process.env.AGENT_HERDER_MESH_DISCOVERY_TIMEOUT_MS):number{
 if(value===undefined||value.trim()==="")return 30000;
 const timeout=Number(value);
 if(Number.isInteger(timeout)&&timeout>=100&&timeout<=300000)return timeout;
 console.error("[agent-herder] AGENT_HERDER_MESH_DISCOVERY_TIMEOUT_MS must be an integer 100..300000; using 30000ms");
 return 30000;
}
