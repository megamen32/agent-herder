import {it,expect,vi} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/server';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';

it('keeps one native process generation across independently registered MCP connections despite wall-clock drift (fast unit; expected1s,max10s)',async()=>{
 const capture=()=>{let call:()=>Promise<any>;const server={registerTool:(_name:string,_schema:unknown,handler:()=>Promise<any>)=>{call=handler;}} as unknown as McpServer;registerFleetNodeTools(server,{adapters:new Map()});return async()=>JSON.parse((await call!()).content[0].text);};
 const first=await capture()();const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+3600000);const uptime=vi.spyOn(process,'uptime').mockReturnValue(0);
 try{const second=await capture()();expect(second.generation).toBe(first.generation);expect(second.hostId).toBe(first.hostId);expect(second.nativeUser).toBe(first.nativeUser);expect(second.createHarnesses).toEqual([]);}finally{clock.mockRestore();uptime.mockRestore();}
});
