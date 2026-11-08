import { describe, it, expect, vi, afterEach } from 'vitest';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { CHATGPT_LIST_API_SCRIPT, chatgptMessagesApiScript } from '../src/adapters/browser-chat-api-scripts.js';
import { ChatGptMacCdpDriver } from '../src/adapters/chatgpt-mac-cdp-driver.js';
import { CHATGPT_CREATE_SCOPE_SCRIPT } from '../src/adapters/browser-chat-new-page.js';
import { getChatGptBayesBackoff, BAYES_TARGET_CHATGPT_HISTORY } from '../src/adapters/chatgpt-bayes-backoff.js';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(status=429, retryAfter=null) {
 let now=1_000, calls=0;
 const context=vm.createContext({location:{origin:'https://chatgpt.com'},Date:{now:()=>now},TextEncoder,crypto:webcrypto,fetch:async(url:string)=>{
  calls++;
  if(url==='/api/auth/session')return {ok:true,json:async()=>({accessToken:'fixture',account:{id:'fixture'}})};
  return {ok:status===200,status,json:async()=>({items:[],conversation_id:id,messages:[]}),headers:{get:(h:string)=>h==='retry-after'&&retryAfter?String(retryAfter):null}};
 }});
 return {run:(script:string)=>vm.runInContext('('+script+')()',context),calls:()=>calls,advance:(ms:number)=>{now+=ms;}};
}
describe('shared ChatGPT read cooldown',()=>{
 it('list 429 blocks list and history before any auth/network fetch',async()=>{
  const f=fixture();expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('list_http_429');expect(f.calls()).toBe(2);
  expect((await f.run(chatgptMessagesApiScript(id))).error).toBe('read_cooldown');
  expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('read_cooldown');expect(f.calls()).toBe(2);
 });
 it('history 429 blocks list and history and permits one retry after the 60s default backoff',async()=>{
  const f=fixture();expect((await f.run(chatgptMessagesApiScript(id))).error).toBe('history_http_429');
  await f.run(CHATGPT_LIST_API_SCRIPT);expect(f.calls()).toBe(2);
  f.advance(60_001);await f.run(CHATGPT_LIST_API_SCRIPT);expect(f.calls()).toBe(4);
 });
 it('does not change successful reads',async()=>{
  const f=fixture(200);expect((await f.run(CHATGPT_LIST_API_SCRIPT)).chats).toEqual([]);
  expect((await f.run(chatgptMessagesApiScript(id))).messages).toEqual([]);expect(f.calls()).toBe(4);
 });
});


describe('ChatGPT 429 Retry-After', () => {
 it('respects Retry-After when present',async()=>{
  const f=fixture(429,120);
  expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('list_http_429');
  f.advance(60_001); // default 60s window has elapsed but Retry-After=120 still in force
  expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('read_cooldown');
  expect(f.calls()).toBe(2);
  f.advance(60_001); // 120s total
  await f.run(CHATGPT_LIST_API_SCRIPT);
  expect(f.calls()).toBe(4);
 });
 it('caps Retry-After at 5 minutes',async()=>{
  const f=fixture(429,9999);
  expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe('list_http_429');
  f.advance(300_001);
  await f.run(CHATGPT_LIST_API_SCRIPT);
  expect(f.calls()).toBe(4);
 });
});

