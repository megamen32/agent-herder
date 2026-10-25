import * as React from 'react';
import {canDeleteOutboxEntry,outboxStatusLabel,type OutboxEntry} from './composer-delivery.js';
import './composer-queue.css';

export const canEditQueuedEntry=(entry:OutboxEntry)=>entry.mode==='queue'&&(
  entry.status==='ready'||Boolean(entry.jobId)&&['deferred','pending'].includes(entry.status));

export function ComposerQueue({entries,busy,pending,canSteer,onSteer,onCancel,onEdit,onCheck,onRetry,onDismiss}:{
  entries:OutboxEntry[];busy:ReadonlySet<string>;pending:(id:string)=>boolean;canSteer:(entry:OutboxEntry)=>boolean;
  onSteer:(id:string)=>void;onCancel:(id:string)=>void;onEdit:(id:string)=>void;onCheck:(entry:OutboxEntry)=>void;onRetry:(id:string)=>void;onDismiss:(id:string)=>void;
}){
  const [expanded,setExpanded]=React.useState<Set<string>>(new Set());
  const toggle=(id:string)=>setExpanded(current=>{const next=new Set(current);next.has(id)?next.delete(id):next.add(id);return next;});
  return <div className="composer-queue" aria-label="Очередь сообщений">{entries.map(entry=><div className={`composer-queue-item queue-${entry.status}`} key={entry.inputId}>
    <div className="composer-queue-row">
      <button type="button" className="composer-queue-expand" aria-label={expanded.has(entry.inputId)?'Свернуть сообщение очереди':'Развернуть сообщение очереди'} aria-expanded={expanded.has(entry.inputId)} onClick={()=>toggle(entry.inputId)}>{expanded.has(entry.inputId)?'▾':'▸'}</button>
      <span className="composer-queue-icon" title={outboxStatusLabel(entry.status)} aria-label={outboxStatusLabel(entry.status)}>↳</span>
      <button type="button" className="composer-queue-preview" title={entry.text} onClick={()=>toggle(entry.inputId)}>{entry.text||'Прикреплённое изображение'}</button>
      {canSteer(entry)&&<button type="button" className="composer-queue-steer" disabled={busy.has(entry.inputId)} onClick={()=>onSteer(entry.inputId)} title="Отправить в текущий ход, не прерывая работу модели"><span aria-hidden="true">↪</span><span>Скорректировать</span></button>}
      {canEditQueuedEntry(entry)&&<button type="button" className="composer-queue-action" disabled={busy.has(entry.inputId)} aria-label="Редактировать сообщение очереди" title="Редактировать" onClick={()=>onEdit(entry.inputId)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13 8-8 3 3-8 8-4 1zM11 6l3 3"/></svg></button>}
      {canDeleteOutboxEntry(entry)&&<button type="button" className="composer-queue-action" disabled={busy.has(entry.inputId)} aria-label="Отменить сообщение очереди" title="Отменить" onClick={()=>onCancel(entry.inputId)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6"/></svg></button>}
      <button type="button" className="composer-queue-action" aria-label="Подробнее о сообщении очереди" aria-expanded={expanded.has(entry.inputId)} title="Подробнее" onClick={()=>toggle(entry.inputId)}>···</button>
    </div>
    {expanded.has(entry.inputId)&&<div className="composer-queue-details">
      <small>{outboxStatusLabel(entry.status)}</small><p>{entry.text}</p>
      {entry.images?.map(image=><img src={image.url} alt={image.fileName} key={image.id}/>)}
      {entry.error&&<p role="status">{entry.error}</p>}{entry.note&&<p>{entry.note}</p>}
      {entry.status==='unknown'&&<button type="button" onClick={()=>onCheck(entry)}>Проверить доставку</button>}
      {entry.status==='ready'&&<button type="button" disabled={pending(entry.inputId)} onClick={()=>onRetry(entry.inputId)}>Отправить</button>}
      {entry.status==='failed'&&entry.nonRetryable!==true&&<button type="button" onClick={()=>onRetry(entry.inputId)}>Повторить</button>}
      {['delivered','accepted','failed','unknown'].includes(entry.status)&&<button type="button" onClick={()=>onDismiss(entry.inputId)}>Убрать из списка</button>}
    </div>}
  </div>)}</div>;
}
