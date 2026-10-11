import {useEffect,useState} from 'react';
import type {MeshAddress} from '../../mesh/protocol.js';
import type {FleetHost} from '../../mesh/fleet-contract.js';
import {createFleetClient,type FleetClient} from './client.js';
import type {SessionViewCache} from './view-cache.js';
import {fleetSessionLink} from './session-link.js';
type View=Awaited<ReturnType<NonNullable<FleetClient['session']>>>;
const client=createFleetClient();
export function RemoteSessionView({address,host,scope,cache,onClose}:{address:MeshAddress;host:FleetHost;scope:string;cache:SessionViewCache;onClose:()=>void}){
 const [view,setView]=useState<View>(),[cached,setCached]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();let fresh=false;setView(undefined);setLoading(true);setCached(false);setError('');
  void cache.get<View>(scope,address).then(r=>{if(!abort.signal.aborted&&!fresh&&r&&r.value.hostId===address.hostId&&r.value.details?.session.id===address.nativeSessionId&&r.value.details.session.harness===address.harness){setView(r.value);setCached(true);}});
  void client.session!(address,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])).then(r=>{if(abort.signal.aborted)return;if(r.hostId!==address.hostId||r.details.session.id!==address.nativeSessionId||r.details.session.harness!==address.harness)throw new Error('identity');fresh=true;setView(r);setCached(false);void cache.put(scope,address,r);}).catch(()=>{if(!abort.signal.aborted)setError('Свежая история пока недоступна. Сохранённый просмотр может быть устаревшим.');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});return()=>abort.abort();
 },[address.hostId,address.harness,address.nativeSessionId,scope,cache]);
 const link=fleetSessionLink(host,address);
 return <section className="remote-session-pane" aria-label="Сессия другой машины"><header><button className="quiet-button" onClick={onClose}>← Назад</button><h2>{view?.details.session.title??address.nativeSessionId}</h2><p>{host.label} · {address.harness}</p>{link&&<a className="primary-button" href={link}>Работать с сессией на {host.label} ↗</a>}</header>{cached&&<p role="status">Сохранённый просмотр{loading?' · обновляется…':''}</p>}{loading&&!view&&<p role="status">Загрузка истории…</p>}{error&&<p role="alert">{error}</p>}{view?.details.historyUnavailable?<p>Сессия подтверждена, история пока недоступна.</p>:view?.details.messages?.length?view.details.messages.map((m,i)=><article key={i}><strong>{m.role==='user'?'Вы':'Агент'}</strong><pre>{m.text??''}</pre></article>):view&&<p>Сессия пока пустая.</p>}</section>;
}
