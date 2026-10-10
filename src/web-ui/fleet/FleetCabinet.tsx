import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {FleetHost,FleetSession,FleetHarness,FleetCreateReceipt} from '../../mesh/fleet-contract.js';
import {createFleetClient,type FleetClient} from './client.js';
import './fleet.css';
import {FleetBrowserIntent,type FleetIntent} from './intent.js';
import type {MeshAddress} from '../../mesh/protocol.js';
import {fleetSessionLink} from './session-link.js';
const states={ready:'Доступен',metadata_only:'Только просмотр',offline:'Не в сети',unavailable:'Не отвечает',stale:'Данные устарели'};
const hostState=(host:FleetHost)=>host.reason==='local_herder_not_registered'?'Herder не подключён':states[host.state];
/** Mount once for one authenticated browser identity. Remote session selection retains its full native address. */
export function FleetCabinet({defaultHostId,onSelectSession,client:injected}:{defaultHostId?:string;onSelectSession?:(session:FleetSession)=>void;client?:FleetClient}){
 const client=useRef(injected??createFleetClient()).current;
 const [hosts,setHosts]=useState<FleetHost[]>([]),[hostId,setHostId]=useState(defaultHostId??''),[sessions,setSessions]=useState<FleetSession[]>([]);
 const [loaded,setLoaded]=useState(false),[loading,setLoading]=useState(true),[partial,setPartial]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [harness,setHarness]=useState<FleetHarness>('codex'),[name,setName]=useState(''),[cwd,setCwd]=useState(''),[model,setModel]=useState('');
 const [sending,setSending]=useState(false),[receipt,setReceipt]=useState<FleetCreateReceipt|null>(null);
 const [directRead,setDirectRead]=useState(false),[view,setView]=useState<{address:MeshAddress;title:string;cwd?:string;model?:string;messages:{text?:string;role?:string;kind?:string}[]}|null>(null),[reading,setReading]=useState(false);
 const viewRequest=useRef<AbortController|null>(null);
 const inspect=async(address:MeshAddress)=>{
  if(!client.session)return;viewRequest.current?.abort();const abort=new AbortController();viewRequest.current=abort;setReading(true);setView(null);
  try{const r=await client.session(address,abort.signal);if(abort.signal.aborted)return;if(r.hostId!==address.hostId||r.details.session.id!==address.nativeSessionId||r.details.session.harness!==address.harness)throw new Error('foreign_session');setView({address,title:r.details.session.title??address.nativeSessionId,cwd:r.details.session.cwd,model:r.details.session.model,messages:(r.details.messages??[]).slice(-3)});}
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
 useEffect(()=>{const abort=new AbortController();setLoading(true);client.hosts(abort.signal,refresh>0).then(r=>{if(abort.signal.aborted)return;setHosts(r.hosts);setDirectRead(r.sessionReadSupported===true);if(!initialized.current){intentStore.current=new FleetBrowserIntent(localStorage,r.scopeKey);setArchived(intentStore.current.archivedUnknown());const saved=intentStore.current.load();if(saved){setHostId(saved.request.hostId);setName(saved.request.name);setCwd(saved.request.cwd);setHarness(saved.request.harness);setModel(saved.request.model??'');setReceipt(saved.receipt);}else if(!defaultHostId)setHostId(r.defaultHostId);initialized.current=true;}setLoaded(true);}).catch(()=>{if(!abort.signal.aborted)setError('Не удалось получить список машин');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();},[client,defaultHostId,refresh]);
 useEffect(()=>{if(!loaded)return;const abort=new AbortController();setSessions([]);client.sessions(hostId||undefined,abort.signal).then(r=>{if(abort.signal.aborted)return;setSessions(r.sessions);setPartial(!r.complete||r.limited);}).catch(()=>{if(!abort.signal.aborted)setError('Не удалось прочитать сессии этой машины');});return()=>abort.abort();},[client,hostId,loaded,refresh]);
 const selected=hosts.find(h=>h.hostId===hostId);
 const allowed=selected?.createHarnesses??[];
 useEffect(()=>{if(!allowed.includes(harness)&&allowed.length)setHarness(allowed[0]!);},[selected]);
 const submit=async(event:FormEvent)=>{
  event.preventDefault();if(ownMutation.current||receipt?.state==='unknown')return;
  const inputId=crypto.randomUUID();const request={hostId,harness,name,cwd,...(model.trim()?{model:model.trim()}:{}),inputId};
  try{if(!intentStore.current)throw new Error('Нет сохранённого состояния кабинета');intentStore.current.begin(request);}catch{setError('Не удалось сохранить запрос. Создание не отправлено.');return;}
  ownMutation.current=true;setSending(true);setError('');
  // One POST. Lost response locks this intent; subsequent reads are GET only.
  try{const result=await client.create(request);intentStore.current!.finish(result);setReceipt(result);if(result.state==='created')setRefresh(r=>r+1);}
  catch{setReceipt({state:'unknown',inputId,retryable:false});}
  finally{ownMutation.current=false;setSending(false);}
 };
 return <section className="fleet-cabinet" aria-label="Машины и сессии">
  <header><h2>Машины и сессии</h2><button type="button" onClick={()=>{setError('');setRefresh(r=>r+1);}}>Обновить</button></header>
  {loading&&<p role="status">Получаю список машин…</p>}
  <label>Машина <select value={hostId} disabled={loading||sending} onChange={e=>{setHostId(e.target.value);if(receipt?.state!=='unknown')setReceipt(null);}}><option value="">Все машины</option>{hosts.map(h=><option key={h.hostId} value={h.hostId}>{h.label} · {hostState(h)}</option>)}</select></label>
  <div className="fleet-hosts">{hosts.map(h=><article key={h.hostId}><strong>{h.label}</strong><span>{hostState(h)}</span>{h.uiUrl&&<a href={h.uiUrl}>Открыть кабинет</a>}</article>)}</div>
  {error&&<p role="alert">{error}</p>}{partial&&<p>Показана часть доступных сессий. У некоторых машин нет свежих данных.</p>}
  <ul className="fleet-sessions">{sessions.map(s=>{const host=hosts.find(h=>h.hostId===s.address.hostId);const link=host&&fleetSessionLink(host,s.address);return <li key={s.key}><strong>{s.title||s.address.nativeSessionId}</strong><span>{host?.label??s.address.hostId} · {s.address.harness} · {s.status}</span><span>Текущий проект: {s.project.currentCwd??'не подтверждён'}</span>{s.project.launchCwd&&<small>Каталог запуска: {s.project.launchCwd}</small>}{directRead?<button type="button" onClick={()=>inspect(s.address)}>Открыть сессию</button>:onSelectSession?<button type="button" onClick={()=>onSelectSession(s)}>Открыть сессию</button>:link&&<a href={link}>Открыть сессию</a>}</li>;})}</ul>
  {reading&&<p role="status">Читаю сессию выбранной машины…</p>}
  {view&&<article className="fleet-session-view" aria-label="Сессия выбранной машины"><h3>{view.title}</h3><p>{hosts.find(h=>h.hostId===view.address.hostId)?.label??view.address.hostId} · {view.address.harness} · {view.model}</p><p>{view.cwd}</p>{view.messages.length?view.messages.map((m,i)=><div key={i}><strong>{m.role==='user'?'Вы':m.role==='assistant'?'Агент':'Сообщение'}</strong><pre>{m.text??''}</pre></div>):<p>Сессия пока пустая.</p>}<button type="button" onClick={()=>setView(null)}>Закрыть просмотр</button></article>}
  <form onSubmit={submit}><h3>Новая сессия</h3><p>{selected?selected.label:'Выберите машину'}</p>
   <label>Среда <select value={harness} onChange={e=>setHarness(e.target.value as FleetHarness)} disabled={!allowed.length||sending}>{allowed.map(h=><option key={h}>{h}</option>)}</select></label>
   <label>Название <input required maxLength={128} value={name} onChange={e=>setName(e.target.value)} disabled={sending}/></label>
   <label>Каталог проекта на выбранной машине <input required placeholder="/home/roomhacker/project" maxLength={4096} value={cwd} onChange={e=>setCwd(e.target.value)} disabled={sending}/></label>
   <label>Модель <input placeholder="По умолчанию" maxLength={128} value={model} onChange={e=>setModel(e.target.value)} disabled={sending}/></label>
   <button disabled={loading||sending||!allowed.includes(harness)||selected?.state!=='ready'||receipt?.state==='unknown'}>{sending?'Создаётся…':'Создать на выбранной машине'}</button>
  </form>
  {directRead&&receipt?.state==='created'&&receipt.address&&<button type="button" onClick={()=>inspect(receipt.address!)}>Открыть созданную сессию</button>}
  {!directRead&&receipt?.state==='created'&&receipt.address&&fleetSessionLink(hosts.find(h=>h.hostId===receipt.address!.hostId),receipt.address)&&<a className="fleet-created-link" href={fleetSessionLink(hosts.find(h=>h.hostId===receipt.address!.hostId),receipt.address)}>Открыть созданную сессию</a>}
  {receipt&&<p role="status">{receipt.state==='created'?'Сессия создана на выбранной машине.':receipt.state==='unknown'?'Ответ не получен. Создание могло завершиться; повторная отправка отключена. Проверьте список сессий.':'Сессия не создана. Проверьте доступность машины и среды.'}</p>}
  {receipt?.state==='unknown'&&<div><p>Можно сохранить этот запрос для проверки и начать другой. Исходный запрос повторно не отправляется.</p><button type="button" disabled={sending} onClick={deferUnknown}>Отложить проверку и начать другой запрос</button></div>}
  {!!archived.length&&<details><summary>Запросы с неизвестным результатом: {archived.length}</summary><ul>{archived.map(v=><li key={v.request.inputId}>{v.request.name} · {hosts.find(h=>h.hostId===v.request.hostId)?.label??v.request.hostId} · {v.request.harness}<button type="button" disabled={sending||loading} onClick={()=>setHostId(v.request.hostId)}>Показать сессии этой машины</button></li>)}</ul></details>}
 </section>;
}
