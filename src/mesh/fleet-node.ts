import {hostname,userInfo,platform} from 'node:os';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import type {HarnessAdapter} from '../types/index.js';
import {fleetHarnesses} from './fleet-contract.js';
/** Attach to the existing local controller. No override, native activation, private writer or subprocess. */
export function registerFleetNodeTools(server:McpServer,deps:{adapters:Map<string,HarnessAdapter>}):void{
 const generation=Date.now()-Math.floor(process.uptime()*1000);
 server.registerTool('fleet_node_info',{description:'Read actual local Herder host/user identity and configured session-creation capability, without activating a harness.',inputSchema:z.object({})},async()=>{
  const snapshot={hostId:hostname(),nativeUser:userInfo().username,platform:platform(),generation,createHarnesses:fleetHarnesses.filter(h=>typeof deps.adapters.get(h)?.createSession==='function')};
  return {content:[{type:'text' as const,text:JSON.stringify(snapshot)}]};
 });
}
