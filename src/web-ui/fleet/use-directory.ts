import {useEffect,useRef,useState} from 'react';
import {mergeDirectoryRows} from './session-directory.js';
import {createFleetClient} from './client.js';
import type {FleetHost} from '../../mesh/fleet-contract.js';
import type {InventorySession} from '../../mesh/session-page.js';
export function useFleetDirectory(selectedHostId?:string){
 const client=useRef(createFleetClient()).current;
 const [hosts,setHosts]=useState<FleetHost[]>([]),[scope,setScope]=useState(''),[localHostId,setLocalHostId]=useState(''),[rows,setRows]=useState<InventorySession[]>([]),[pending,setPending]=useState(false),[partial,setPartial]=useState(false),[more,setMore]=useState(false),[error,setError]=useState('');
 const rowsRef=useRef<InventorySession[]>([]),run=useRef(0),cappedState=useRef(false),busyHost=useRef<string|undefined>(undefined);
 const cursors=useRef<Record<string,string>>({}),busy=useRef(false),scopeRef=useRef('');
 const load=async(continuePages=false,signal?:AbortSignal)=>{
  if(busy.current&&busyHost.current===selectedHostId)return;const runId=++run.current;busyHost.current=selectedHostId;busy.current=true;setPending(true);setError('');
  const deadline=AbortSignal.timeout(60000);const bounded=signal?AbortSignal.any([signal,deadline]):deadline;
  try{
   if(!continuePages){const info=await client.hosts(bounded);if(bounded.aborted||runId!==run.current)return;setHosts(info.hosts);setLocalHostId(info.defaultHostId);setScope(info.scopeKey);if(scopeRef.current!==info.scopeKey){rowsRef.current=[];setRows([]);}scopeRef.current=info.scopeKey;cursors.current={};cappedState.current=false;}
   const collected=new Map<string,InventorySession>();let incomplete=false;let capped=continuePages&&cappedState.current;
   for(let page=0;page<12;page++){
    const r=await client.inventory!(page===0&&!continuePages?undefined:cursors.current,bounded,selectedHostId);if(bounded.aborted||runId!==run.current)return;
    if(r.scopeKey!==scopeRef.current)throw new Error('directory_scope_changed');setHosts(current=>current.map(h=>r.hosts.find(next=>next.hostId===h.hostId)??h));
    const next:Record<string,string>={};
    for(const p of r.pages){incomplete ||= p.partial;for(const row of p.sessions)collected.set(JSON.stringify(row.address),row);if(p.nextCursor)next[p.hostId]=p.nextCursor;}
    // Follow only hosts with a next page; completed hosts are not read again.
    cursors.current=next;setMore(Object.keys(next).length>0);
    const merged=mergeDirectoryRows(page===0&&!continuePages?[]:rowsRef.current,[...collected.values()]);rowsRef.current=merged.rows;setRows(merged.rows);capped ||= merged.limited;cappedState.current=capped;
    if(capped)setError('Список очень большой: показано последнее окно названий. Выберите конкретную машину.');
    setPartial(incomplete||capped||Object.keys(next).length>0);
    if(!Object.keys(next).length)break;
   }
  }catch{if(!signal?.aborted&&runId===run.current){setPartial(true);setError('Часть машин пока не отвечает. Доступные сессии сохранены в списке.');}}
  finally{if(runId===run.current){busy.current=false;if(!signal?.aborted)setPending(false);}}
 };
 useEffect(()=>{const abort=new AbortController();void load(false,abort.signal);const timer=setInterval(()=>void load(false,abort.signal),60000);return()=>{abort.abort();clearInterval(timer);};},[selectedHostId]);
 return {hosts,scope,localHostId,rows,pending,partial,more,error,load};
}
