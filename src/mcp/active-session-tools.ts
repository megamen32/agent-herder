import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {readActiveInventory,activeInventoryFleet,filterActiveInventory,type ActiveInventoryQuery} from '../active-session-inventory.js';
import {readFleetActiveInventory} from '../active-session-fleet.js';
import {hostname} from 'node:os';
const query={hostId:z.string().min(1).max(512).optional().describe('Code work computer; matches any confirmed workspace, not GUI/runtime computer.'),runtimeHostId:z.string().min(1).max(512).optional().describe('Separate GUI/runtime computer filter.'),harness:z.string().min(1).max(64).optional(),limit:z.number().int().min(1).max(10000).optional(),offset:z.number().int().min(0).optional()};
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value as Record<string,unknown>});
export async function listActiveSessions(input:ActiveInventoryQuery={}){
 if(input.runtimeHostId?.toLowerCase()===hostname().toLowerCase())return filterActiveInventory(await readActiveInventory(),input);
 return readFleetActiveInventory(input);
}
export function registerActiveSessionTools(server:McpServer){
 server.registerTool('list_active_sessions_local',{description:'Read this owner current materialized active inventory. Internal fleet reader; never hydrates history or infers live activity from FTS.',annotations:{readOnlyHint:true},inputSchema:z.object({}).strict()},async()=>result(await readActiveInventory()));
 server.registerTool('list_active_sessions',{description:'One fast current active session list across ALL configured computers by default. hostId filters where CODE CHANGES (any confirmed workspace); runtimeHostId separately filters where GUI/runtime runs. Returns all active rows unless limit is explicit, totals before pagination, multiple absolute workspaces, freshness and partial/unavailable host evidence. Unknown workspaces remain in unfiltered results.',annotations:{readOnlyHint:true},inputSchema:z.object(query).strict()},async input=>result(await listActiveSessions(input)));
}
