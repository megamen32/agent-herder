import * as React from 'react';
import './native-permission.css';

export type NativePermissionTarget={hostId:string;harness:string;sessionId:string;requestId:string};
export type NativePermissionResponse='allow'|'deny';
type Approval={state:'sent'|'unknown';response?:NativePermissionResponse;error?:string};
const targetKey=(target:NativePermissionTarget)=>JSON.stringify([target.hostId,target.harness,target.sessionId,target.requestId]);
const legacyTargetKey=(target:NativePermissionTarget)=>JSON.stringify([target.harness,target.sessionId,target.requestId]);

export type NativePermissionActionability='actionable'|'unsupported'|'stale'|'unavailable';
type NativePermissionActionTarget=Omit<NativePermissionTarget,'hostId'>&{hostId?:string};
export function nativePermissionActionability(state:unknown,target:NativePermissionActionTarget):NativePermissionActionability{
  if(!target.hostId||!state||typeof state!=='object'||Array.isArray(state))return 'unavailable';
  const snapshot=state as {target?:{hostId?:unknown;harness?:unknown;sessionId?:unknown};pendingRequests?:Array<{id?:unknown;canRespond?:unknown}>};
  if(snapshot.target?.hostId!==target.hostId||snapshot.target?.harness!==target.harness||snapshot.target?.sessionId!==target.sessionId)return 'stale';
  const request=snapshot.pendingRequests?.find((item)=>item?.id===target.requestId);
  if(!request)return 'stale';
  return request.canRespond===true?'actionable':'unsupported';
}

/** One explicit click answers one exact request. An unknown outcome is not replayed. */
export function createNativePermissionApproval(fetcher:typeof fetch=fetch,storage?:Pick<Storage,'getItem'|'setItem'>){
  const attempts=new Map<string,Promise<Approval>>();
  return (target:NativePermissionTarget,decision:NativePermissionResponse='allow'):Promise<Approval>=>{
    const key=targetKey(target),prior=attempts.get(key);
    if(prior)return prior;
    let saved:string|null=null,legacy=false;
    try{saved=storage?.getItem('agent-herder.permission.'+key)??null;
      // Older clients did not include hostId. Treat any legacy entry as an
      // ambiguous prior attempt and block replay; it cannot establish a fresh
      // result for this exact host.
      if(saved===null){saved=storage?.getItem('agent-herder.permission.'+legacyTargetKey(target))??null;legacy=saved!==null;}
    }catch{/* Storage may be disabled. */}
    if(saved){
      if(legacy)return Promise.resolve({state:'unknown',error:'Старый результат не привязан к точному хосту. Обновите запрос; повторная отправка не выполняется.'});
      const previousResponse=saved==='sent:allow'?'allow':saved==='sent:deny'?'deny':undefined;
      return Promise.resolve({state:saved==='sent'||previousResponse?'sent':'unknown',...(previousResponse?{response:previousResponse}:{}),error:saved==='unknown'?'Этот запрос уже отправлялся. Обновите состояние; повторная отправка не выполняется.':undefined});
    }
    try{storage?.setItem('agent-herder.permission.'+key,'unknown');}catch{/* In-memory fence still prevents duplicate clicks. */}
    const operation=(async():Promise<Approval>=>{
      try{
        const httpResponse=await fetcher(`/api/sessions/${encodeURIComponent(target.harness)}/${encodeURIComponent(target.sessionId)}/permissions/${encodeURIComponent(target.requestId)}`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({hostId:target.hostId,response:decision,remember:false}),
        });
        const result=await httpResponse.json() as {ok?:boolean;error?:string};
        if(!httpResponse.ok||result.ok!==true)return {state:'unknown',response:decision,error:result.error||'Ответ на разрешение не подтверждён. Обновите состояние запроса.'};
        try{storage?.setItem('agent-herder.permission.'+key,`sent:${decision}`);}catch{/* The in-memory result is retained. */}
        return {state:'sent',response:decision};
      }catch{return {state:'unknown',response:decision,error:'Ответ не получен. Обновите состояние; запрос не будет отправлен повторно.'};}
    })();
    attempts.set(key,operation);
    return operation;
  };
}

let approve:ReturnType<typeof createNativePermissionApproval>|undefined;
function approveOnce(target:NativePermissionTarget,response:NativePermissionResponse){
  if(!approve){let storage:Storage|undefined;try{storage=window.sessionStorage;}catch{/* Optional browser storage. */}approve=createNativePermissionApproval(fetch,storage);}
  return approve(target,response);
}

