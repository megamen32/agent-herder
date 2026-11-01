import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { CHATGPT_LIST_API_SCRIPT, chatgptMessagesApiScript } from '../src/adapters/browser-chat-api-scripts.js';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(status=429) {
 let now=1_000, calls=0;
 const context=vm.createContext({location:{origin:'https://chatgpt.com'},Date:{now:()=>now},TextEncoder,crypto:webcrypto,fetch:async(url:string)=>{
  calls++;
  if(url==='/api/auth/session')return {ok:true,json:async()=>({accessToken:'fixture',account:{id:'fixture'}})};
  return {ok:status===200,status,json:async()=>({items:[],conversation_id:id,messages:[]})};
 }});
 return {run:(script:string)=>vm.runInContext('('+script+')()',context),calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
}
describe('shared ChatGPT read cooldown',()=>{
 it('list 429 blocks list and history before any auth/network fetch',async()=>{
  const f=fixture();expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('list_http_429');expect(f.calls()).toBe(2);
  expect((await f.run(chatgptMessagesApiScript(id))).error).toBe('read_cooldown');
  expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('read_cooldown');expect(f.calls()).toBe(2);
 });
 it('history 429 blocks list and history and permits one retry after 15 minutes',async()=>{
  const f=fixture();expect((await f.run(chatgptMessagesApiScript(id))).error).toBe('history_http_429');
  await f.run(CHATGPT_LIST_API_SCRIPT);expect(f.calls()).toBe(2);
  f.advance(900_001);await f.run(CHATGPT_LIST_API_SCRIPT);expect(f.calls()).toBe(4);
 });
 it('does not change successful reads',async()=>{
  const f=fixture(200);expect((await f.run(CHATGPT_LIST_API_SCRIPT)).chats).toEqual([]);
  expect((await f.run(chatgptMessagesApiScript(id))).messages).toEqual([]);expect(f.calls()).toBe(4);
 });
});
