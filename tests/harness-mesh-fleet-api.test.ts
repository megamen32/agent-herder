import {describe,it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {hostname,userInfo} from 'node:os';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';
import {createFleetApiHandler} from '../src/mesh/fleet-api.js';
import {unwrapResult} from '../src/mesh/protocol.js';
describe('fleet HTTP and native MCP envelopes (focused integration; expected 3s, maximum 30s)',()=>{
 it('SDK node capability reads actual identity and does not launch a native adapter',async()=>{
  const adapter={createSession:vi.fn(),listSessions:vi.fn(),isReady:vi.fn()};
  const server=new McpServer({name:'local-herder',version:'1'});registerFleetNodeTools(server,{adapters:new Map([['codex',adapter as any]])});
  const client=new Client({name:'fleet-consumer',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);try{
   const result=unwrapResult(await client.callTool({name:'fleet_node_info',arguments:{}}));expect(result.hostId).toBe(hostname());expect(result.nativeUser).toBe(userInfo().username);expect(result.createHarnesses).toEqual(['codex']);expect(adapter.createSession).not.toHaveBeenCalled();expect(adapter.listSessions).not.toHaveBeenCalled();
  }finally{await client.close();await server.close();}
 });
 it('HTTP reads are GET-only, default host is local and body cannot select an auth profile or user',async()=>{
  const service={snapshot:vi.fn(async()=>({hosts:[],sessions:[],limited:false,complete:false})),create:vi.fn(async(request)=>({state:'unknown',inputId:request.inputId,retryable:false}))};
  const handler=createFleetApiHandler(service as any,'88');
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;const base=`http://127.0.0.1:${port}`;
  try{
   const hosts=await (await fetch(base+'/api/fleet/hosts')).json();expect(hosts.defaultHostId).toBe('88');expect(service.create).not.toHaveBeenCalled();
   expect((await fetch(base+'/api/fleet/sessions?hostId=88&limit=3')).status).toBe(200);expect(service.snapshot).toHaveBeenLastCalledWith({hostId:'88',limit:3});
   const request={hostId:'88',harness:'codex',name:'n',cwd:'/work',inputId:'one'};
   expect((await fetch(base+'/api/fleet/create',{method:'POST',body:JSON.stringify({...request,profileId:'admin'})})).status).toBe(400);expect(service.create).not.toHaveBeenCalled();
   const response=await fetch(base+'/api/fleet/create',{method:'POST',body:JSON.stringify(request)});expect(response.status).toBe(202);expect((await response.json()).state).toBe('unknown');expect(service.create).toHaveBeenCalledTimes(1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
