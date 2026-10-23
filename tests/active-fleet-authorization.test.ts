import {it,expect,vi} from 'vitest';
import {FleetDirectTransport} from '../src/mesh/fleet-direct-transport.js';
it('authorizes the exact materialized reader and still rejects arbitrary remote tools',async()=>{
 const transport=new FleetDirectTransport();const rpc=vi.fn(async()=>({sessions:[],hosts:[],partial:false}));(transport as any).rpc=rpc;
 await expect(transport.call('mcp:shell:server-44:AgentHerder','list_active_sessions_local',{})).resolves.toMatchObject({sessions:[]});
 expect(rpc).toHaveBeenCalledWith(expect.objectContaining({hostId:'server-44'}),'tools/call',{name:'list_active_sessions_local',arguments:{}},10000);
 await expect(transport.call('mcp:shell:server-44:AgentHerder','arbitrary',{})).rejects.toThrow('direct_tool_not_authorized');
});
import {createServer} from 'node:http';
import {hostname,userInfo} from 'node:os';
it('uses one bounded materialized owner HTTP read without MCP initialization',async()=>{
 const requests:string[]=[];const server=createServer((req,res)=>{requests.push(req.method+' '+req.url);if(req.method!=='GET'){res.writeHead(405);res.end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sessions:[],hosts:[{hostId:hostname(),state:'available'}],partial:false}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address()as any).port;
 try{const transport=new FleetDirectTransport([{hostId:hostname(),sshHost:'127.0.0.1',nativeUser:userInfo().username,port,python:'/usr/bin/python3'}],1000);const x=await transport.call(`mcp:shell:${hostname()}:AgentHerder`,'list_active_sessions_local',{});expect(x).toMatchObject({sessions:[],partial:false});expect(requests).toEqual(['GET /api/sessions/active?runtimeHostId='+encodeURIComponent(hostname())]);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
