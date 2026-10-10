import {describe,it,expect} from 'vitest';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import type {ZcodeClientLike} from '../src/adapters/zcode-protocol.js';
class DraftClient implements ZcodeClientLike {
 calls:{channel:string;method:string;args:unknown[]}[]=[]; title=''; failRename=false;
 async start(){} async close(){} listen(){return()=>{}};
 async call(channel:string,method:string,args:unknown[]){
  this.calls.push({channel,method,args});
  const session={sessionId:'own-draft',title:this.title,workspace:{workspacePath:'/workspace'},status:'idle',mode:'yolo',createdAt:1,updatedAt:1};
  if(method==='initialize')return {available:true};
  if(method==='createSession'||method==='readSession')return {session,settings:{permission:{mode:'yolo'}},runtime:{eventSeq:0,pendingRequestIds:[]},messages:[]};
  if(method==='readSessionEvents')return {events:[]};
  if(channel==='zcode-task'&&method==='renameTask'){
   if(this.failRename)throw Error('metadata rename rejected');
   this.title=(args[0] as {title:string}).title;return {title:this.title};
  }
  throw Error('Unexpected '+channel+':'+method);
 }
}
describe('ZCode model-free draft naming',()=>{
 it('names the exact newly created native draft before readback without prompt admission',async()=>{
  const client=new DraftClient();const adapter=new ZcodeAdapter({client,cwd:'/workspace'});
  try{const created=await adapter.createSession({name:'Fleet draft',cwd:'/workspace',fullAccess:true});
   expect(client.calls.find(x=>x.method==='renameTask')).toMatchObject({channel:'zcode-task',args:[{taskId:created.id,title:'Fleet draft',workspacePath:'/workspace'}]});
   expect(await adapter.getSession(created.id)).toMatchObject({id:created.id,title:'Fleet draft'});
   expect(client.calls.some(x=>/sendPrompt|sendConversationInput/.test(x.method))).toBe(false);
  }finally{await adapter.dispose();}
 });
 it('retains the exact created address and native title after a rejected metadata command without replay',async()=>{
  const client=new DraftClient();client.failRename=true;const adapter=new ZcodeAdapter({client,cwd:'/workspace'});
  try{const created=await adapter.createSession({name:'Fleet draft',cwd:'/workspace',fullAccess:true});
   expect(created).toMatchObject({id:'own-draft',title:'Untitled ZCode session',meta:{titleRenameConfirmed:false,requestedTitle:'Fleet draft'}});
   expect(await adapter.getSession(created.id)).toMatchObject({id:'own-draft'});
   expect(client.calls.filter(x=>x.method==='createSession')).toHaveLength(1);
   expect(client.calls.some(x=>/sendPrompt|sendConversationInput/.test(x.method))).toBe(false);
  }finally{await adapter.dispose();}
 });
});
