import {describe, it, expect} from 'vitest';
import {createHash} from 'node:crypto';
import {validateZcodeCanaryProof} from './native/installed-zcode-proof.js';
const now=Date.parse('2026-11-09T00:00:00Z');
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const pairs=[{prompt:'first unique prompt',token:'FIRST'},{prompt:'second unique prompt',token:'SECOND'}];
const expected={nativeId:'sess-owned',cwd:'/owned/project',hostId:'server-owner',createModel:'provider/model$enabled',pairs,now};
function fixture(){
  // Sanitized schema of the real native v5 success, without private transcript text.
  const raw={session:{sessionId:expected.nativeId,status:'idle',model:{providerId:'provider',modelId:'model'},workspace:{workspacePath:expected.cwd,workspaceIdentity:expected.cwd}},
    settings:{model:{current:{providerId:'provider',modelId:'model',options:{reasoningLevel:'enabled'}}}},
    projection:{sessionId:expected.nativeId,status:'idle',currentTurnId:'turn-second',pendingPermissions:[],activeToolCalls:[],backgroundJobs:[]},
    runtime:{eventSeq:10,stateRevision:5,pendingRequestIds:[]},messages:pairs.flatMap((pair,i)=>[
      {info:{messageId:'user-'+i,sessionId:expected.nativeId,role:'user'},parts:[{type:'text',text:pair.prompt}]},
      {info:{messageId:'assistant-'+i,parentMessageId:'user-'+i,sessionId:expected.nativeId,role:'assistant',
        semantics:{origin:'agent_runtime',kind:'assistant_response'},finish:'stop',time:{created:now-1000,completed:now-500}},parts:[{type:'text',text:pair.token}]},
    ])};
  const supervisor={pid:123,generation:2,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+15000).toISOString(),tasks:[]};
  const text=JSON.stringify(raw);
  return {capability:'official-server-canary',source:'zcode-native-session-read+official-supervisor',native_session_id:expected.nativeId,
    cwd:expected.cwd,host_id:expected.hostId,create_model:expected.createModel,canonical_status:'idle',observed_at:new Date(now).toISOString(),official_pid:123,official_generation:2,
    official_before:structuredClone(supervisor),official_after:structuredClone(supervisor),
    completed_message_ids:['assistant-0','assistant-1'],user_message_ids:['user-0','user-1'],native_transcript_sha256:hash(text),
    native_transcript_receipt:{complete:true,source:{kind:'native-api',location:'zcode app-server session/read',format:'json'},timestampCoverage:'native',text}};
}
function mutateNative(p:ReturnType<typeof fixture>,fn:(raw:any)=>void){const raw=JSON.parse(p.native_transcript_receipt.text);fn(raw);p.native_transcript_receipt.text=JSON.stringify(raw);p.native_transcript_sha256=hash(p.native_transcript_receipt.text);}
describe('official ZCode canary proof stays within the actual pinned server',()=>{
  it('accepts complete canonical replies and matching fresh official-server generations',()=>{
    const p=fixture();expect(validateZcodeCanaryProof(p,expected,hash)).toBe(p);
    const serialized=Function('return ('+validateZcodeCanaryProof.toString()+')')();expect(serialized(p,expected,hash)).toBe(p);
  });
  it.each(['wrong-id','wrong-cwd','wrong-model','wrong-reasoning','missing-model-pin','generation','stale','running','pending','error','background','partial','wrong-parent','unfinished','timeline','wrong-token','digest'])('rejects %s',mutation=>{
    const p=fixture();
    switch(mutation){
      case 'wrong-id':mutateNative(p,r=>{r.session.sessionId='different';});break;
      case 'wrong-cwd':mutateNative(p,r=>{r.session.workspace.workspacePath='/other';});break;
      case 'wrong-model':mutateNative(p,r=>{r.session.model.providerId='other';});break;
      case 'wrong-reasoning':mutateNative(p,r=>{r.settings.model.current.options.reasoningLevel='disabled';});break;
      case 'missing-model-pin':p.create_model='';break;
      case 'generation':p.official_after.generation=3;break;
      case 'stale':p.official_before.observedAt=new Date(now-16000).toISOString();break;
      case 'running':(p.official_after.tasks as any[]).push({sessionId:expected.nativeId,workspacePath:expected.cwd});break;
      case 'pending':mutateNative(p,r=>{r.runtime.pendingRequestIds=['wait'];});break;
      case 'error':mutateNative(p,r=>{r.session.status='error';r.projection.status='error';r.projection.lastError={code:'ECONNREFUSED'};});break;
      case 'background':mutateNative(p,r=>{r.projection.backgroundJobs=[{id:'active'}];});break;
      case 'partial':p.native_transcript_receipt.complete=false;break;
      case 'wrong-parent':mutateNative(p,r=>{r.messages[1].info.parentMessageId='another-user';});break;
      case 'unfinished':mutateNative(p,r=>{r.messages[1].info.finish=null;delete r.messages[1].info.time.completed;});break;
      case 'timeline':mutateNative(p,r=>{r.messages[1].info.semantics.kind='timeline_event';});break;
      case 'wrong-token':mutateNative(p,r=>{r.messages[3].parts[0].text='different';});break;
      case 'digest':p.native_transcript_sha256='f'.repeat(64);break;
    }
    expect(()=>validateZcodeCanaryProof(p,expected,hash)).toThrow('zcode_official_canary_unproven');
  });
});
