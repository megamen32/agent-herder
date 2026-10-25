import * as React from 'react';
import './native-permission.css';

export type NativePermissionTarget={harness:string;sessionId:string;requestId:string};
type Approval={state:'sent'|'unknown';error?:string};
const targetKey=(target:NativePermissionTarget)=>JSON.stringify([target.harness,target.sessionId,target.requestId]);

/** One explicit click answers one exact request. An unknown outcome is not replayed. */
export function createNativePermissionApproval(fetcher:typeof fetch=fetch,storage?:Pick<Storage,'getItem'|'setItem'>){
  const attempts=new Map<string,Promise<Approval>>();
  return (target:NativePermissionTarget):Promise<Approval>=>{
    const key=targetKey(target),prior=attempts.get(key);
    if(prior)return prior;
    let saved:string|null=null;
    try{saved=storage?.getItem('agent-herder.permission.'+key)??null;}catch{/* Storage may be disabled. */}
    if(saved)return Promise.resolve({state:saved==='sent'?'sent':'unknown',error:saved==='sent'?undefined:'Этот запрос уже отправлялся. Обновите состояние; повторная отправка не выполняется.'});
    try{storage?.setItem('agent-herder.permission.'+key,'unknown');}catch{/* In-memory fence still prevents duplicate clicks. */}
    const operation=(async():Promise<Approval>=>{
      try{
        const response=await fetcher(`/api/sessions/${encodeURIComponent(target.harness)}/${encodeURIComponent(target.sessionId)}/permissions/${encodeURIComponent(target.requestId)}`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({response:'allow',remember:false}),
        });
        const result=await response.json() as {ok?:boolean;error?:string};
        if(!response.ok||result.ok!==true)return {state:'unknown',error:result.error||'Разрешение не подтверждено. Обновите состояние запроса.'};
        try{storage?.setItem('agent-herder.permission.'+key,'sent');}catch{/* The in-memory result is retained. */}
        return {state:'sent'};
      }catch{return {state:'unknown',error:'Ответ не получен. Обновите состояние; запрос не будет отправлен повторно.'};}
    })();
    attempts.set(key,operation);
    return operation;
  };
}

let approve:ReturnType<typeof createNativePermissionApproval>|undefined;
function approveOnce(target:NativePermissionTarget){
  if(!approve){let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{/* Optional browser storage. */}approve=createNativePermissionApproval(fetch,storage);}
  return approve(target);
}

export function NativePermissionStrip({session,onRefresh}:{session:{id:string;harness:string;hostId?:string;permissionDetails?:{id:string;toolName?:string;description:string;details?:string};meta?:Record<string,unknown>};onRefresh:()=>void}){
  const [expanded,setExpanded]=React.useState(false),[sending,setSending]=React.useState(false),[result,setResult]=React.useState<Approval>();
  const live=React.useRef(true);
  React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const permission=session.permissionDetails;
  const allow=async()=>{
    if(!permission?.id||sending||result)return;
    setSending(true);
    const outcome=await approveOnce({harness:session.harness,sessionId:session.id,requestId:permission.id});
    if(!live.current)return;
    setResult(outcome);setSending(false);onRefresh();
  };
  return <div className="native-permission-strip" role="region" aria-label="Запрос разрешения">
    <div className="native-permission-row">
      <button type="button" className="native-permission-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><span aria-hidden="true">{expanded?'▾':'▸'}</span> Нужно разрешение</button>
      <span className="native-permission-tool" title={permission?.toolName}>{permission?.toolName?.split('__').at(-1)}</span>
      <button type="button" className="native-permission-allow" disabled={!permission?.id||sending||Boolean(result)} onClick={()=>void allow()}>{sending?'Отправляю…':result?.state==='sent'?'Разрешено':result?'Не подтверждено':'Разрешить'}</button>
      {result?.state==='unknown'&&<button type="button" className="native-permission-refresh" onClick={onRefresh}>Обновить</button>}
    </div>
    {expanded&&<div className="native-permission-details">
      <p>Однократное разрешение выбранного запроса. Постоянные права не меняются.</p>
      {permission?.toolName&&<p>Инструмент: {permission.toolName}</p>}
      {permission?.description&&<p>{permission.description}</p>}
      <p>{session.hostId} · {session.harness} · {session.id}<br/>Запрос: {permission?.id||'идентификатор недоступен'}{typeof session.meta?.activityObservedAt==='string'&&<><br/>Проверено: {session.meta.activityObservedAt}</>}</p>
      {result?.error&&<p role="status">{result.error}</p>}
    </div>}
  </div>;
}
