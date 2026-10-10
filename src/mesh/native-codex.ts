import WebSocket from "ws";
/** Attach only to a documented existing native Unix-WebSocket authority.
 * Never starts, moves or kills a native writer. Metadata reconnect is safe;
 * a mutation with a lost receipt is left UNKNOWN by the durable mesh ledger. */
export class NativeCodexClient {
 private socket?:WebSocket;
 private initializing?:Promise<void>;
 private sequence=0;
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(private readonly socketPath=process.env.CODEX_APP_SERVER_SOCKET,private readonly timeoutMs=10000){}
 async connect():Promise<void>{
  if(this.initializing)return this.initializing;
  if(this.socket?.readyState===WebSocket.OPEN)return;
  if(!this.socketPath||!this.socketPath.startsWith("/")||/[?:]/.test(this.socketPath))throw new Error("native_shared_transport_unavailable");
  this.initializing=this.initialize();
  try{await this.initializing;}finally{this.initializing=undefined;}
 }
 private async initialize():Promise<void>{
  const socket=new WebSocket(`ws+unix://${this.socketPath}:/`,{maxPayload:512*1024});this.socket=socket;
  socket.on("message",data=>{try{const r=JSON.parse(data.toString()),p=this.pending.get(r.id);if(p){clearTimeout(p.timer);this.pending.delete(r.id);r.error?p.reject(new Error(r.error.message||"native RPC failed")):p.resolve(r.result);}}catch{/* native notification */}});
  socket.once("close",()=>this.fail(socket));socket.on("error",()=>this.fail(socket));
  try{
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{socket.close();reject(new Error("native_connect_deadline"));},this.timeoutMs);socket.once("open",()=>{clearTimeout(timer);resolve();});socket.once("error",()=>{clearTimeout(timer);reject(new Error("native_connect_failed"));});});
   await this.request("initialize",{clientInfo:{name:"agent-herder-harness-mesh",title:"Harness Mesh",version:"1"},capabilities:{experimentalApi:true}});
   socket.send(JSON.stringify({jsonrpc:"2.0",method:"initialized",params:{}}));
  }catch(error){socket.close();this.fail(socket);throw error;}
 }
 async request(method:string,params:Record<string,unknown>,operation?:{timeoutMs:number}):Promise<any>{
  // Only the named finite stock operation extends its own pending request.
  // Initialization and all metadata/delivery requests retain the default 10s.
  if(operation&&(method!=="command/exec"||!Number.isSafeInteger(operation.timeoutMs)||operation.timeoutMs<1||operation.timeoutMs>2147483647))throw new Error("native_operation_deadline_invalid");
  const deadline=operation?.timeoutMs??this.timeoutMs;
  const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN)throw new Error("native_transport_disconnected");
  if(this.pending.size>=32)throw new Error("native_pending_capacity");const id=++this.sequence;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("native_rpc_deadline"));},deadline);this.pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({jsonrpc:"2.0",id,method,params}),e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});});
 }
 close():void{const socket=this.socket;socket?.close();if(socket)this.fail(socket);}
 private fail(socket:WebSocket):void{if(this.socket!==socket)return;this.socket=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error("native_transport_closed"));}this.pending.clear();}
}
