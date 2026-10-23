import {it,expect,vi} from 'vitest';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startActiveFleetInventoryOwner,readFleetActiveInventory} from '../src/active-session-fleet.js';
const peers=[{hostId:'a',target:'a'},{hostId:'b',target:'b'}];
function owner(id:string){const at=new Date().toISOString();return {sessions:[{id:id+'1',runtimeHostId:id,harness:'codex',title:id,activity:{state:'active',evidence:'native',observedAt:at,expiresAt:new Date(Date.now()+15000).toISOString()},workspaces:[{hostId:'code',absolutePath:'/code'}]}],hosts:[{hostId:id,state:'available',observedAt:at}],partial:false};}
async function ready(path:string,count:number){let x;for(let i=0;i<80;i++){x=await readFleetActiveInventory({}, {path,peers});if(x.total===count)return x;await new Promise(r=>setTimeout(r,5));}return x!;}
it('queries only the materialized index, keeps fresh last success after refresh failure, expires evidence without renewal',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'active-fleet-')),'index.json');let fail=false;const read=vi.fn(async(p:any)=>{if(fail&&p.hostId==='b')throw Error('transport_deadline');return owner(p.hostId);});const stop=startActiveFleetInventoryOwner({path,peers,readOwner:read,intervalMs:100000});
 try{await ready(path,2);const calls=read.mock.calls.length;for(let i=0;i<3;i++)expect((await readFleetActiveInventory({hostId:'code'},{path,peers})).activeCount).toBe(2);expect(read).toHaveBeenCalledTimes(calls);
 fail=true;stop.refresh();await new Promise(r=>setTimeout(r,30));const cached=await readFleetActiveInventory({}, {path,peers});expect(cached.activeCount).toBe(2);expect(cached.partial).toBe(true);
 const expired=await readFleetActiveInventory({}, {path,peers,now:Date.now()+60000});expect(expired.activeCount).toBe(0);expect(expired.unknownActivityCount).toBe(2);expect(expired.sessions[0].activity.observedAt).toBe(cached.sessions[0].activity.observedAt);
 }finally{stop();}
});
it('publishes healthy owners without waiting for a hung peer and coalesces background reads',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'active-fleet-')),'index.json');const calls={a:0,b:0};const read=async(p:any)=>{calls[p.hostId as'a'|'b']++;if(p.hostId==='b')return new Promise<any>(()=>{});return owner(p.hostId);};const stop=startActiveFleetInventoryOwner({path,peers,readOwner:read,intervalMs:100000});
 try{const x=await ready(path,1);stop.refresh();stop.refresh();await new Promise(r=>setTimeout(r,10));expect(calls.b).toBe(1);expect(x.partial).toBe(true);expect(x.hosts.find(h=>h.hostId==='b')?.state).toBe('unavailable');expect(x.activeCount).toBe(1);}finally{stop();}
});
it('cold or identity-invalid owners remain explicit unavailable partial rather than exact zero',async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'active-fleet-')),'index.json');const cold=await readFleetActiveInventory({}, {path,peers});expect(cold.activeCountExact).toBeNull();expect(cold.hosts).toHaveLength(2);expect(cold.hosts.every(h=>h.state==='unavailable')).toBe(true);
 const stop=startActiveFleetInventoryOwner({path,peers,readOwner:async()=>owner('wrong'),intervalMs:100000});try{await new Promise(r=>setTimeout(r,30));const invalid=await readFleetActiveInventory({}, {path,peers});expect(invalid.activeCountExact).toBeNull();expect(invalid.hosts.every(h=>h.reason==='active_fleet_owner_identity_invalid')).toBe(true);}finally{stop();}
});
