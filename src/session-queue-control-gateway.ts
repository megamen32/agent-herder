import type {GptAdminTransport} from './mesh/gptadmin.js';
import {unwrapResult} from './mesh/protocol.js';
import type {HerderJobRegistry} from './herder-jobs.js';
import {sessionQueueControlJobId,type SessionQueueControl,type SessionQueueControlInput,type SessionQueueControlTarget,type SessionQueueControlView} from './session-queue-control.js';

export interface SessionQueueControlPeer {hostId:string;target:string}
export interface SessionQueueControlSubmission {
  target:SessionQueueControlTarget;
  inputId:string;
  state:'queued'|'unknown'|'not_attempted';
  nonRetryable:boolean;
  job?:{id:string;state:string;resultRef:string};
  error?:string;
}

/** Thin owner router: the native host owns its one queue-control service and job journal. */
export class SessionQueueControlGateway {
  constructor(private readonly options:{ownerHostId:string;local:SessionQueueControl;jobs:HerderJobRegistry;transport?:GptAdminTransport;peers:readonly SessionQueueControlPeer[]}){}

  async read(target:SessionQueueControlTarget):Promise<SessionQueueControlView|{available:false;target:SessionQueueControlTarget;error:string}> {
    if(!this.validTarget(target))return {available:false,target,error:'Требуется точная ZCode-сессия и host.'};
    if(this.isLocal(target.hostId))return this.options.local.read(target);
    const peer=this.peer(target.hostId);
    if(!peer||!this.options.transport)return {available:false,target,error:'Владелец native-сессии недоступен для чтения очереди.'};
    try{
      const value=unwrapResult(await this.options.transport.call(peer.target,'session_queue_processing_get',{...target}));
      const remoteTarget=value.target&&typeof value.target==='object'?value.target as Record<string,unknown>:undefined;
      if(value.available===false&&remoteTarget?.hostId===target.hostId&&remoteTarget.harness===target.harness&&remoteTarget.sessionId===target.sessionId){
        return {available:false,target,error:typeof value.error==='string'?value.error:'Владелец native-сессии недоступен для чтения очереди.'};
      }
      if(value.available===true&&remoteTarget?.hostId===target.hostId&&remoteTarget.harness===target.harness&&remoteTarget.sessionId===target.sessionId)return value as unknown as SessionQueueControlView;
      if(remoteTarget?.hostId===target.hostId&&remoteTarget.harness===target.harness&&remoteTarget.sessionId===target.sessionId&&typeof value.canResume==='boolean')return value as unknown as SessionQueueControlView;
      return {available:false,target,error:'Владелец не подтвердил точное состояние native-очереди.'};
    }catch{return {available:false,target,error:'Не удалось прочитать native-очередь на её владельце.'};}
  }

  async submit(input:SessionQueueControlInput):Promise<SessionQueueControlSubmission> {
    if(!this.validInput(input))return {target:targetOf(input),inputId:input.inputId,state:'not_attempted',nonRetryable:true,error:'Требуются точный host, session, inputId и revision.'};
    if(this.isLocal(input.hostId))return this.localSubmission(input);
    const peer=this.peer(input.hostId);
    if(!peer||!this.options.transport)return {target:targetOf(input),inputId:input.inputId,state:'not_attempted',nonRetryable:true,error:'Владелец native-сессии недоступен; действие не отправлено.'};
    // The remote owner is the only writer. A transport failure after call begins
    // is ambiguous, so this request ID is terminal and must not be retried.
    let promise:Promise<unknown>;
    try{promise=Promise.resolve(this.options.transport.call(peer.target,'session_queue_processing_resume',{...input}));}
    catch{return {target:targetOf(input),inputId:input.inputId,state:'unknown',nonRetryable:true,error:'Не удалось установить исход вызова владельцу; повтор запрещён.'};}
    return await this.remoteSubmission(input,promise);
  }

