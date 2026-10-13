import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import type {MeshAddress} from '../../mesh/protocol.js';
import type {FleetHost} from '../../mesh/fleet-contract.js';
import type {SessionMessageView} from '../../types/index.js';
import {createFleetClient} from './client.js';
import type {SessionViewCache} from './view-cache.js';
import {fleetSessionLink} from './session-link.js';
import {remoteSessionStorage} from './session-control.js';
import {fleetSessionStatus} from './session-labels.js';
import {readStoredOutbox,writeStoredOutbox,appendOutboxEntry,updateOutboxEntry,newInputId,classifyMessageDelivery,reconcileMessageStatus,deliveryConnectionFailure,outboxStatusLabel,readDefaultDeliveryMode,type OutboxEntry,type DeliveryMode} from '../composer-delivery.js';
import {projectDeliveredChat} from '../delivered-chat.js';
type View={hostId:string;details:{session:{id:string;harness:string;title?:string;cwd?:string;model?:string;status?:string};historyUnavailable?:boolean;messages?:SessionMessageView[]}};
const client=createFleetClient();
export function RemoteSessionView({address,host,scope,cache,onClose,renderMessage}:{address:MeshAddress;host:FleetHost;scope:string;cache:SessionViewCache;onClose:()=>void;renderMessage?:(message:SessionMessageView)=>ReactNode}){
 const captured=useMemo(()=>Object.freeze({...address}),[address.hostId,address.harness,address.nativeSessionId]);
 const storage=useMemo(()=>remoteSessionStorage(window.localStorage,scope,captured),[scope,captured]);
 const key=JSON.stringify([captured.hostId,captured.harness,captured.nativeSessionId]);
 const [view,setView]=useState<View>(),[cached,setCached]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[text,setText]=useState(''),[mode,setMode]=useState<DeliveryMode>(()=>readDefaultDeliveryMode(window.localStorage));
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
 const check=async(entry:OutboxEntry)=>{
  try{const r=await client.control!(captured,{operation:'message-status',inputId:entry.inputId});if(r.status!==200)return;const receipt=r.body as {inputId?:string};if(receipt.inputId!==entry.inputId)return;put(updateOutboxEntry(values.current,entry.inputId,reconcileMessageStatus(r.body,true)));}catch{/* receipt-only; never resend after a lost reply */}
 };
 useEffect(()=>{
  alive.current=true;void cache.get<View>(scope,captured).then(r=>{if(alive.current&&reading.current&&r?.value.hostId===captured.hostId&&r.value.details?.session.id===captured.nativeSessionId&&r.value.details.session.harness===captured.harness){setView(r.value);setCached(true);}});void fresh();
  const timer=setInterval(()=>{void fresh();for(const entry of values.current)if(['sending','accepted','deferred','pending','unknown'].includes(entry.status))void check(entry);},5000);
  return()=>{alive.current=false;clearInterval(timer);};
 },[captured,scope,storage]);
 const projection=projectDeliveredChat(view?.details.messages??[],entries,key);
 useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight});},[projection.messages.length,entries.length]);
 const available=Boolean(view&&!cached&&!loading&&!view.details.historyUnavailable);
 const submit=async()=>{
  if(!available||busy.current||!text.trim())return;
  const entry:OutboxEntry={inputId:newInputId(),sessionKey:key,text:text.trim(),mode,createdAt:Date.now(),status:'sending'};
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
 const link=fleetSessionLink(host,captured),session=view?.details.session;
 return <section className="chat-pane remote-chat-pane" aria-label="Чат удалённой сессии">
  <header className="chat-header"><button className="quiet-button mobile-back" type="button" onClick={onClose}>← Сессии</button><div className="chat-heading"><h2>{session?.title??captured.nativeSessionId}</h2><span className="chat-session-state" title={session?.cwd}>{host.label} · {captured.harness} · {fleetSessionStatus(session?.status??'unknown')} {session?.model?`· ${session.model}`:''}</span></div><div className="header-actions"><button type="button" className="quiet-button" onClick={()=>void fresh()}>Обновить</button><button type="button" className="quiet-button" disabled={!available||!!action||actionUnknown} onClick={()=>void control('resume')}>{action==='resume'?'Продолжаю…':'Продолжить'}</button><button type="button" className="danger-button" disabled={!available||!!action||actionUnknown} onClick={()=>void control('stop')}>{action==='stop'?'Останавливаю…':'Остановить'}</button>{link&&<details><summary aria-label="Дополнительно">•••</summary><a href={link}>Отдельный кабинет ↗</a></details>}</div></header>
  {cached&&<p className="cached-view-notice" role="status">Сохранённая история · команды доступны после восстановления связи</p>}{error&&<p role="alert" className="remote-chat-error">{error}</p>}{actionUnknown&&<p role="status" className="remote-chat-error">Результат предыдущей команды не подтверждён. Повторные команды управления заблокированы; история и проверка доставки доступны.</p>}
  <div className="chat-scroll" ref={scroll}>{loading&&!view&&<p role="status">Загрузка истории…</p>}{view?.details.historyUnavailable?<p>История пока недоступна.</p>:projection.messages.map((m,i)=><article className={`message ${m.role==='user'?'user':'assistant'}`} key={m.id??i}><div className="message-meta"><strong>{m.role==='user'?'Вы':'Агент'}</strong>{m.timestamp&&<time>{new Date(m.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>}</div>{renderMessage?renderMessage(m):<div className="message-body"><pre>{m.text??''}</pre></div>}</article>)}</div>
  <div className="composer-stack">{projection.pending.map(entry=><article className={`composer-outbox-entry status-${entry.status}`} key={entry.inputId}><div className="composer-outbox-meta"><span>{outboxStatusLabel(entry.status)}</span>{entry.status==='unknown'&&<button type="button" onClick={()=>void check(entry)}>Проверить доставку</button>}</div><div className="composer-outbox-text">{entry.text}</div>{entry.error&&<small>{entry.error}</small>}</article>)}
  <form className="composer" onSubmit={e=>{e.preventDefault();void submit();}}><div className="composer-left"><select aria-label="Режим отправки" value={mode} onChange={e=>setMode(e.target.value as DeliveryMode)}><option value="queue">После ответа</option><option value="steer">В текущий ход</option></select></div><textarea aria-label="Сообщение удалённой сессии" placeholder={available?'Работайте с агентом':'Подключаю выбранную сессию…'} value={text} disabled={!available} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void submit();}}}/><span className="composer-hint">{sending?'Отправляю…':'Enter — отправить · Shift+Enter — новая строка'}</span><button type="submit" className="send-button" disabled={!available||sending||!text.trim()} aria-label="Отправить сообщение">↑</button></form></div>
 </section>;
}
