import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {SessionSearchIndex} from '../session-search.js';
import {searchSessionFleet,type SearchPeer} from '../session-search-fleet.js';
import type {GptAdminTransport} from '../mesh/gptadmin.js';

const query={query:z.string().trim().min(1).max(1000),harnesses:z.array(z.string().min(1).max(64)).max(32).optional(),limit:z.number().int().min(1).max(100).default(20)};
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value as Record<string,unknown>});
/** Reads only the mirror. Index population belongs to the long-running owner. */
export function registerSessionSearchTools(server:McpServer,options:{index?:SessionSearchIndex;transport?:GptAdminTransport;peers?:readonly SearchPeer[]}={}){
 let index=options.index;
 const local=()=>index??=(new SessionSearchIndex(undefined,undefined,{readOnly:true}));
 server.registerTool('session_search_local',{description:'Search this host persisted session titles and message words in its FTS5 mirror. No live history scrape. Reports source coverage and indexing progress.',annotations:{readOnlyHint:true},inputSchema:z.object(query).strict()},async input=>result(local().search(input)));
 server.registerTool('session_search',{description:'Search indexed persisted session titles and message words on configured computers in parallel. Missing or incomplete host indexes are explicit.',annotations:{readOnlyHint:true},inputSchema:z.object({...query,hostId:z.string().min(1).max(512).optional()}).strict()},async input=>{
  if(!options.transport||!options.peers?.length){if(input.hostId&&input.hostId!==local().hostId)throw new Error('search_host_invalid');return result(local().search(input));}
  return result(await searchSessionFleet(input,options.peers,(peer,args)=>options.transport!.call(peer.target,'session_search_local',args as unknown as Record<string,unknown>)));
 });
}