  async job(target:SessionQueueControlTarget,inputId:string,jobId:string):Promise<{job:unknown|null}|{available:false;error:string}> {
    if(!this.validTarget(target)||typeof inputId!=='string'||!inputId.trim()||inputId.length>512||!jobId)return {available:false,error:'Точный host, session, inputId и jobId обязательны.'};
    const expectedJobId=sessionQueueControlJobId({...target,inputId,expectedRevision:0});
    if(jobId!==expectedJobId)return {available:false,error:'Job не соответствует точному действию и сессии.'};
    if(this.isLocal(target.hostId)){
      const job=this.options.jobs.get(jobId) as {id?:string;ownerSessionId?:string;kind?:string}|null;
      if(!job||job.id!==jobId||job.ownerSessionId!==target.sessionId||job.kind!=='Возобновление очереди (zcode)')return {job:null};
      return {job};
    }
    const peer=this.peer(target.hostId);
    if(!peer||!this.options.transport)return {available:false,error:'Владелец durable job недоступен.'};
    try{
      const value=unwrapResult(await this.options.transport.call(peer.target,'job_get',{jobId}));
      if(!Object.prototype.hasOwnProperty.call(value,'job'))return {available:false,error:'Владелец не вернул квитанцию job.'};
      const job=value.job as Record<string,unknown>|null;
      if(job&&(job.id!==jobId||job.ownerSessionId!==target.sessionId||job.kind!=='Возобновление очереди (zcode)'))return {available:false,error:'Владелец вернул job для другой цели.'};
      return {job};
    }catch{return {available:false,error:'Не удалось прочитать durable job у её владельца.'};}
  }

  private localSubmission(input:SessionQueueControlInput):SessionQueueControlSubmission {
    try{
      const job=this.options.local.submit(input);
      return {target:targetOf(input),inputId:input.inputId,state:'queued',nonRetryable:false,job:{id:job.id,state:job.state,resultRef:job.resultRef}};
    }catch(error){return {target:targetOf(input),inputId:input.inputId,state:'not_attempted',nonRetryable:true,error:error instanceof Error?error.message:'Очередь не приняла действие.'};}
  }

  private async remoteSubmission(input:SessionQueueControlInput,promise:Promise<unknown>):Promise<SessionQueueControlSubmission> {
    try{
      const value=unwrapResult(await promise);
      const target=value.target as Record<string,unknown>|undefined;
      const job=value.job as Record<string,unknown>|undefined;
      const expectedJobId=sessionQueueControlJobId(input);
      if(value.state==='queued'&&value.inputId===input.inputId&&target?.hostId===input.hostId&&target.harness===input.harness&&target.sessionId===input.sessionId
        &&job?.id===expectedJobId&&typeof job.state==='string'&&typeof job.resultRef==='string'){
        return {target:targetOf(input),inputId:input.inputId,state:'queued',nonRetryable:false,job:{id:job.id,state:job.state,resultRef:job.resultRef}};
      }
      if(value.state==='not_attempted'&&value.inputId===input.inputId)return {target:targetOf(input),inputId:input.inputId,state:'not_attempted',nonRetryable:true,error:typeof value.error==='string'?value.error:'Native owner refused the request.'};
      return {target:targetOf(input),inputId:input.inputId,state:'unknown',nonRetryable:true,error:'Владелец не подтвердил точную квитанцию; повтор запрещён.'};
    }catch{return {target:targetOf(input),inputId:input.inputId,state:'unknown',nonRetryable:true,error:'Ответ владельца потерян или не проверен; повтор запрещён.'};}
  }

  private validTarget(target:SessionQueueControlTarget):boolean{return !!target&&target.harness==='zcode'&&this.validHost(target.hostId)&&this.validSession(target.sessionId);}
  private validInput(input:SessionQueueControlInput):boolean{return this.validTarget(input)&&typeof input.inputId==='string'&&!!input.inputId.trim()&&input.inputId.length<=512&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0;}
  private validHost(value:string):boolean{return typeof value==='string'&&!!value.trim()&&value.length<=512&&!/[\s\x00-\x1f\x7f/\\]/u.test(value);}
  private validSession(value:string):boolean{return typeof value==='string'&&!!value.trim()&&value.length<=512&&!/[\x00-\x1f\x7f]/u.test(value);}
  private isLocal(hostId:string):boolean{return hostId.toLowerCase()===this.options.ownerHostId.toLowerCase();}
  private peer(hostId:string):SessionQueueControlPeer|undefined{return this.options.peers.find(peer=>peer.hostId.toLowerCase()===hostId.toLowerCase());}
}

function targetOf(input:SessionQueueControlTarget):SessionQueueControlTarget{return {hostId:input.hostId,harness:input.harness,sessionId:input.sessionId};}
