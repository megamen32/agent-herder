import {it,expect} from 'vitest';
import {ChatGptMacCdpDriver} from '../src/adapters/chatgpt-mac-cdp-driver.js';
import type {ChromePageTools} from '../src/adapters/mac-mini-chrome-transport.js';
const json=(v:unknown)=>'```json\n'+JSON.stringify(v)+'\n```';
it('selects each account on a shared listing, survives renumbering, and never closes the other account',async()=>{
 const scopes=['a'.repeat(64),'b'.repeat(64)];let ids=[1,2];const writes:number[]=[];const names=new Map<number,string>();
 const tools:ChromePageTools={call:async(name,args={})=>{
  if(name==='list_pages')return ids.map((id,i)=>`${id}: Account${i} (https://chatgpt.com/?herder_owned=chatgpt)`).join('\n');
  if(name==='close_page'||name==='new_page'){writes.push(Number(args.pageId));throw Error('must reuse exact account');}
  if(name==='evaluate_script'){
   const i=ids.indexOf(Number(args.pageId));const script=String(args.function);
   if(/window\.name\s*=\s*[^=]/.test(script)){names.set(ids[i]!,scopes[i]!);return json({owned:true});}
   if(script.includes('herder-owned:'))return json({owned:script.includes(names.get(ids[i]!)??'no-marker')});
   return json({scope:scopes[i],chats:[]});
  }
  throw Error('unexpected '+name);
 }};
 for(const swap of [false,true]){
  if(swap){ids=[20,10];names.clear();}
  const a=new ChatGptMacCdpDriver(tools,undefined,0,scopes[0]);
  const b=new ChatGptMacCdpDriver(tools,undefined,0,scopes[1]);
  await a.verifyPinnedAccountScope();await b.verifyPinnedAccountScope();
  expect(a.getAccountScope()).toBe(scopes[0]);expect(b.getAccountScope()).toBe(scopes[1]);
 }
 expect(writes).toEqual([]);
});
