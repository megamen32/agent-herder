import type {FleetCreateRequest,FleetCreateReceipt} from '../../mesh/fleet-contract.js';
export interface FleetIntent {request:FleetCreateRequest;receipt:FleetCreateReceipt}
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>;
/** An opaque server scope partitions browser persistence. Restoration never submits a POST. */
export class FleetBrowserIntent {
 private readonly key:string;
 constructor(private readonly storage:Storage,scopeKey:string){if(!/^[a-f0-9]{64}$/.test(scopeKey))throw new Error('Не подтверждена учётная запись кабинета');this.key='herder:fleet:create:'+scopeKey;}
 load():FleetIntent|null{const raw=this.storage.getItem(this.key);if(raw===null)return null;const saved=JSON.parse(raw) as FleetIntent;
  if(!saved?.request?.inputId||!saved.request.hostId||saved.receipt?.state!=='unknown'||saved.receipt.inputId!==saved.request.inputId)throw new Error('Нельзя подтвердить сохранённый запрос создания');return saved;
 }
 begin(request:FleetCreateRequest):FleetIntent{if(this.load())throw new Error('Предыдущий запрос создания ещё не подтверждён');const intent:FleetIntent={request,receipt:{state:'unknown',inputId:request.inputId,retryable:false}};this.storage.setItem(this.key,JSON.stringify(intent));return intent;}
 finish(receipt:FleetCreateReceipt){const existing=this.load();if(!existing||existing.request.inputId!==receipt.inputId)throw new Error('Несовпадающий ответ создания');if(receipt.state!=='unknown')this.storage.removeItem(this.key);}
 /** Explicit user action only: preserve UNKNOWN, then allow a different intent.
  * This neither resolves the old outcome nor retries its request. */
 archivedUnknown():FleetIntent[]{
  const raw=this.storage.getItem(this.key+':unknown-history');
  const history: FleetIntent[]=raw===null?[]:JSON.parse(raw);
  if(!Array.isArray(history)||history.length>64||history.some(v=>!v?.request?.inputId||v.receipt?.state!=='unknown'||v.receipt.inputId!==v.request.inputId))throw new Error('Не удалось прочитать историю проверок');
  return history;
 }
 archiveUnknown(){
  const existing=this.load();if(!existing)throw new Error('Нет запроса для отложенной проверки');
  const key=this.key+':unknown-history',history=this.archivedUnknown();
  const previous=history.find(v=>v.request.inputId===existing.request.inputId);
  if(previous&&JSON.stringify(previous.request)!==JSON.stringify(existing.request))throw new Error('Несовпадающий сохранённый запрос');
  if(!previous){
   if(history.length===64)throw new Error('История проверок заполнена');
   history.push(existing);
  }
  // If saving fails, the active intent stays locked. If removal fails, it also
  // stays locked; a later explicit action deduplicates the archived input.
  this.storage.setItem(key,JSON.stringify(history));this.storage.removeItem(this.key);
 }
}
