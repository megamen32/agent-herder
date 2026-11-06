import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { HermesAdapter } from '/fixture/herder/dist/adapters/hermes/adapter.js';
const adapter = new HermesAdapter({gatewayTasks:false, hermesBin:'/home/roomhacker/.hermes/hermes-agent/venv/bin/hermes', jobProvider:'custom', jobReasoning:'low', jobToolsets:'terminal', jobTimeoutMs:60000, spawnJob:(cmd,args,opts)=>spawn(cmd,args,opts)});
const events=[];
adapter.subscribeEvents(event=>events.push(event));
const session = await adapter.createSession({name:'isolated-hermes-l13',cwd:'/work'});
const accepted = await adapter.sendMessage(session.id,{message:'Reply with the test token.'});
assert.equal(accepted.ok,true);
let state, transcript;
for(let i=0;i<120;i++) {
  await new Promise(r=>setTimeout(r,250));
  state=await adapter.getSession(session.id);
  if(state.status!=='running') break;
}
transcript=await adapter.getTranscript(session.id);
const result={session:session.id, status:state.status, transcript, accepted, events};
console.log(JSON.stringify(result));
await adapter.dispose();
assert.equal(state.status,'stopped');
assert.ok(events.some(event=>event.kind==='turn.completed' && event.nativeType==='cli-exit'));
assert.ok(transcript.includes('HERDER_TEST_MODEL_OK'));
