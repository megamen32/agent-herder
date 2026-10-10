import {describe,it,expect} from 'vitest';
import {configuredGptAdminMcp} from '../src/adapters/zcode-gptadmin-mcp.js';
const config={type:'http',url:'https://tenant.gptadmin.bezrabotnyi.com/mcp',headers:{Authorization:'synthetic-user-token'}};
const user=()=>({name:'GPTAdmin',scope:'user',enabled:true,config});
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
});
