import {hostname} from 'node:os';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import type {FleetCabinetService} from './fleet-service.js';
const createSchema=z.object({hostId:z.string().min(1).max(512),harness:z.enum(['codex','zcode','opencode']),name:z.string().trim().min(1).max(128),cwd:z.string().min(1).max(4096),model:z.string().min(1).max(128).optional(),inputId:z.string().min(1).max(256)}).strict();
/** Invoke AFTER the existing HTTP authentication guard. Resolver binds the authenticated profile/user. */
export function createFleetApiHandler(resolve:FleetCabinetService|((request:IncomingMessage)=>FleetCabinetService|Promise<FleetCabinetService>),localHostId=hostname()){
 return async(request:IncomingMessage,response:ServerResponse):Promise<boolean>=>{
  const url=new URL(request.url??'/', 'http://localhost');
  if(!['/api/fleet/hosts','/api/fleet/sessions','/api/fleet/create'].includes(url.pathname))return false;
  const send=(status:number,value:unknown)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value));};
  try{
   const service=typeof resolve==='function'?await resolve(request):resolve;
   if(request.method==='GET'&&url.pathname==='/api/fleet/hosts'){
    const view=await service.snapshot({refresh:url.searchParams.get('refresh')==='1'});send(200,{hosts:view.hosts,complete:view.complete,defaultHostId:localHostId,scopeKey:service.browserScopeKey});return true;
   }
   if(request.method==='GET'&&url.pathname==='/api/fleet/sessions'){
    const value=url.searchParams.get('limit');const limit=value===null?12:Number(value);
    const view=await service.snapshot({hostId:url.searchParams.get('hostId')??undefined,limit});send(200,view);return true;
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
