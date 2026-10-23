import {it,expect} from 'vitest';
import WebSocket,{WebSocketServer} from 'ws';
import {ZcodeAppServerClient,encodeZcodeValue,decodeZcodeValue} from '../src/adapters/zcode-protocol.js';
const frame=(h:unknown,p:unknown)=>{const b=Buffer.concat([encodeZcodeValue(h),encodeZcodeValue(p)]),f=Buffer.alloc(13+b.length);f[0]=1;f.writeUInt32BE(b.length,9);b.copy(f,13);return f;};
it('reuses native channel framing over official WebSocket without spawning or claiming the native server',async()=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(r=>server.once('listening',r));let calls=0;
 server.on('connection',s=>{s.send(frame([200],undefined));s.on('message',raw=>{calls++;const b=Buffer.from(raw as Buffer).subarray(13),h=decodeZcodeValue(b);const args=decodeZcodeValue(b,h.offset).value as any[];expect(h.value).toMatchObject([100,1,'zcode-agent','readSession']);expect(args[0]).toMatchObject({sessionId:'known',runtimePolicy:'existing-only'});s.send(frame([201,1],{session:{sessionId:'known'},runtime:{activeTurnId:'current'}}));});});
 const client=new ZcodeAppServerClient({command:'must-not-start-native',connectWebSocket:async()=>new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`)});
 try{await client.start();expect(await client.callIfReady('zcode-agent','readSession',[{sessionId:'known',runtimePolicy:'existing-only'}])).toMatchObject({runtime:{activeTurnId:'current'}});expect(client.getOwnedProcessId()).toBeUndefined();expect(calls).toBe(1);}
 finally{await client.close();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
it('does not reconnect or replay a V4 command when its admission response is lost',async()=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise<void>(r=>server.once('listening',r));let calls=0,connections=0;
 server.on('connection',s=>{connections++;s.send(frame([200],undefined));s.on('message',()=>{calls++;s.close();});});
 const client=new ZcodeAppServerClient({command:'must-not-run',connectWebSocket:async()=>new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`)});
 try{await client.start();await expect(client.call('zcode-agent','sendConversationCommandV4',[{envelope:{commandId:'fixed'}}])).rejects.toThrow('do not replay');expect(calls).toBe(1);expect(connections).toBe(1);}
 finally{await client.close();for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));}
});
