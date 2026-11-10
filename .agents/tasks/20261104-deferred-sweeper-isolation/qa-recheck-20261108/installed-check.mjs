
import assert from 'node:assert/strict';
const base='file:///home/roomhacker/agents-projects/.fleet-candidate/releases/3b2cf4d64df8043993847947e160dd75d99ed471/dist/';
const {DeferredDeliverySweeper}=await import(base+'deferred-delivery-sweeper.js');
const {deferredMessages}=await import(base+'deferred-messages.js');
const results=[];
async function reset(){ for(const m of await deferredMessages.listAll()) await deferredMessages.remove([m.id]); delete process.env.AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE; }
function adapter(harness,calls,receipt={ok:true},status='idle'){return {type:harness,getSession:async id=>({id,harness,status,lastActivity:'2020-01-01T00:00:00Z',needsPermission:false,cwd:'/tmp'}),sendMessage:async(id,input)=>{calls.push({harness,id,input});return receipt;}};}
async function run(name,fn){await reset();await fn();results.push({name,pass:true});}
for(const order of ['legacy-first','legacy-last'])await run(order,async()=>{
 const calls=[];const a=adapter('opencode',calls);
 if(order==='legacy-first')await deferredMessages.add('target','legacy');
 const eligible=await deferredMessages.add('target','eligible','opencode');
 if(order==='legacy-last')await deferredMessages.add('target','legacy');
 const s=new DeferredDeliverySweeper(new Map([['opencode',a]]));
 assert.deepEqual(await s.sweep(),{delivered:1,kept:0,skipped:1});
 assert.equal(calls.length,1);assert.equal(calls[0].input.message,'eligible');assert.equal(calls[0].input.inputId,'deferred-'+eligible.id);
 assert.deepEqual((await deferredMessages.listAll()).map(x=>x.message),['legacy']);
});
await run('same-native-id-different-harness',async()=>{
 const calls=[];await deferredMessages.add('target','one','opencode');await deferredMessages.add('target','two','codex');
 const s=new DeferredDeliverySweeper(new Map([['opencode',adapter('opencode',calls)],['codex',adapter('codex',calls)]]));
 assert.equal((await s.sweep()).delivered,2);assert.deepEqual(calls.map(x=>[x.harness,x.input.message]),[['opencode','one'],['codex','two']]);
});
await run('ineligible-does-not-spend-budget',async()=>{
 process.env.AGENT_HERDER_DEFERRED_SWEEP_SESSIONS_PER_CYCLE='1';const calls=[];
 await deferredMessages.add('legacy','old');await deferredMessages.add('unsupported','unsupported','zcode');await deferredMessages.add('target','eligible','opencode');
 assert.deepEqual(await new DeferredDeliverySweeper(new Map([['opencode',adapter('opencode',calls)]])).sweep(),{delivered:1,kept:0,skipped:2});
 assert.equal(calls.length,1);
});
await run('definite-rejection-retained',async()=>{
 const calls=[];await deferredMessages.add('target','one','opencode');
 assert.deepEqual(await new DeferredDeliverySweeper(new Map([['opencode',adapter('opencode',calls,{ok:false,notSubmitted:true})]])).sweep(),{delivered:0,kept:1,skipped:0});assert.equal((await deferredMessages.listAll()).length,1);
});
for(const [name,receipt] of [['accepted-no-replay',{ok:true}],['unknown-no-replay',{ok:false,admissionUnknown:true}]])await run(name,async()=>{
 const calls=[];await deferredMessages.add('target','one','opencode');const s=new DeferredDeliverySweeper(new Map([['opencode',adapter('opencode',calls,receipt)]]));await s.sweep();await s.sweep();assert.equal(calls.length,1);assert.equal((await deferredMessages.listAll()).length,0);
});
for(const status of ['running','needs_input'])await run('hold-'+status,async()=>{
 const calls=[];await deferredMessages.add('target','one','opencode');assert.equal((await new DeferredDeliverySweeper(new Map([['opencode',adapter('opencode',calls,{ok:true},status)]])).sweep()).skipped,1);assert.equal(calls.length,0);
});
console.log(JSON.stringify({count:results.length,results,realDeliveries:0,scope:'installed JS with isolated store and fake adapters'}));
