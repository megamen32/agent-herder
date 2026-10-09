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
}
