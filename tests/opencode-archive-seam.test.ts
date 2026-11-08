import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { serveOpenCodeAhap } from '../src/ahap-opencode-runner.js';

it('archives exact native v2 session with the documented PATCH, without retry', async () => {
  const calls: Array<{method?:string;url?:string;body:string}> = [];
  const server = createServer(async (req,res) => {
    let body=''; for await (const chunk of req) body+=chunk;
    calls.push({method:req.method,url:req.url,body}); res.writeHead(204); res.end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); if (!address || typeof address==='string') throw Error('address');
  try {
    const adapter=new OpenCodeAdapter({baseUrl:`http://127.0.0.1:${address.port}`,protocol:'v2'});
    expect(await (adapter as any).archiveSession('ses_exact1')).toMatchObject({ok:true});
    expect(calls).toEqual([{method:'PATCH',url:'/api/session/ses_exact1',body:'{"archived":true}'}]);
  } finally {server.close();}
});

it('exposes archive for v2, refuses unsupported v22 and reports uncertain mutation once', async () => {
  async function run(family:'v2'|'v22') {
    let calls=0; const input=new PassThrough(),output=new PassThrough(); let raw='';
    output.on('data',c=>raw+=c.toString());
    const adapter={archiveSession:async()=>{calls++;throw Error('unknown');}};
    const done=serveOpenCodeAhap(adapter as any,input,output,family);
    input.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{harness:'opencode',ahapVersion:'0.1'}},{jsonrpc:'2.0',id:2,method:'archiveSession',params:{id:'ses_exact1'}}].map(JSON.stringify).join('\n')+'\n');
    await done; return {replies:raw.trim().split('\n').map(x=>JSON.parse(x)),calls};
  }
  const v2=await run('v2'); expect(v2.replies[0].result.capabilities.methods).toContain('archiveSession');
  expect(v2.replies[1].error.data.outcome).toBe('unknown'); expect(v2.calls).toBe(1);
  const v22=await run('v22'); expect(v22.replies[0].result.capabilities.methods).not.toContain('archiveSession'); expect(v22.replies[1].error.code).toBe(-32601); expect(v22.calls).toBe(0);
});
