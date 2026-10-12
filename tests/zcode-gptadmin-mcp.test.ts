import {describe,it,expect} from 'vitest';
import {configuredGptAdminMcp} from '../src/adapters/zcode-gptadmin-mcp.js';
const config={type:'http',url:'https://tenant.gptadmin.bezrabotnyi.com/mcp',headers:{Authorization:'synthetic-user-token'}};
const user=()=>({name:'GPTAdmin',scope:'user',enabled:true,config});
const managed=(name:string,credential:string)=>({name,scope:'user',enabled:true,config:{type:'http',url:`https://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/${name.toLowerCase()}-zcode100/mcp`,headers:{Authorization:credential}}});
describe('native ZCode GPTAdmin create-time binding (fast unit, expected1/max5s)',()=>{
 it('preserves namespace and configured credential while isolating each session',()=>{
  const result=configuredGptAdminMcp({servers:[user(),{name:'unrelated',scope:'user',enabled:true,config}]},'/own');
  expect(result).toEqual([{name:'GPTAdmin',type:'http',url:config.url,headers:[{name:'Authorization',value:'synthetic-user-token'}],isolation:'session'}]);
 });
 it('disabled workspace override never re-enables the user connection',()=>{
  expect(configuredGptAdminMcp({servers:[user(),{...user(),scope:'workspace',projectPath:'/own',enabled:false}]},'/own')).toEqual([]);
 });
 it('uses the exact workspace credential without combining user headers',()=>{
  const own={...user(),scope:'workspace',projectPath:'/own',config:{...config,headers:{Authorization:'synthetic-workspace-token'}}};
  expect(configuredGptAdminMcp({servers:[user(),own,{...own,projectPath:'/foreign'}]},'/own')[0]?.headers).toEqual([{name:'Authorization',value:'synthetic-workspace-token'}]);
 });
 it('refuses ambiguous scopes, malformed headers, oversized timeout and stdio activation',()=>{
  expect(()=>configuredGptAdminMcp({servers:[user(),user()]},'/own')).toThrow('ambiguous');
  for(const changed of [{headers:{Authorization:'bad\r\nheader'}},{timeoutMs:120001},{type:'stdio',command:'do-not-start'},{oauth:{type:'authorization_code'}}])
   expect(()=>configuredGptAdminMcp({servers:[{...user(),config:{...config,...changed}}]},'/own')).toThrow();
 });
 it('also passes the enabled migrated UserIO and AgentMemory with separate identities',()=>{
  const records=[user(),managed('UserIO','synthetic-userio-owner'),managed('agentmemory','synthetic-memory-owner')];
  const result=configuredGptAdminMcp({servers:records},'/own');
  expect(result.map(r=>r.name)).toEqual(['GPTAdmin','UserIO','agentmemory']);
  expect(result[1]?.headers).toEqual([{name:'Authorization',value:'synthetic-userio-owner'}]);
  expect(result[2]?.headers).toEqual([{name:'Authorization',value:'synthetic-memory-owner'}]);
  expect(result.every(r=>r.isolation==='session')).toBe(true);
 });
 it('an exact disabled workspace override shadows each migrated user entry',()=>{
  const source=managed('UserIO','synthetic-user');
  const disabled={...source,scope:'workspace',projectPath:'/own',enabled:false,config:{type:'http',url:'https://msg.example/mcp',headers:{Authorization:'synthetic-workspace'}}};
  expect(configuredGptAdminMcp({servers:[user(),source,disabled]},'/own').map(r=>r.name)).toEqual(['GPTAdmin']);
 });
 it('selects only the migrated exact workspace identity without merging header maps',()=>{
  const source=managed('agentmemory','synthetic-user');
  const own={...source,scope:'workspace',projectPath:'/own',config:{...source.config,headers:{Authorization:'synthetic-workspace'}}};
  expect(configuredGptAdminMcp({servers:[source,own,{...own,projectPath:'/foreign'}]},'/own')[0]?.headers).toEqual([{name:'Authorization',value:'synthetic-workspace'}]);
 });
 it('does not import direct, foreign-workspace, disabled or spoofed gateway definitions',()=>{
  const source=managed('UserIO','synthetic-user');
  const badURLs=['https://msg.example/mcp','https://u-f1102930.t.gptadmin.bezrabotnyi.com.evil.example/connection/a/mcp','http://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/a/mcp','https://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/a/mcp?identity=other','https://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/a%2fb/mcp','https://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/discard/../a/mcp','https://u-f1102930.t.gptadmin.bezrabotnyi.com/connection/%2e/a/mcp'];
  for(const url of badURLs)expect(configuredGptAdminMcp({servers:[{...source,config:{...source.config,url}}]},'/own')).toEqual([]);
  expect(configuredGptAdminMcp({servers:[{...source,scope:'workspace',projectPath:'/foreign'},{...source,enabled:false}]},'/own')).toEqual([]);
  const directOwn={...source,scope:'workspace',projectPath:'/own',config:{...source.config,url:'https://msg.example/mcp'}};
  expect(configuredGptAdminMcp({servers:[source,directOwn]},'/own')).toEqual([]);
 });
 it('refuses migrated scope ambiguity, OAuth substitution and any stdio startup',()=>{
  const source=managed('UserIO','synthetic-user');
  expect(()=>configuredGptAdminMcp({servers:[source,{...source,name:'userio'}]},'/own')).toThrow('ambiguous');
  for(const changed of [{headers:{Authorization:'bad\r\nheader'}},{type:'stdio',command:'never-start'},{type:'sse'},{oauth:{type:'authorization_code'}}])
   expect(()=>configuredGptAdminMcp({servers:[{...source,config:{...source.config,...changed}}]},'/own')).toThrow();
 });
 it('never merges same-name credentials from distinct configured tenants',()=>{
  const source=managed('UserIO','synthetic-user');
  const other={...source,config:{...source.config,url:source.config.url.replace('u-f1102930','u-aabbcc'),headers:{Authorization:'synthetic-other-tenant'}}};
  expect(()=>configuredGptAdminMcp({servers:[source,other]},'/own')).toThrow('ambiguous');
  const own={...other,scope:'workspace',projectPath:'/own'};
  const chosen=configuredGptAdminMcp({servers:[source,own]},'/own');
  expect(chosen).toHaveLength(1);
  expect(chosen[0]?.url).toBe(other.config.url);
  expect(chosen[0]?.headers).toEqual([{name:'Authorization',value:'synthetic-other-tenant'}]);
 });
});
