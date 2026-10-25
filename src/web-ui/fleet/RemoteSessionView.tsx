import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {MeshAddress} from '../../mesh/protocol.js';
import type {FleetHost} from '../../mesh/fleet-contract.js';
import type {SessionMessageView} from '../../types/index.js';
import type {NativeTranscriptEvent} from '../../integrator-transcript.js';
import {createFleetClient} from './client.js';
import {ComposerSendControl,VoiceComposerControl,isComposerSubmitShortcut} from '../composer-controls.js';
import type {SessionViewCache} from './view-cache.js';
import {fleetSessionLink} from './session-link.js';
import {remoteSessionStorage} from './session-control.js';
import {fleetSessionStatus} from './session-labels.js';
import {readStoredOutbox,writeStoredOutbox,appendOutboxEntry,updateOutboxEntry,newInputId,classifyMessageDelivery,reconcileMessageStatus,deliveryConnectionFailure,outboxStatusLabel,readDefaultDeliveryMode,type OutboxEntry,type DeliveryMode} from '../composer-delivery.js';
import {projectDeliveredChat} from '../delivered-chat.js';
type View={hostId:string;details:{session:{id:string;harness:string;title?:string;cwd?:string;model?:string;status?:string};historyUnavailable?:boolean;messages?:SessionMessageView[]}};
export type TranscriptView={scope:{hostId:string;harness:string;nativeSessionId:string};events:NativeTranscriptEvent[];totalEvents:number;nextCursor:string|null;complete:boolean;source:string};
type TranscriptRouteResponse={session:{id:string;harness:string;status:string;lastActivity:string};transcript:TranscriptView;steerEndpoint:string};
type DisplayMessage={message:SessionMessageView;attribution:string;visualRole:string};
export function localTranscriptAddressFor(hostId:string|undefined,session:{harness:string;id:string;remote?:boolean}|undefined,remoteSelection?:MeshAddress):MeshAddress|undefined{
 if(!hostId||!session||session.remote||remoteSelection)return undefined;
 return {hostId,harness:session.harness,nativeSessionId:session.id};
}
export type TranscriptRequestToken={readonly sessionKey:string;readonly generation:number;readonly id:symbol};
export class TranscriptRequestOwner{
 private sessionKey:string;
 private generation=0;
 private active?:TranscriptRequestToken;
 constructor(sessionKey:string){this.sessionKey=sessionKey;}
 setSession(sessionKey:string):void{if(this.sessionKey===sessionKey)return;this.sessionKey=sessionKey;this.generation++;this.active=undefined;}
 begin(sessionKey:string):TranscriptRequestToken|null{
  if(sessionKey!==this.sessionKey||this.active)return null;
  this.generation++;
  const token=Object.freeze({sessionKey,generation:this.generation,id:Symbol(sessionKey)});
  this.active=token;return token;
 }
 isCurrent(token:TranscriptRequestToken):boolean{return this.sessionKey===token.sessionKey&&this.generation===token.generation;}
 finish(token:TranscriptRequestToken):boolean{if(!this.isCurrent(token)||this.active!==token)return false;this.active=undefined;return true;}
 cancel(sessionKey:string):void{if(this.sessionKey!==sessionKey)return;this.generation++;this.active=undefined;}
}
export function mergeTranscriptPageIfCurrent(current:TranscriptView|undefined,incoming:TranscriptView,owner:TranscriptRequestOwner,token:TranscriptRequestToken,reset:boolean):TranscriptView|undefined{
 if(!owner.isCurrent(token))return current;
 if(reset||!current||current.scope.hostId!==incoming.scope.hostId||current.scope.harness!==incoming.scope.harness||current.scope.nativeSessionId!==incoming.scope.nativeSessionId)return incoming;
 const seen=new Set(current.events.map(event=>event.eventId));
 return {...incoming,events:[...current.events,...incoming.events.filter(event=>!seen.has(event.eventId))]};
}
export function transcriptValueIfCurrent<T>(current:T,incoming:T,owner:TranscriptRequestOwner,token:TranscriptRequestToken):T{
 return owner.isCurrent(token)?incoming:current;
}
const client=createFleetClient();

