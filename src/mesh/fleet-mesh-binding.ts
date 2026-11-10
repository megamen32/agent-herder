import {createHash,timingSafeEqual} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';

/**
 * The mesh fleet binding: the verified GPTAdmin client credential the fleet
 * transport uses to reach peer herders through the hub relay instead of
 * raising SSH bridges to every machine. The credential is the existing
 * zcode client binding the cabinet hub lane already uses; the pin keeps the
 * exact approved generation, exactly as the web wiring pins it.
 */
export interface FleetMeshBinding {
 endpoint:string;
 headers:Record<string,string>;
 generation:string;
}
/** The child MCP ref that exposes a node's herder to the mesh. */
export const MESH_FLEET_CHILD_REF='HerderFleet';
/** Herder hostIds whose mesh node is registered under a different name. */
const MESH_NODE_BY_HOST:Readonly<Record<string,string>>={
 'mac-mini-2012.lan':'mac-mini-node',
 'MacBook-Pro-User.local':'macbook-m1-node',
};
/** The mesh node name that carries this herder host's fleet child. */
export function meshNodeOf(hostId:string):string{return MESH_NODE_BY_HOST[hostId]??hostId;}
/** The relay target of a herder host's fleet child. */
export function meshFleetTarget(hostId:string):string{return `mcp:shell:${meshNodeOf(hostId)}:${MESH_FLEET_CHILD_REF}`;}
const matches=(left:string,right:string)=>{
 const a=Buffer.from(left),b=Buffer.from(right);
 return a.length===b.length&&timingSafeEqual(a,b);
};
/**
 * Read and verify the fleet mesh binding. The exact same origin, header and
 * pin rules as the cabinet hub lane apply: a missing file, a foreign origin
 * or a rotated (unpinned) credential leaves the mesh unavailable and the
 * transport stays on its documented fallback path.
 */
export async function readFleetMeshBinding(options:{configPath?:string;pin?:string}={}):Promise<FleetMeshBinding|undefined>{
 const configPath=options.configPath??process.env.AGENT_HERDER_FLEET_MESH_CONFIG??join(homedir(),'.zcode','cli','config.json');
 const pin=options.pin??process.env.AGENT_HERDER_FLEET_CREDENTIAL_PIN;
 if(!pin)return undefined;
 let entry:{url?:unknown;headers?:unknown;enabled?:unknown};
 try{
  const text=await readFile(configPath,'utf8');
  if(text.length>262144)return undefined;
  const parsed=JSON.parse(text)?.mcp?.servers?.gptadmin;
  if(!parsed||typeof parsed!=='object')return undefined;
  entry=parsed as typeof entry;
 }catch{return undefined;}
 if(entry.enabled===false||typeof entry.url!=='string')return undefined;
 let url:URL;
 try{url=new URL(entry.url);}catch{return undefined;}
 if(url.protocol!=='https:'||!url.hostname.endsWith('.gptadmin.bezrabotnyi.com')||url.username||url.password||url.hash||url.search)return undefined;
 const headers:Record<string,string>={};
 for(const [key,value] of Object.entries((entry.headers??{}) as Record<string, unknown>)){
  if(typeof value!=='string'||value.length>8192||/[\r\n]/.test(value))return undefined;
  headers[key]=value;
 }
 if(!Object.keys(headers).some(key=>key.toLowerCase()==='authorization'))return undefined;
 const generation=createHash('sha256').update(JSON.stringify([url.href,headers])).digest('hex');
 if(!matches(generation,pin))return undefined;
 return {endpoint:url.href,headers,generation};
}
