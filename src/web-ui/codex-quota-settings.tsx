import React from "react";
type Policy={enabled:boolean;minRemainingPercent:number;onUnknown:"block"|"allow"};
type State={policy:Policy;revision:string;decision:{allowed:boolean;reason:string;remainingPercent:number|null;checkedAt:string;windows:Array<{name:string;remainingPercent:number}>};lastDenial?:{operation:string;decision:{checkedAt:string;reason:string}}};
export function CodexQuotaSettings(){
 const [state,setState]=React.useState<State|null>(null),[draft,setDraft]=React.useState<Policy|null>(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(""),[saved,setSaved]=React.useState(false);
 const load=React.useCallback(async()=>{setBusy(true);setError("");try{const r=await fetch("/api/codex-quota-guard");if(!r.ok)throw Error("Не удалось прочитать защиту квоты");const v=await r.json() as State;setState(v);setDraft(v.policy);}catch(e){setError((e as Error).message);}finally{setBusy(false);}},[]);
 React.useEffect(()=>{void load();},[load]);
 const save=async()=>{if(!draft||!state)return;setBusy(true);setError("");setSaved(false);try{const r=await fetch("/api/codex-quota-guard",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({policy:draft,revision:state.revision})});const v=await r.json();if(!r.ok)throw Error(v.error||"Не удалось сохранить");setState(v);setDraft(v.policy);setSaved(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <section className="settings-section" aria-label="Защита лимита Codex" style={{padding:"16px",border:"1px solid var(--border-color, #8885)",borderRadius:12,margin:"12px 0"}}>
  <h3>Защита лимита Codex</h3>
  <p>Проверка перед созданием сессии, новым заданием и автопродолжением. Уже выполняющийся ответ не останавливается. Просмотр истории остаётся доступен.</p>
  {state&&<p role="status">{state.decision.allowed?"Новые обращения разрешены":"Новые обращения заблокированы"}. Остаток: <strong>{state.decision.remainingPercent===null?"неизвестен":state.decision.remainingPercent+"%"}</strong>. Причина: {state.decision.reason}.</p>}
  {draft&&<fieldset disabled={busy} style={{border:0,padding:0,display:"grid",gap:12}}>
   <label><input type="checkbox" checked={draft.enabled} onChange={e=>{setDraft({...draft,enabled:e.target.checked});setSaved(false);}}/> Включить защиту</label>
   <label>Минимальный остаток, % <input aria-label="Минимальный остаток Codex" type="number" min={0} max={100} step={1} value={draft.minRemainingPercent} onChange={e=>{setDraft({...draft,minRemainingPercent:Number(e.target.value)});setSaved(false);}}/></label>
   <label>Если квота неизвестна <select value={draft.onUnknown} onChange={e=>{setDraft({...draft,onUnknown:e.target.value as Policy["onUnknown"]});setSaved(false);}}><option value="block">Блокировать (рекомендуется)</option><option value="allow">Разрешать на мой риск</option></select></label>
   {(!draft.enabled||draft.onUnknown==="allow")&&<p role="note">Внимание: отключённая защита или разрешение неизвестной квоты могут потратить резерв.</p>}
   <div><button type="button" onClick={()=>void save()}>Сохранить</button> <button type="button" onClick={()=>void load()}>Обновить квоту</button></div>
  </fieldset>}
  {busy&&<p role="status">Проверяю квоту…</p>}{saved&&<p role="status">Настройка сохранена и действует без перезапуска.</p>}{error&&<p role="alert">{error}</p>}
  {state?.lastDenial&&<small>Последний отказ: {state.lastDenial.operation}, {state.lastDenial.decision.reason}.</small>}
 </section>;
}