function payloadText(value:unknown):string|undefined{
 if(value===undefined)return undefined;
 if(typeof value==='string')return value;
 try{return JSON.stringify(value);}catch{return '[native payload unavailable]';}
}

export function integratorEventDisplay(event:NativeTranscriptEvent):DisplayMessage{
 const {author}=event;
 let attribution='Неизвестный автор';
 if(event.kind==='tool_call')attribution=`Вызов инструмента · ${event.toolName??'неизвестный инструмент'}`;
 else if(event.kind==='tool_result')attribution=event.toolName?`Инструмент · ${event.toolName}`:'Неизвестный автор · tool';
 else if(author.kind==='assistant')attribution='Агент';
 else if(author.kind==='system')attribution='Система';
 else if(author.kind==='human')attribution='Пользователь';
 else if(author.kind==='tool')attribution=author.id?`Инструмент · ${author.id}`:'Инструмент';
 else if(author.sourceRole)attribution=`Неизвестный автор · ${author.sourceRole}`;
 const role:SessionMessageView['role']=event.kind==='tool_result'||author.kind==='tool'?'tool':author.kind==='assistant'||event.kind==='tool_call'?'assistant':author.kind==='system'?'system':'user';
 const parts:SessionMessageView['parts']=event.kind==='tool_call'
  ?[{type:'tool_call',name:event.toolName,input:{callId:event.toolCallId,arguments:event.payload}}]
  :event.kind==='tool_result'
   ?[{type:'tool_result',name:event.toolName,input:{callId:event.toolCallId},output:payloadText(event.payload)}]
   :event.text!==undefined?[{type:'text',text:event.text}]:[];
 return {message:{id:event.eventId,role,...(event.turnId?{turnId:event.turnId}:{}),...(event.timestamp?{timestamp:event.timestamp}:{}),...(event.text!==undefined?{text:event.text}:{}),parts},attribution,visualRole:author.kind==='unknown'?'unknown':author.kind};
}

export function fallbackSessionAttribution(role:SessionMessageView['role']):string{
 return role==='user'?'Неизвестный автор · user':role==='tool'?'Инструмент':role==='system'?'Система':'Агент';
}

export function transcriptForAddress(transcript:TranscriptView|undefined,address:MeshAddress):TranscriptView|undefined{
 return transcript?.scope.hostId===address.hostId&&transcript.scope.harness===address.harness&&transcript.scope.nativeSessionId===address.nativeSessionId?transcript:undefined;
}

/** Finds only an exact native turn ID; never substitutes a nearby event. */
export function firstEventIndexForTurn(events:readonly NativeTranscriptEvent[],turnId:string|undefined):number|undefined{
 if(!turnId)return undefined;
 const index=events.findIndex(event=>event.turnId===turnId);
 return index<0?undefined:index;
}

export async function fetchIntegratorTranscriptPage(input:{address:MeshAddress;expectedHostId:string;cursor?:string;fetcher?:typeof fetch}):Promise<TranscriptRouteResponse>{
 const query=new URLSearchParams({limit:'50'});if(input.cursor!==undefined)query.set('cursor',input.cursor);
 const path=`/api/sessions/${encodeURIComponent(input.address.harness)}/${encodeURIComponent(input.address.nativeSessionId)}/transcript?${query}`;
 const response=await (input.fetcher??fetch)(path,{credentials:'same-origin',cache:'no-store'});
 if(!response.ok)throw new Error('Свежая история сессии недоступна. Обновите страницу истории.');
 const value=await response.json() as TranscriptRouteResponse;
 if(value.session?.id!==input.address.nativeSessionId||value.session.harness!==input.address.harness
  ||value.transcript?.scope?.hostId!==input.expectedHostId||value.transcript.scope.harness!==input.address.harness
  ||value.transcript.scope.nativeSessionId!==input.address.nativeSessionId||!Array.isArray(value.transcript.events)){
  throw new Error('Ответ истории не относится к выбранной сессии и машине.');
 }
 return value;
}

