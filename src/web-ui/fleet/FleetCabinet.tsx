import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {FleetHost,FleetSession,FleetHarness,FleetCreateReceipt} from '../../mesh/fleet-contract.js';
import {createFleetClient,type FleetClient} from './client.js';
import './fleet.css';
import {FleetBrowserIntent} from './intent.js';
const states={ready:'Доступен',metadata_only:'Только просмотр',offline:'Не в сети',unavailable:'Herder не подключён',stale:'Данные устарели'};
const nativeLink=(host:FleetHost,session:FleetSession)=>host.uiUrl?host.uiUrl.replace(/\/$/,'')+'/#/session/'+encodeURIComponent(session.address.harness+':'+session.address.nativeSessionId):undefined;
/** Mount once for one authenticated browser identity. Remote session selection retains its full native address. */
export function FleetCabinet({defaultHostId,onSelectSession,client:injected}:{defaultHostId?:string;onSelectSession?:(session:FleetSession)=>void;client?:FleetClient}){
 const client=useRef(injected??createFleetClient()).current;
 const [hosts,setHosts]=useState<FleetHost[]>([]),[hostId,setHostId]=useState(defaultHostId??''),[sessions,setSessions]=useState<FleetSession[]>([]);
 const [loaded,setLoaded]=useState(false),[partial,setPartial]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [harness,setHarness]=useState<FleetHarness>('codex'),[name,setName]=useState(''),[cwd,setCwd]=useState(''),[model,setModel]=useState('');
 const [sending,setSending]=useState(false),[receipt,setReceipt]=useState<FleetCreateReceipt|null>(null);
 const ownMutation=useRef(false), initialized=useRef(false), intentStore=useRef<FleetBrowserIntent|null>(null);
 useEffect(()=>{const abort=new AbortController();client.hosts(abort.signal,refresh>0).then(r=>{if(abort.signal.aborted)return;setHosts(r.hosts);if(!initialized.current){intentStore.current=new FleetBrowserIntent(localStorage,r.scopeKey);const saved=intentStore.current.load();if(saved){setHostId(saved.request.hostId);setName(saved.request.name);setCwd(saved.request.cwd);setHarness(saved.request.harness);setModel(saved.request.model??'');setReceipt(saved.receipt);}else if(!defaultHostId)setHostId(r.defaultHostId);initialized.current=true;}setLoaded(true);}).catch(()=>{if(!abort.signal.aborted)setError('Не удалось получить список машин');});return()=>abort.abort();},[client,defaultHostId,refresh]);
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
  <label>Машина <select value={hostId} disabled={sending||receipt?.state==='unknown'} onChange={e=>{setHostId(e.target.value);if(receipt?.state!=='unknown')setReceipt(null);}}><option value="">Все машины</option>{hosts.map(h=><option key={h.hostId} value={h.hostId}>{h.label} · {states[h.state]}</option>)}</select></label>
  <div className="fleet-hosts">{hosts.map(h=><article key={h.hostId}><strong>{h.label}</strong><span>{states[h.state]}</span>{h.uiUrl&&<a href={h.uiUrl}>Открыть кабинет</a>}</article>)}</div>
  {error&&<p role="alert">{error}</p>}{partial&&<p>Показана часть доступных сессий. У некоторых машин нет свежих данных.</p>}
  <ul className="fleet-sessions">{sessions.map(s=>{const host=hosts.find(h=>h.hostId===s.address.hostId);const link=host&&nativeLink(host,s);return <li key={s.key}><strong>{s.title||s.address.nativeSessionId}</strong><span>{host?.label??s.address.hostId} · {s.address.harness} · {s.status}</span><span>Текущий проект: {s.project.currentCwd??'не подтверждён'}</span>{s.project.launchCwd&&<small>Каталог запуска: {s.project.launchCwd}</small>}{onSelectSession?<button type="button" onClick={()=>onSelectSession(s)}>Открыть сессию</button>:link&&<a href={link}>Открыть сессию</a>}</li>;})}</ul>
  <form onSubmit={submit}><h3>Новая сессия</h3><p>{selected?selected.label:'Выберите машину'}</p>
   <label>Среда <select value={harness} onChange={e=>setHarness(e.target.value as FleetHarness)} disabled={!allowed.length||sending}>{allowed.map(h=><option key={h}>{h}</option>)}</select></label>
   <label>Название <input required maxLength={128} value={name} onChange={e=>setName(e.target.value)} disabled={sending}/></label>
   <label>Каталог проекта на выбранной машине <input required placeholder="/home/roomhacker/project" maxLength={4096} value={cwd} onChange={e=>setCwd(e.target.value)} disabled={sending}/></label>
   <label>Модель <input placeholder="По умолчанию" maxLength={128} value={model} onChange={e=>setModel(e.target.value)} disabled={sending}/></label>
   <button disabled={sending||!allowed.includes(harness)||selected?.state!=='ready'||receipt?.state==='unknown'}>{sending?'Создаётся…':'Создать на выбранной машине'}</button>
  </form>
  {receipt&&<p role="status">{receipt.state==='created'?'Сессия создана на выбранной машине.':receipt.state==='unknown'?'Ответ не получен. Создание могло завершиться; повторная отправка отключена. Проверьте список сессий.':'Сессия не создана. Проверьте доступность машины и среды.'}</p>}
 </section>;
}
