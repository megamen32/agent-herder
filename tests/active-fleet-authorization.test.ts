import {it,expect,vi} from 'vitest';
import {FleetDirectTransport} from '../src/mesh/fleet-direct-transport.js';
it('authorizes the exact materialized reader and still rejects arbitrary remote tools',async()=>{
 const transport=new FleetDirectTransport();const rpc=vi.fn(async()=>({sessions:[],hosts:[],partial:false}));(transport as any).rpc=rpc;
 await expect(transport.call('mcp:shell:server-44:AgentHerder','list_active_sessions_local',{})).resolves.toMatchObject({sessions:[]});
 expect(rpc).toHaveBeenCalledWith(expect.objectContaining({hostId:'server-44'}),'tools/call',{name:'list_active_sessions_local',arguments:{}},10000);
 await expect(transport.call('mcp:shell:server-44:AgentHerder','arbitrary',{})).rejects.toThrow('direct_tool_not_authorized');
});