export function RemoteSessionView({address,host,scope,cache,onClose,renderMessage}:{address:MeshAddress;host:FleetHost;scope:string;cache:SessionViewCache;onClose:()=>void;renderMessage?:(message:SessionMessageView)=>ReactNode}){
 const captured=useMemo(()=>Object.freeze({...address}),[address.hostId,address.harness,address.nativeSessionId]);
 const storage=useMemo(()=>remoteSessionStorage(window.localStorage,scope,captured),[scope,captured]);
 const key=JSON.stringify([captured.hostId,captured.harness,captured.nativeSessionId]);
 const transcriptOwner=useRef<TranscriptRequestOwner|null>(null);if(!transcriptOwner.current)transcriptOwner.current=new TranscriptRequestOwner(key);transcriptOwner.current.setSession(key);
 const [view,setView]=useState<View>(),[cached,setCached]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[text,setText]=useState(''),[mode,setMode]=useState<DeliveryMode>(()=>readDefaultDeliveryMode(window.localStorage));
 const [localHostId,setLocalHostId]=useState(''),[transcript,setTranscript]=useState<TranscriptView>(),[transcriptError,setTranscriptError]=useState(''),[loadingMore,setLoadingMore]=useState(false);
 const [entries,setEntries]=useState(()=>readStoredOutbox(storage)),[sending,setSending]=useState(false),[action,setAction]=useState<string>(),[actionUnknown,setActionUnknown]=useState(()=>storage.getItem('control-intent')!==null);
 const alive=useRef(true),busy=useRef(false),values=useRef(entries),reading=useRef(false),scroll=useRef<HTMLDivElement>(null);
 const put=(next:OutboxEntry[])=>{if(!writeStoredOutbox(storage,next))throw new Error('Не удалось сохранить отправку.');values.current=next;if(alive.current)setEntries(next);};
 const fresh=async()=>{
  if(reading.current)return;reading.current=true;
  try{const response=await client.control!(captured,{operation:'details'});if(response.status!==200)throw new Error('Свежая история выбранной сессии пока недоступна.');
   const details=response.body as View['details'];if(details?.session?.id!==captured.nativeSessionId||details.session.harness!==captured.harness)throw new Error('Не удалось подтвердить выбранную сессию.');
   if(alive.current){const next={hostId:captured.hostId,details};setView(next);setCached(false);setError('');void cache.put(scope,captured,next);}
  }catch{if(alive.current){setCached(true);setError('Нет свежего подключения. Сохранённая история доступна, команды не отправляются.');}}
  finally{reading.current=false;if(alive.current)setLoading(false);}
 };
 const readTranscript=async(cursor?:string,reset=false)=>{
  if(!localHostId||localHostId!==captured.hostId)return;
  const owner=transcriptOwner.current!,token=owner.begin(key);if(!token)return;
  const ownsRequest=()=>alive.current&&owner.isCurrent(token);
  if(!cursor)setTranscriptError('');if(cursor)setLoadingMore(true);
  try{
   const result=await fetchIntegratorTranscriptPage({address:captured,expectedHostId:localHostId,cursor});
   if(!ownsRequest())return;
   setTranscript(current=>{
    if(!ownsRequest())return current;
    if(reset||!current||current.scope.hostId!==result.transcript.scope.hostId)return result.transcript;
    const seen=new Set(current.events.map(event=>event.eventId));
    const appended=result.transcript.events.filter(event=>!seen.has(event.eventId));
    return {...result.transcript,events:[...current.events,...appended]};
   });
  }catch(e){if(ownsRequest()){const message=e instanceof Error?e.message:'История сессии недоступна.';setTranscriptError(current=>ownsRequest()?message:current);}}
  finally{if(owner.finish(token)&&alive.current)setLoadingMore(false);}
 };
 const check=async(entry:OutboxEntry)=>{
  try{const r=await client.control!(captured,{operation:'message-status',inputId:entry.inputId});if(r.status!==200)return;const receipt=r.body as {inputId?:string};if(receipt.inputId!==entry.inputId)return;put(updateOutboxEntry(values.current,entry.inputId,reconcileMessageStatus(r.body,true)));}catch{/* receipt-only; never resend after a lost reply */}
 };
 useEffect(()=>{let active=true;client.hosts().then(result=>{if(active)setLocalHostId(result.defaultHostId);}).catch(()=>{});return()=>{active=false;};},[]);
 useEffect(()=>{
  setTranscript(undefined);setTranscriptError('');
  if(localHostId===captured.hostId)void readTranscript(undefined,true);
  return()=>transcriptOwner.current?.cancel(key);
 },[localHostId,captured]);
 useEffect(()=>{
  alive.current=true;void cache.get<View>(scope,captured).then(r=>{if(alive.current&&reading.current&&r?.value.hostId===captured.hostId&&r.value.details?.session.id===captured.nativeSessionId&&r.value.details.session.harness===captured.harness){setView(r.value);setCached(true);}});void fresh();
  const timer=setInterval(()=>{void fresh();for(const entry of values.current)if(['sending','accepted','deferred','pending','unknown'].includes(entry.status))void check(entry);},5000);
  return()=>{alive.current=false;clearInterval(timer);};
 },[captured,scope,storage,localHostId]);
 const currentView=view?.hostId===captured.hostId&&view.details.session.id===captured.nativeSessionId&&view.details.session.harness===captured.harness?view:undefined;
 const projection=projectDeliveredChat(currentView?.details.messages??[],entries,key);
 const currentTranscript=transcriptForAddress(transcript,captured);
 const transcriptMessages=currentTranscript?.events.map(integratorEventDisplay);
 const detailsMessages=projection.messages.map(message=>({message,attribution:fallbackSessionAttribution(message.role),visualRole:message.role==='user'?'unknown':message.role}));
 const displayMessages=localHostId===captured.hostId&&currentTranscript&&transcriptMessages?transcriptMessages:detailsMessages;
 useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[displayMessages.length,entries.length]);
 const available=Boolean(currentView&&!cached&&!loading&&(!currentView.details.historyUnavailable||localHostId===captured.hostId&&!!currentTranscript));
 const refresh=()=>{void fresh();if(localHostId===captured.hostId)void readTranscript(undefined,true);};
 const submit=async(nextMode:DeliveryMode=mode)=>{
  if(!available||busy.current||!text.trim())return;
  const entry:OutboxEntry={inputId:newInputId(),sessionKey:key,text:text.trim(),mode:nextMode,createdAt:Date.now(),status:'sending'};
  busy.current=true;setSending(true);
  try{put(appendOutboxEntry(values.current,entry));setText('');
   const response=await client.control!(captured,{operation:'message',inputId:entry.inputId,message:entry.text,mode:entry.mode});
   put(updateOutboxEntry(values.current,entry.inputId,classifyMessageDelivery(response.body,response.status>=200&&response.status<300)));
  }catch(e){if(values.current.some(v=>v.inputId===entry.inputId)){try{put(updateOutboxEntry(values.current,entry.inputId,deliveryConnectionFailure(e)));}catch{}}if(alive.current)setError(e instanceof Error?e.message:'Доставка не подтверждена.');}
  finally{busy.current=false;if(alive.current){setSending(false);void fresh();}}
 };
 const control=async(operation:'stop'|'resume')=>{
  if(!available||busy.current||actionUnknown)return;
  busy.current=true;setAction(operation);
  try{storage.setItem('control-intent',JSON.stringify({operation,inputId:newInputId()}));const intent=JSON.parse(storage.getItem('control-intent')!);
   const r=await client.control!(captured,{operation,inputId:intent.inputId,...(operation==='resume'?{message:'Продолжи текущую задачу в этой же сессии. Если работа уже завершена, сообщи результат.'}:{})});
   if(r.status<200||r.status>=300||(r.body as {ok?:boolean})?.ok!==true)throw new Error('Результат команды не подтверждён. Повтор автоматически не выполняется.');
   // Successful existing owner API acknowledgement, not a business completion claim.
   storage.removeItem('control-intent');
  }catch(e){setActionUnknown(true);setError(e instanceof Error?e.message:'Результат команды неизвестен.');}
  finally{busy.current=false;if(alive.current){setAction(undefined);void fresh();}}
 };
 const link=fleetSessionLink(host,captured),session=currentView?.details.session;
 return <section className="chat-pane remote-chat-pane" aria-label="Чат удалённой сессии">
  <header className="chat-header"><button className="quiet-button mobile-back" type="button" onClick={onClose}>← Сессии</button><div className="chat-heading"><h2>{session?.title??captured.nativeSessionId}</h2><span className="chat-session-state" title={session?.cwd}>{host.label} · {captured.harness} · {fleetSessionStatus(session?.status??'unknown')} {session?.model?`· ${session.model}`:''}</span></div><div className="header-actions"><button type="button" className="quiet-button" onClick={refresh}>Обновить</button><button type="button" className="quiet-button" disabled={!available||!!action||actionUnknown} onClick={()=>void control('resume')}>{action==='resume'?'Продолжаю…':'Продолжить'}</button><button type="button" className="danger-button" disabled={!available||!!action||actionUnknown} onClick={()=>void control('stop')}>{action==='stop'?'Останавливаю…':'Остановить'}</button>{link&&<details><summary aria-label="Дополнительно">•••</summary><a href={link}>Отдельный кабинет ↗</a></details>}</div></header>
  {cached&&<p className="cached-view-notice" role="status">Сохранённая история · команды доступны после восстановления связи</p>}{error&&<p role="alert" className="remote-chat-error">{error}</p>}{actionUnknown&&<p role="status" className="remote-chat-error">Результат предыдущей команды не подтверждён. Повторные команды управления заблокированы; история и проверка доставки доступны.</p>}
  <div className="chat-scroll" ref={scroll}>{loading&&!currentView&&<p role="status">Загрузка истории…</p>}{displayMessages.length===0&&currentView?.details.historyUnavailable&&<p>История пока недоступна.</p>}{transcriptError&&<p role="alert" className="remote-chat-error">{transcriptError}</p>}{displayMessages.map(({message:m,attribution,visualRole},i)=>{const body=renderMessage?renderMessage(m):<div className="message-body"><pre>{m.text??payloadText(m.parts.map(part=>part.input??part.output).find(value=>value!==undefined)??'')??''}</pre></div>;if(body==null)return null;return <article className={`message ${visualRole}`} key={m.id??i}><div className="message-meta"><strong>{attribution}</strong>{m.timestamp&&<time>{new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>}</div>{body}</article>;})}{currentTranscript?.nextCursor&&<button type="button" className="quiet-button" disabled={loadingMore} onClick={()=>void readTranscript(currentTranscript.nextCursor??undefined)}>{loadingMore?'Загружаю…':'Загрузить следующую страницу истории'}</button>}</div>
  <div className="composer-stack">{projection.pending.map(entry=><article className={`composer-outbox-entry status-${entry.status}`} key={entry.inputId}><div className="composer-outbox-meta"><span>{outboxStatusLabel(entry.status)}</span>{entry.status==='unknown'&&<button type="button" onClick={()=>void check(entry)}>Проверить доставку</button>}</div><div className="composer-outbox-text">{entry.text}</div>{entry.error&&<small>{entry.error}</small>}</article>)}
  <form className="composer" onSubmit={e=>e.preventDefault()}><div className="composer-left"><select aria-label="Режим отправки" value={mode} onChange={e=>setMode(e.target.value as DeliveryMode)}><option value="queue">После ответа</option><option value="steer">В текущий ход</option></select></div><textarea aria-label="Сообщение удалённой сессии" placeholder={available?'Работайте с агентом':'Подключаю выбранную сессию…'} value={text} disabled={!available} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(isComposerSubmitShortcut(e)){e.preventDefault();void submit();}}}/><VoiceComposerControl key={key} sessionKey={key} disabled={!available||sending} onTranscript={transcript=>setText(current=>current?`${current}${current.endsWith('\n')?'':'\n'}${transcript}`:transcript)}/><ComposerSendControl disabled={!available||!text.trim()} busy={sending} onSend={nextMode=>{if(nextMode)setMode(nextMode);void submit(nextMode??mode);}} title={mode==='queue'?'Отправить после ответа агента':'Передать в текущий ход агента'}/></form></div>
 </section>;
}