export function NativePermissionStrip({session,onRefresh}:{session:{id:string;harness:string;hostId?:string;permissionDetails?:{id:string;toolName?:string;description:string;details?:string};meta?:Record<string,unknown>};onRefresh:()=>void}){
  const [expanded,setExpanded]=React.useState(false),[sending,setSending]=React.useState(false),[result,setResult]=React.useState<Approval>();
  const [permissionState,setPermissionState]=React.useState<unknown>(null),[checking,setChecking]=React.useState(true),[readError,setReadError]=React.useState<string>();
  const live=React.useRef(true);
  React.useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const permission=session.permissionDetails;
  const refreshPermissionState=React.useCallback(async()=>{
    setChecking(true);setReadError(undefined);setPermissionState(null);
    if(!session.hostId||!permission?.id){setChecking(false);return;}
    try{
      const path=`/api/sessions/${encodeURIComponent(session.harness)}/${encodeURIComponent(session.id)}/permissions?hostId=${encodeURIComponent(session.hostId)}`;
      const response=await fetch(path,{cache:'no-store'});
      const body=await response.json() as {available?:boolean;permissionState?:unknown;reason?:string;error?:string};
      if(!response.ok||body.available!==true)throw new Error(body.error||body.reason||'Нативная проверка разрешения недоступна.');
      setPermissionState(body.permissionState??null);
    }catch(error){setReadError(error instanceof Error?error.message:'Нативная проверка разрешения недоступна.');}
    finally{setChecking(false);}
  },[session.harness,session.hostId,session.id,permission?.id]);
  React.useEffect(()=>{void refreshPermissionState();},[refreshPermissionState]);
  const actionability=permission?.id?nativePermissionActionability(permissionState,{harness:session.harness,sessionId:session.id,requestId:permission.id,hostId:session.hostId}):'stale';
  const pending=permissionState&&typeof permissionState==='object'&&!Array.isArray(permissionState)
    ?(permissionState as {pendingRequests?:Array<{id?:string;unsupportedReason?:string}>}).pendingRequests?.find((request)=>request.id===permission?.id):undefined;
  const actionabilityText=checking?'Проверяю точный запрос…':actionability==='unsupported'
    ?(pending?.unsupportedReason||'Эта среда не позволяет ответить на запрос через Herder.')
    :actionability==='stale'?'Нативный запрос больше не ожидает ответа или его точная сессия изменилась.'
      :actionability==='unavailable'?(readError||'Не удалось подтвердить точную нативную сессию.'):'Однократное разрешение выбранного запроса. Постоянные права не меняются.';
  const respond=async(response:NativePermissionResponse)=>{
    if(!permission?.id||actionability!=='actionable'||checking||sending||result)return;
    setSending(true);
    if(!session.hostId)return;
    const outcome=await approveOnce({hostId:session.hostId,harness:session.harness,sessionId:session.id,requestId:permission.id},response);
    if(!live.current)return;
    setResult(outcome);setSending(false);onRefresh();
  };
  return <div className="native-permission-strip" role="region" aria-label="Запрос разрешения">
    <div className="native-permission-row">
      <button type="button" className="native-permission-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><span aria-hidden="true">{expanded?'▾':'▸'}</span> Нужно разрешение</button>
      <span className="native-permission-tool" title={permission?.toolName}>{permission?.toolName?.split('__').at(-1)}</span>
      <button type="button" className="native-permission-allow" disabled={!permission?.id||actionability!=='actionable'||checking||sending||Boolean(result)} onClick={()=>void respond('allow')}>{sending?'Отправляю…':result?.state==='sent'?(result.response==='allow'?'Разрешено':result.response==='deny'?'Запрещено':'Ответ отправлен'):result?'Не подтверждено':actionability==='actionable'?'Разрешить':'Недоступно'}</button>
      <button type="button" className="native-permission-deny" disabled={!permission?.id||actionability!=='actionable'||checking||sending||Boolean(result)} onClick={()=>void respond('deny')}>{sending?'Отправляю…':result?.state==='sent'?(result.response==='deny'?'Запрещено':result.response==='allow'?'Разрешено':'Ответ отправлен'):result?'Не подтверждено':actionability==='actionable'?'Запретить':'Недоступно'}</button>
      {(result?.state==='unknown'||actionability!=='actionable')&&<button type="button" className="native-permission-refresh" disabled={checking} onClick={()=>{void refreshPermissionState();onRefresh();}}>{checking?'Читаю…':'Обновить'}</button>}
    </div>
    {expanded&&<div className="native-permission-details">
      <p role={actionability==='actionable'?'note':'status'}>{actionabilityText}</p>
      {permission?.toolName&&<p>Инструмент: {permission.toolName}</p>}
      {permission?.description&&<p>{permission.description}</p>}
      <p>{session.hostId} · {session.harness} · {session.id}<br/>Запрос: {permission?.id||'идентификатор недоступен'}{typeof session.meta?.activityObservedAt==='string'&&<><br/>Проверено: {session.meta.activityObservedAt}</>}</p>
      {result?.error&&<p role="status">{result.error}</p>}
    </div>}
  </div>;
}