describe('foreground driver account history cooldown', () => {
 afterEach(() => vi.restoreAllMocks());
 let sequence = 0;
 const json = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```';
 function driverFixture(scope: string, result: unknown) {
  const calls: Array<{name: string; source: string}> = [];
  const state = { observedScope: scope, cooldownUntil: 0, result };
  const driver = new ChatGptMacCdpDriver({ async call(name, args = {}) {
   const source = String(args.function ?? ''); calls.push({ name, source });
   if (name === 'list_pages') return `7: ChatGPT (https://chatgpt.com/c/${id})\n8: ChatGPT (https://chatgpt.com/c/${id})`;
   if (source === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope: state.observedScope });
   if (source.includes('/backend-api/conversations/')) return json(await (typeof state.result === 'function' ? state.result() : state.result));
   if (source.includes('cooldownUntil')) return json({ cooldownUntil: state.cooldownUntil });
   return json({ owned: false });
  } }, 7, 0, scope);
  return { driver, calls, state };
 }
 function account() { return (++sequence).toString(16).padStart(64, '0'); }

 it('honors an existing Bayesian history cooldown before tabs or auth', async () => {
  const f = driverFixture(account(), { messages: [] });
  const bayes = getChatGptBayesBackoff();
  vi.spyOn(bayes, 'cooldownUntilMs').mockImplementation(target => target === BAYES_TARGET_CHATGPT_HISTORY ? Date.now() + 60000 : 0);
  await expect(f.driver.getMessages(id)).rejects.toThrow('read_cooldown');
  await expect(f.driver.getRawConversation(id)).rejects.toThrow('read_cooldown');
  expect(f.calls).toEqual([]);
 });

 it('shares 429 across same-account driver tabs, preserves long Retry-After, and does not block another account', async () => {
  const scope = account(), now = Date.now();
  const a = driverFixture(scope, { error: 'history_http_429', trace: [
   { operation: 'conversation_read', http_status: 429, retry_after_s: 9999 },
  ] });
  await expect(a.driver.getMessages(id)).rejects.toThrow('history_http_429');
  expect(a.calls.filter(call => call.source === CHATGPT_CREATE_SCOPE_SCRIPT)).toHaveLength(1);
  const b = driverFixture(scope, { messages: [] });
  vi.spyOn(Date, 'now').mockReturnValue(now + 2000000); // beyond estimator cap, below server Retry-After
  await expect(b.driver.getMessages(id)).rejects.toThrow('read_cooldown');
  expect(b.calls).toEqual([]);
  const other = driverFixture(account(), { messages: [{ id: 'fresh', role: 'user', text: 'fresh result' }] });
  await expect(other.driver.getMessages(id)).resolves.toMatchObject([{ id: 'fresh' }]);
  expect(other.calls.filter(call => call.source === CHATGPT_CREATE_SCOPE_SCRIPT)).toHaveLength(2);
  vi.mocked(Date.now).mockReturnValue(now + 10000000);
  await expect(b.driver.getMessages(id)).resolves.toEqual([]);
 });

 it('does not try an alternate tab after observing page-local cooldown', async () => {
  const f = driverFixture(account(), { error: 'read_cooldown' });
  await expect(f.driver.getMessages(id)).rejects.toThrow('read_cooldown');
  expect(f.calls.filter(call => call.source.includes('/backend-api/conversations/'))).toHaveLength(1);
  expect(f.calls.filter(call => call.source === CHATGPT_CREATE_SCOPE_SCRIPT)).toHaveLength(1);
 });

 it('promotes a known page cooldown before auth or history and blocks a fresh driver of the same account', async () => {
  const scope = account(), f = driverFixture(scope, { messages: [] });
  f.state.cooldownUntil = Date.now() + 7200000;
  await expect(f.driver.getMessages(id)).rejects.toThrow('read_cooldown');
  expect(f.calls.filter(call => call.source === CHATGPT_CREATE_SCOPE_SCRIPT)).toHaveLength(0);
  expect(f.calls.filter(call => call.source.includes('/backend-api/conversations/'))).toHaveLength(0);
  const otherTab = driverFixture(scope, { messages: [] });
  await expect(otherTab.driver.getMessages(id)).rejects.toThrow('read_cooldown');
  expect(otherTab.calls).toEqual([]);
 });

 it('coalesces identical concurrent reads only while in flight and retains fresh auth guards', async () => {
  let release!: (value: unknown) => void;
  const response = new Promise(resolve => { release = resolve; });
  const f = driverFixture(account(), () => response);
  const a = f.driver.getMessages(id), b = f.driver.getMessages(id);
  release({ messages: [{ id: 'first', role: 'user', text: 'fresh first' }] });
  expect(await Promise.all([a, b])).toMatchObject([[{ id: 'first' }], [{ id: 'first' }]]);
  expect(f.calls.filter(call => call.source.includes('/backend-api/conversations/'))).toHaveLength(1);
  expect(f.calls.filter(call => call.source === CHATGPT_CREATE_SCOPE_SCRIPT)).toHaveLength(2);
  f.state.result = { messages: [{ id: 'next', role: 'assistant', text: 'fresh next' }] };
  await expect(f.driver.getMessages(id)).resolves.toMatchObject([{ id: 'next' }]);
  expect(f.calls.filter(call => call.source.includes('/backend-api/conversations/'))).toHaveLength(2);
 });

 it('never returns data after account mismatch or reuses a rejected in-flight read', async () => {
  const scope = account(), f = driverFixture(scope, { messages: [] });
  f.state.observedScope = account();
  await expect(f.driver.getMessages(id)).rejects.toThrow('scope mismatch');
  expect(f.calls.filter(call => call.source.includes('/backend-api/conversations/'))).toHaveLength(0);
  f.state.observedScope = scope;
  f.state.result = () => { f.state.observedScope = account(); return { messages: [{ id: 'private', role: 'user', text: 'secret' }] }; };
  await expect(f.driver.getMessages(id)).rejects.toThrow('scope mismatch');
  f.state.observedScope = scope;
  f.state.result = { messages: [{ id: 'fresh', role: 'user', text: 'ok' }] };
  await expect(f.driver.getMessages(id)).resolves.toMatchObject([{ id: 'fresh' }]);
 });
});
