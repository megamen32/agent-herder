import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { SessionImageStore } from '../src/session-images.js';
import { requestModelChange } from '../src/web-ui/model-chip.js';
import { createWebServer } from '../src/web/server.js';
// Focused integration expected1s/max5s: production upload/message/serve routes, no native turns.
it('routes uploaded images into native input and rejects cross-chat reuse', async () => {
 const directory=await mkdtemp(join(tmpdir(),'herder-image-http-'));
 const sendMessage=vi.fn(async()=>({ok:true,admitted:true}));
 const changeModel=vi.fn(async()=>({ok:true}));
 const server=createWebServer({sessionImageStore:new SessionImageStore(directory), adapters:new Map([['zcode',{controlCapabilities:{imageInput:true}} as any]]), converter:{} as any, supervisor:{getSession:async()=>({id:'a'}),sendMessage,changeModel} as any});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 try {
  const response=await post('/api/session-images',{harness:'zcode',sessionId:'a',fileName:'tiny.png',mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmcAAAAASUVORK5CYII='});
  expect(await requestModelChange(((path,init)=>fetch(origin+path,init)) as typeof fetch,'zcode','a','account:zai-individual-coding-plan/GLM-5.3-Flash$high')).toEqual({ok:true});
  expect(changeModel).toHaveBeenCalledWith('zcode','a','account:zai-individual-coding-plan/GLM-5.3-Flash$high');
  expect(response.status).toBe(200);const image=await response.json() as {id:string;url:string};
  const content=await fetch(origin+image.url);expect(content.headers.get('content-type')).toBe('image/png');expect((await content.arrayBuffer()).byteLength).toBeGreaterThan(8);
  expect((await post('/api/sessions/zcode/b/message',{message:'describe',imageIds:[image.id]})).status).toBe(400);
  expect(sendMessage).not.toHaveBeenCalled();
  expect((await post('/api/sessions/zcode/a/message',{message:'describe',imageIds:[image.id]})).status).toBe(200);
  expect(sendMessage.mock.calls[0]).toEqual(['zcode','a',expect.objectContaining({images:[expect.objectContaining({id:image.id,fileName:'tiny.png',path:join(directory,`${image.id}.png`)})]})]);
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
