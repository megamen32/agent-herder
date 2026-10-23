import {hostname} from 'node:os';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import type {FleetCabinetService} from './fleet-service.js';
import {fleetSessionControlSchema} from './fleet-session-control.js';
const createSchema=z.object({hostId:z.string().min(1).max(512),harness:z.enum(['codex','zcode','opencode']),name:z.string().trim().min(1).max(128),cwd:z.string().min(1).max(4096),model:z.string().min(1).max(128).optional(),inputId:z.string().min(1).max(256),project:z.string().trim().min(1).max(512).optional()}).strict();
/** Invoke AFTER the existing HTTP authentication guard. Resolver binds the authenticated profile/user. */
export function createFleetApiHandler(resolve:FleetCabinetService|((request:IncomingMessage)=>FleetCabinetService|Promise<FleetCabinetService>),localHostId=hostname()){
 return async(request:IncomingMessage,response:ServerResponse):Promise<boolean>=>{
  const url=new URL(request.url??'/', 'http://localhost');
  if(!['/api/fleet/hosts','/api/fleet/sessions','/api/fleet/search','/api/fleet/create','/api/fleet/session','/api/fleet/inventory','/api/fleet/control'].includes(url.pathname))return false;
  const send=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  try{
   const service=typeof resolve==='function'?await resolve(request):resolve;
   if(url.pathname==='/api/fleet/search'&&request.method==='GET'){
    const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):20;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('search_limit_invalid');
    send(200,await service.search({query:url.searchParams.get('query')??'',hostId:url.searchParams.get('hostId')??undefined,harnesses:url.searchParams.getAll('harness'),limit}));return true;
   }
   if(url.pathname==='/api/fleet/control'&&['GET','POST'].includes(request.method??'')){
    const address={hostId:url.searchParams.get('hostId')??'',harness:url.searchParams.get('harness')??'',nativeSessionId:url.searchParams.get('sessionId')??''};
    let value:unknown;
    if(request.method==='GET')value={operation:url.searchParams.get('operation'),...(url.searchParams.has('inputId')?{inputId:url.searchParams.get('inputId')}:{})};
    else {
     let bytes=0;const chunks:Buffer[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
     value=await Promise.race([(async()=>{for await(const chunk of request){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>1048576)throw new Error('request_too_large');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('request_body_deadline')),3000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    }
    const parsed=fleetSessionControlSchema.safeParse(value);if(!parsed.success||((request.method==='GET')!==['details','message-status'].includes(parsed.data.operation))){send(400,{error:'Некорректная команда сессии'});return true;}
    try{const result=await service.requestSession(address,parsed.data);send(result.status,result.body);}catch{send(502,{ok:false,error:'Связь с выбранной сессией не подтверждена.',...(request.method==='POST'?{admissionUnknown:true,nonRetryable:true}:{})});}
    return true;
   }
   if(request.method==='GET'&&url.pathname==='/api/fleet/hosts'){
    const view=await service.snapshot({refresh:url.searchParams.get('refresh')==='1'});send(200,{hosts:view.hosts,complete:view.complete,defaultHostId:localHostId,scopeKey:service.browserScopeKey,sessionReadSupported:service.canReadSession});return true;
   }
   if(request.method==='GET'&&url.pathname==='/api/fleet/inventory'){
    const cursorsText=url.searchParams.get('cursors');if(cursorsText&&cursorsText.length>12000)throw new Error('inventory_cursor_limit');
    const cursors=cursorsText?JSON.parse(cursorsText):undefined;if(cursors&&(typeof cursors!=='object'||Array.isArray(cursors)))throw new Error('inventory_cursor_invalid');
    send(200,await service.inventory({hostId:url.searchParams.get('hostId')??undefined,cursors,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100}));return true;
   }
   if(request.method==='GET'&&url.pathname==='/api/fleet/sessions'){
    const value=url.searchParams.get('limit');const limit=value===null?12:Number(value);
    const view=await service.snapshot({hostId:url.searchParams.get('hostId')??undefined,limit});send(200,view);return true;
   }
   if(request.method==='GET'&&url.pathname==='/api/fleet/session'){
    send(200,await service.readSession({hostId:url.searchParams.get('hostId')??'',harness:url.searchParams.get('harness')??'',nativeSessionId:url.searchParams.get('sessionId')??''}));return true;
   }
   if(request.method==='POST'&&url.pathname==='/api/fleet/create'){
    const chunks:Buffer[]=[];let bytes=0;let timer:ReturnType<typeof setTimeout>|undefined;
    const body=await Promise.race([(async()=>{for await(const chunk of request){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>8192)throw new Error('request_too_large');chunks.push(b);}return Buffer.concat(chunks).toString('utf8');})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('request_body_deadline')),3000);})]).finally(()=>{if(timer)clearTimeout(timer);});
    const parsed=createSchema.safeParse(JSON.parse(body));if(!parsed.success){send(400,{error:'Некорректные параметры создания сессии'});return true;}
    const receipt=await service.create(parsed.data);send(receipt.state==='created'?201:receipt.state==='unknown'?202:409,receipt);return true;
   }
   send(405,{error:'Метод не поддерживается'});
  }catch{send(400,{error:'Не удалось выполнить запрос кабинета. Проверьте параметры и состояние хоста.'});}
  return true;
 };
}
