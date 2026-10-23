import {describe,it,expect,vi,afterEach} from 'vitest';
import {searchSessionFleet} from '../src/session-search-fleet.js';
import {registerSessionSearchTools} from '../src/mcp/session-search-tools.js';
import {createFleetApiHandler} from '../src/mesh/fleet-api.js';

describe('indexed fleet search consumer routes',()=>{
 it('starts every host query in parallel and keeps unavailable hosts explicit',async()=>{
  const pending:Array<()=>void>=[];const started:string[]=[];
  const call=vi.fn(async(peer:{hostId:string})=>{started.push(peer.hostId);await new Promise<void>(resolve=>pending.push(resolve));if(peer.hostId==='b')throw new Error('index_missing');return{hostId:peer.hostId,partial:false,results:[{hostId:peer.hostId,harness:'codex',nativeSessionId:'native'}]};});
  const promise=searchSessionFleet({query:'historicalword'},[{hostId:'a',target:'a'},{hostId:'b',target:'b'}],call);
  expect(started).toEqual(['a','b']);pending.forEach(resolve=>resolve());
  const result=await promise;expect(result.results).toHaveLength(1);expect(result.partial).toBe(true);expect(result.hosts[1]).toMatchObject({hostId:'b',state:'unavailable',reason:'index_missing'});
 });
 it('rejects cross-host identity substitution and does not fall back to live history',async()=>{
  const result=await searchSessionFleet({query:'word'},[{hostId:'a',target:'a'}],async()=>({hostId:'other',partial:false,results:[]}));
  expect(result.hosts[0]).toMatchObject({state:'unavailable',reason:'search_host_response_invalid'});
  expect((await searchSessionFleet({query:'word'},[],async()=>({}))).partial).toBe(true);
 });
 it('does not silently ignore a foreign host filter in local-only MCP mode',async()=>{
  const tools=new Map<string,Function>();const search=vi.fn();
  registerSessionSearchTools({registerTool:(name:string,_schema:unknown,handler:Function)=>tools.set(name,handler)} as never,{index:{hostId:'local',search} as never});
  await expect(tools.get('session_search')!({query:'word',hostId:'foreign'})).rejects.toThrow('search_host_invalid');expect(search).not.toHaveBeenCalled();
 });
 it('registers MCP tools that use only local mirror or remote indexed tool',async()=>{
  const tools=new Map<string,Function>();const local=vi.fn(()=>({hostId:'a',results:[],partial:false}));
  const call=vi.fn(async()=>({hostId:'b',partial:false,results:[]}));
  registerSessionSearchTools({registerTool:(name:string,_schema:unknown,handler:Function)=>tools.set(name,handler)} as never,{index:{search:local} as never,transport:{call} as never,peers:[{hostId:'b',target:'peer-b'}]});
  await tools.get('session_search_local')!({query:'word',limit:5});expect(local).toHaveBeenCalledWith({query:'word',limit:5});
  const result=await tools.get('session_search')!({query:'word',limit:5});expect(result.structuredContent.partial).toBe(false);expect(call).toHaveBeenCalledWith('peer-b','session_search_local',{query:'word',limit:5,harnesses:undefined});
 });
 it('exposes the existing authenticated fleet API handler search without snapshots',async()=>{
  const search=vi.fn(async input=>({results:[],partial:true,input}));const snapshot=vi.fn(()=>{throw new Error('live_poll_forbidden');});
  const handler=createFleetApiHandler({search,snapshot} as never);let body='';const writeHead=vi.fn();
  expect(await handler({url:'/api/fleet/search?query=старое&hostId=b&harness=codex&limit=7',method:'GET'} as never,{writeHead,end:(value:string)=>body=value} as never)).toBe(true);
  expect(search).toHaveBeenCalledWith({query:'старое',hostId:'b',harnesses:['codex'],limit:7});expect(snapshot).not.toHaveBeenCalled();expect(JSON.parse(body).partial).toBe(true);expect(writeHead).toHaveBeenCalledWith(200,expect.anything());
 });
});
