import {expect,it} from 'vitest';
import {SessionSupervisor} from '../src/session-supervisor.js';
// Focused integration expected1s/max5s: polling must not replace a verified model with a stale list label.
it('uses native selected model in quick ZCode details',async()=>{
 const base={id:'model-control-fixture',harness:'zcode',cwd:'/fixture',status:'idle',lastActivity:new Date().toISOString()};
 const adapter={type:'zcode',name:'fixture',listSessions:async()=>[{...base,model:'zai/GLM-5.3-Flash'}],getSession:async()=>({...base,model:'zai/GLM-5.3-Flash$high'}),getSessionMessages:async()=>[{id:'fixture-message',role:'user',text:'test',parts:[{type:'text',text:'test'}]}]};
 const supervisor=new SessionSupervisor(new Map([['zcode',adapter as any]]),{} as any);
 expect((await supervisor.getSessionDetails('zcode',base.id,{quick:true,limit:1})).session.model).toBe('zai/GLM-5.3-Flash$high');
});
