import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {FleetHost,FleetSession,FleetHarness,FleetCreateReceipt} from '../../mesh/fleet-contract.js';
import {createFleetClient,type FleetClient} from './client.js';
import './fleet.css';
import {FleetBrowserIntent,type FleetIntent} from './intent.js';
import type {MeshAddress} from '../../mesh/protocol.js';
import {fleetSessionLink} from './session-link.js';
import {machineName,machineStatus,machineReason} from './machine-labels.js';
import {fleetSessionStatus} from './session-labels.js';
// Public machine catalog only: no cached health or creation capability is trusted.
// The authenticated, scope-keyed /hosts response replaces these entries after its background check.
const fleetCatalog:FleetHost[]=[
 {hostId:'roomhacker-server-100',label:'Сервер 100',uiUrl:'https://agent.bezrabotnyi.com',state:'stale',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[]},
 {hostId:'server-44',label:'Сервер 44',uiUrl:'https://agent44.bezrabotnyi.com',state:'stale',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[]},
 {hostId:'roomhacker-server-88',label:'Сервер 88',uiUrl:'https://agent88.bezrabotnyi.com',state:'stale',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[]},
 {hostId:'mac-mini-2012.lan',label:'Mac Mini',uiUrl:'https://agent-mac-mini.bezrabotnyi.com',state:'stale',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[]},
 {hostId:'MacBook-Pro-User.local',label:'Mac M1',uiUrl:'https://agent-mac-m1.bezrabotnyi.com',state:'stale',fetchedAt:null,expiresAt:null,generation:null,createHarnesses:[]},
];
/** Mount once for one authenticated browser identity. Remote session selection retains its full native address. */
export function FleetCabinet({creationMode=false,defaultHostId,onSelectedHostChange,onSelectSession,client:injected}:{creationMode?:boolean;defaultHostId?:string;onSelectedHostChange?:(hostId:string)=>void;onSelectSession?:(session:FleetSession)=>void;client?:FleetClient}){
 const client=useRef(injected??createFleetClient()).current;
 const [hosts,setHosts]=useState<FleetHost[]>(fleetCatalog),[hostId,setHostId]=useState(defaultHostId??''),[sessions,setSessions]=useState<FleetSession[]>([]);
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[partial,setPartial]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [harness,setHarness]=useState<FleetHarness>('codex'),[name,setName]=useState(''),[cwd,setCwd]=useState(''),[model,setModel]=useState('');
 const [clock,setClock]=useState(Date.now());
 const [sending,setSending]=useState(false),[receipt,setReceipt]=useState<FleetCreateReceipt|null>(null);
 const [directRead,setDirectRead]=useState(false),[view,setView]=useState<{address:MeshAddress;title:string;cwd?:string;model?:string;historyUnavailable?:boolean;messages:{text?:string;role?:string;kind?:string}[]}|null>(null),[reading,setReading]=useState(false);
 const viewRequest=useRef<AbortController|null>(null);
 const viewElement=useRef<HTMLElement|null>(null);
 const sessionsElement=useRef<HTMLElement|null>(null),formElement=useRef<HTMLFormElement|null>(null),nameElement=useRef<HTMLInputElement|null>(null);
 const jumpTo=(section:HTMLElement|null,focusTarget:HTMLElement|null=section)=>{
  section?.scrollIntoView({block:'start'});focusTarget?.focus({preventScroll:true});
 };
 useEffect(()=>{if(view){viewElement.current?.scrollIntoView({block:'nearest'});viewElement.current?.focus({preventScroll:true});}},[view]);
 const inspect=async(address:MeshAddress)=>{
  if(!client.session)return;viewRequest.current?.abort();const abort=new AbortController();viewRequest.current=abort;setReading(true);setView(null);
  try{const r=await client.session(address,abort.signal);if(abort.signal.aborted)return;if(r.hostId!==address.hostId||r.details.session.id!==address.nativeSessionId||r.details.session.harness!==address.harness)throw new Error('foreign_session');setView({address,title:r.details.session.title??address.nativeSessionId,cwd:r.details.session.cwd,model:r.details.session.model,historyUnavailable:r.details.historyUnavailable===true,messages:(r.details.messages??[]).slice(-3)});}
  catch{if(!abort.signal.aborted)setError('Не удалось прочитать эту сессию на выбранной машине');}
  finally{if(!abort.signal.aborted)setReading(false);}
 };
 useEffect(()=>()=>viewRequest.current?.abort(),[]);
 useEffect(()=>{viewRequest.current?.abort();setView(null);setReading(false);},[hostId]);
 const [archived,setArchived]=useState<FleetIntent[]>([]);
 const ownMutation=useRef(false), initialized=useRef(false), intentStore=useRef<FleetBrowserIntent|null>(null);
 const deferUnknown=()=>{
  if(ownMutation.current||receipt?.state!=='unknown')return;
  try{intentStore.current!.archiveUnknown();setArchived(intentStore.current!.archivedUnknown());setReceipt(null);setName('');setCwd('');setModel('');setError('Предыдущий запрос сохранён для проверки. Он не отправлялся повторно.');}
  catch{setError('Не удалось сохранить запрос для проверки. Новое создание остаётся отключено.');}
 };
 useEffect(()=>{const abort=new AbortController();setLoading(true);client.hosts(abort.signal,refresh>0).then(r=>{if(abort.signal.aborted)return;setHosts(r.hosts);setDirectRead(r.sessionReadSupported===true);if(!initialized.current){intentStore.current=new FleetBrowserIntent(localStorage,r.scopeKey);setArchived(intentStore.current.archivedUnknown());const saved=intentStore.current.load();if(saved){setHostId(saved.request.hostId);onSelectedHostChange?.(saved.request.hostId);setName(saved.request.name);setCwd(saved.request.cwd);setHarness(saved.request.harness);setModel(saved.request.model??'');setReceipt(saved.receipt);}else if(!defaultHostId){setHostId(r.defaultHostId);onSelectedHostChange?.(r.defaultHostId);}initialized.current=true;}setLoaded(true);}).catch(()=>{if(!abort.signal.aborted)setError('Не удалось получить список машин');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[client,defaultHostId,refresh]);
 useEffect(()=>{if(!loaded)return;const abort=new AbortController();setSessions([]);client.sessions(hostId||undefined,abort.signal).then(r=>{if(abort.signal.aborted)return;setSessions(r.sessions);setPartial(!r.complete||r.limited);}).catch(()=>{if(!abort.signal.aborted)setError('Не удалось прочитать сессии этой машины');});return()=>abort.abort();},[client,hostId,loaded,refresh]);
 const selected=hosts.find(h=>h.hostId===hostId);
 const allowed=selected?.createHarnesses??[];
 useEffect(()=>{if(selected?.state!=='ready'||selected.expiresAt===null)return;const timer=window.setTimeout(()=>setClock(Date.now()),Math.max(0,selected.expiresAt-Date.now()));return()=>window.clearTimeout(timer);},[selected?.hostId,selected?.state,selected?.expiresAt]);
 const canCreate=loaded&&!loading&&selected?.state==='ready'&&selected.expiresAt!==null&&selected.expiresAt>clock&&allowed.includes(harness);
 useEffect(()=>{if(!allowed.includes(harness)&&allowed.length)setHarness(allowed[0]!);},[selected]);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(ownMutation.current||receipt?.state==='unknown'||!canCreate)return;
  const inputId=crypto.randomUUID();const request={hostId,harness,name,cwd,...(model.trim()?{model:model.trim()}:{}),inputId};
  try{if(!intentStore.current)throw new Error('Нет сохранённого состояния кабинета');intentStore.current.begin(request);}catch{setError('Не удалось сохранить запрос. Создание не отправлено.');return;}
  ownMutation.current=true;setSending(true);setError('');
  // One POST. Lost response locks this intent; subsequent reads are GET only.
  try{const result=await client.create(request);intentStore.current!.finish(result);setReceipt(result);if(result.state==='created')setRefresh(r=>r+1);}
  catch{setReceipt({state:'unknown',inputId,retryable:false});}
  finally{ownMutation.current=false;setSending(false);}
 };
 return <section className={`fleet-cabinet${creationMode?' fleet-cabinet-creating':''}`} aria-label="Машины и сессии">
  <header><div><h2>{creationMode?'Новая сессия':'Машины'}</h2><p>{creationMode?'Проверьте выбранную машину и заполните параметры нового чата.':'Выберите, где смотреть историю и создавать сессии.'}</p></div><div className="fleet-header-actions">{!creationMode&&<nav className="fleet-quick-nav" aria-label="Переходы по кабинету"><button type="button" onClick={()=>jumpTo(sessionsElement.current)}>К сессиям</button><button type="button" onClick={()=>jumpTo(formElement.current,sending?formElement.current:nameElement.current)}>Новая сессия</button></nav>}<button type="button" className="quiet-button" disabled={loading} onClick={()=>{setError('');setRefresh(r=>r+1);}}>{loading?'Проверяю…':'Проверить связь'}</button></div></header>
  {loading&&<p role="status">Получаю список машин…</p>}
  {creationMode&&selected&&<p className="fleet-creation-target"><strong>{machineName(selected)} · {machineStatus(selected)}</strong><small>{machineReason(selected)}</small></p>}
  <details className="fleet-machine-choice" open={!creationMode||!selected}><summary>{creationMode?"Изменить машину":"Выбор машины"}</summary><fieldset className="fleet-machine-picker"><legend>Машина</legend><div className="fleet-hosts"><label className={`fleet-machine-option ${!hostId?'selected':''}`}><input type="radio" name="fleet-machine" value="" checked={!hostId} disabled={loading||sending} onChange={()=>{setHostId('');onSelectedHostChange?.('');if(receipt?.state!=='unknown')setReceipt(null);}}/><span><strong>Все машины</strong><small>Общий список сессий</small></span></label>{hosts.map(h=><label key={h.hostId} className={`fleet-machine-option ${hostId===h.hostId?'selected':''}`}><input type="radio" name="fleet-machine" value={h.hostId} checked={hostId===h.hostId} disabled={loading||sending} onChange={()=>{setHostId(h.hostId);onSelectedHostChange?.(h.hostId);if(receipt?.state!=='unknown')setReceipt(null);}}/><span><strong>{machineName(h)}</strong><span className={`machine-status ${h.state}`}>{machineStatus(h)}</span><small>{machineReason(h)}</small></span></label>)}</div></fieldset></details>
  {!creationMode&&selected?.uiUrl&&<a className="fleet-native-link" href={selected.uiUrl}>Открыть отдельный кабинет · {machineName(selected)} ↗</a>}
  {error&&<p role="alert">{error}</p>}{!creationMode&&partial&&<p>Показан неполный список сессий. Состояние подключения указано на карточках машин.</p>}
  <section ref={sessionsElement} tabIndex={-1} className="fleet-session-list" aria-label="Список сессий" hidden={creationMode}><h3>Сессии</h3><ul className="fleet-sessions" hidden={creationMode}>{sessions.map(s=>{const host=hosts.find(h=>h.hostId===s.address.hostId);const link=host&&fleetSessionLink(host,s.address);return <li key={s.key}><strong>{s.title||s.address.nativeSessionId}</strong><span>{host?.label??s.address.hostId} · {s.address.harness} · {fleetSessionStatus(s.status)}</span><span>Текущий проект: {s.project.currentCwd??'не подтверждён'}</span>{s.project.launchCwd&&<small>Каталог запуска: {s.project.launchCwd}</small>}{directRead?<button type="button" onClick={()=>inspect(s.address)}>Открыть сессию</button>:onSelectSession?<button type="button" onClick={()=>onSelectSession(s)}>Открыть сессию</button>:link&&<a href={link}>Открыть сессию</a>}</li>;})}</ul></section>
  {reading&&<p role="status">Читаю сессию выбранной машины…</p>}
  {view&&<article ref={viewElement} tabIndex={-1} className="fleet-session-view" aria-label="Сессия выбранной машины"><h3>{view.title}</h3><p>{hosts.find(h=>h.hostId===view.address.hostId)?.label??view.address.hostId} · {view.address.harness} · {view.model}</p><p>{view.cwd}</p>{view.historyUnavailable?<p>История этой нативной сессии пока недоступна. Сессия подтверждена; сообщения не отправлялись повторно.</p>:view.messages.length?view.messages.map((m,i)=><div key={i}><strong>{m.role==='user'?'Вы':m.role==='assistant'?'Агент':'Сообщение'}</strong><pre>{m.text??''}</pre></div>):<p>Сессия пока пустая.</p>}<button type="button" onClick={()=>setView(null)}>Закрыть просмотр</button></article>}
  <form ref={formElement} tabIndex={-1} aria-label="Новая сессия" onSubmit={submit}>{!creationMode&&<><h3>Новая сессия</h3><p>{selected?`На машине: ${machineName(selected)}`:'Для создания выберите одну машину выше.'}</p></>}
   <label>Среда <select value={harness} onChange={e=>setHarness(e.target.value as FleetHarness)} disabled={!allowed.length||sending}>{allowed.map(h=><option key={h}>{h}</option>)}</select></label>
   <label>Название <input ref={nameElement} required maxLength={128} value={name} onChange={e=>setName(e.target.value)} disabled={sending}/></label>
   <label>Каталог проекта на выбранной машине <input required placeholder={hostId==='MacBook-Pro-User.local'?'/Users/user/project':'/home/roomhacker/project'} maxLength={4096} value={cwd} onChange={e=>setCwd(e.target.value)} disabled={sending}/></label>
   <label>Модель <input placeholder="По умолчанию" maxLength={128} value={model} onChange={e=>setModel(e.target.value)} disabled={sending}/></label>
   <button disabled={sending||!canCreate||receipt?.state==='unknown'}>{sending?'Создаётся…':'Создать на выбранной машине'}</button>
  </form>
  {directRead&&receipt?.state==='created'&&receipt.address&&<button type="button" onClick={()=>inspect(receipt.address!)}>Открыть созданную сессию</button>}
  {!directRead&&receipt?.state==='created'&&receipt.address&&fleetSessionLink(hosts.find(h=>h.hostId===receipt.address!.hostId),receipt.address)&&<a className="fleet-created-link" href={fleetSessionLink(hosts.find(h=>h.hostId===receipt.address!.hostId),receipt.address)}>Открыть созданную сессию</a>}
  {receipt&&<p role="status">{receipt.state==='created'?'Сессия создана на выбранной машине.':receipt.state==='unknown'?'Ответ не получен. Создание могло завершиться; повторная отправка отключена. Проверьте список сессий.':'Сессия не создана. Проверьте доступность машины и среды.'}</p>}
  {receipt?.state==='unknown'&&<div><p>Можно сохранить этот запрос для проверки и начать другой. Исходный запрос повторно не отправляется.</p><button type="button" disabled={sending} onClick={deferUnknown}>Отложить проверку и начать другой запрос</button></div>}
  {!!archived.length&&<details><summary>Запросы с неизвестным результатом: {archived.length}</summary><ul>{archived.map(v=><li key={v.request.inputId}>{v.request.name} · {hosts.find(h=>h.hostId===v.request.hostId)?.label??v.request.hostId} · {v.request.harness}<button type="button" disabled={sending||loading} onClick={()=>setHostId(v.request.hostId)}>Показать сессии этой машины</button></li>)}</ul></details>}
 </section>;
}
