import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Integration; actual hook -> HTTP; catches discarded workdir/outside-launch paths. <1s/max5s.
describe('coordination hook actual workspace', () => {
  it('attributes edits to tool workdir while preserving outside-launch absolute paths', async () => {
    let received: any;
    const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received=JSON.parse(raw);res.setHeader('content-type','application/json');res.end('{}');});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try {
      const address=server.address() as {port:number};
      const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/coordination-hook.mjs',import.meta.url))],{env:{...process.env,AGENT_HERDER_URL:`http://127.0.0.1:${address.port}`},stdio:['pipe','pipe','pipe']});
      child.stdin.end(JSON.stringify({hook_event_name:'PostToolUse',session_id:'agent',cwd:'/launch',tool_name:'apply_patch',tool_input:{workdir:'/actual-project',patch:'*** Update File: src/main.ts\n*** Update File: /another-project/a.ts'}}));
      await new Promise<void>((r,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?r():reject(new Error(String(code))));});
      expect(received.cwd).toBe('/actual-project');
      expect(received.paths).toContain('/actual-project/src/main.ts');
      expect(received.paths).toContain('/another-project/a.ts');
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
});

it('observes a literal workdir in a composed Codex exec tool without executing its code',async()=>{
 let received:any;
 const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received=JSON.parse(raw);res.setHeader('content-type','application/json');res.end('{}')});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/coordination-hook.mjs',import.meta.url))],{env:{...process.env,AGENT_HERDER_URL:`http://127.0.0.1:${(server.address() as any).port}`},stdio:['pipe','pipe','pipe']});
  child.stdin.end(JSON.stringify({hook_event_name:'PostToolUse',session_id:'agent',cwd:'/launch',tool_name:'functions.exec',tool_input:{code:'await tools.exec_command({cmd:"pwd",workdir:"/actual-project"})'}}));
  await new Promise<void>((r,j)=>{child.on('error',j);child.on('exit',c=>c===0?r():j(Error(String(c))))});
  expect(received.cwd).toBe('/actual-project');expect(received.paths).toEqual([]);
 }finally{await new Promise<void>(r=>server.close(()=>r()))}
});
