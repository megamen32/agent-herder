import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, writeFile} from 'node:fs/promises';
import {FastAgentFileAdapter} from '/app/dist/adapters/fast-agent.js';

const requests=[];
const model=http.createServer(async(req,res)=>{
  let body=''; for await(const chunk of req) body+=chunk;
  requests.push({path:req.url,body:JSON.parse(body)});
  const data=JSON.parse(body), id='fixture-'+requests.length;
  if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
  if(data.stream){
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:'assistant',content:'HERDER_TEST_MODEL_OK'},{}]) res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:0,model:data.model,choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  }else {res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,object:'chat.completion',created:0,model:data.model,choices:[{index:0,message:{role:'assistant',content:'HERDER_TEST_MODEL_OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const endpoint=`http://127.0.0.1:${model.address().port}/v1`;
await mkdir('/work/project',{recursive:true});await mkdir('/work/fast-home',{recursive:true});
await writeFile('/work/project/fast-agent.config.yaml',`openai:\n  base_url: ${endpoint}\n  api_key: test-only\n`);
const adapter=new FastAgentFileAdapter({home:'/work/fast-home',cwd:'/work/project',fastAgentBin:process.env.TEST_FAST_AGENT_BIN});
try{
 await adapter.init(); const sessions=[];
 for(let i=0;i<2;i++){
   const created=await adapter.createSession({name:`native-ci-${i}`,cwd:'/work/project',model:'openai.herder-test'});
   assert.ok(created.id); assert.equal(created.cwd, '/work/project'); const message=`HERDER_NATIVE_FAST_AGENT_${i}`;
   const send=await adapter.sendMessage(created.id,{message});
   assert.equal(send.ok,true,JSON.stringify(send));
   const transcript=await adapter.getTranscript(created.id);
   const raw=await adapter.getRawTranscript(created.id);
   assert.ok(transcript?.includes(message),`missing input ${i}: ${transcript}`);
   assert.ok(transcript?.includes('HERDER_TEST_MODEL_OK'),`missing answer ${i}: ${transcript}`);
   assert.equal(raw?.complete,true);
   sessions.push({id:created.id,nativeId:created.meta?.nativeSessionId,message,send,transcript,raw:JSON.parse(raw.bytes.toString())});
 }
 assert.notEqual(sessions[0].id,sessions[1].id);
 for(let i=0;i<2;i++) assert.ok(!sessions[i].transcript.includes(sessions[1-i].message),'transcripts crossed sessions');
 const listed=await adapter.listSessions();
 for(const s of sessions) assert.ok(listed.some(x=>x.id===s.id));
 assert.ok(requests.length>=2 && requests.every(x=>x.path==='/v1/chat/completions'));
 console.log(JSON.stringify({ok:true,scope:'private network namespace, isolated filesystem, local fixture only',endpoint,project:'/work/project',version:process.env.TEST_FAST_AGENT_VERSION,sessions,listed:listed.map(s=>s.id),requests},null,2));
}finally{model.close();}
