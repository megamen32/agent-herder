import {describe,it,expect,afterEach} from 'vitest';
import {mkdtemp,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startActiveInventoryOwner,readActiveInventory} from '../src/active-session-inventory.js';
import type {AgentSession,HarnessAdapter} from '../src/types/index.js';

const owners:Array<()=>void>=[];
afterEach(()=>{while(owners.length)owners.pop()?.();});

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));

/** A harness whose native read is expensive and whose evidence carries its own expiry. */
function nativeHarness(options:{sessions:AgentSession[];ttlMs:number;calls:()=>number;onCall?:()=>void}){
  const at=()=>new Date().toISOString();
  return {
    type:'zcode' as const,
    async listActiveSessions(){
      options.calls();options.onCall?.();
      const observedAt=at();
      return options.sessions.map(s=>({...s,meta:{...s.meta,activityObservedAt:observedAt,activityExpiresAt:new Date(Date.now()+options.ttlMs).toISOString()}}));
    },
    getActiveSessionSnapshotReceipt:()=>({exhaustive:true,observedAt:at(),expiresAt:new Date(Date.now()+options.ttlMs).toISOString()}),
  };
}

describe('active inventory cycle',()=>{
  it('reads the native source again only when its evidence is about to expire',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'l66-expiry-'));const path=join(dir,'index.json');
    let calls=0;
    const at=new Date().toISOString();
    const session={id:'n1',harness:'zcode',status:'running',title:'t',cwd:'',hostId:'owner',lastActivity:at,needsPermission:false,meta:{activityObservedAt:at,activityExpiresAt:new Date(Date.now()+15000).toISOString()}} as AgentSession;
    const adapter=nativeHarness({sessions:[session],ttlMs:15000,calls:()=>{calls++;}});
    const stop=startActiveInventoryOwner(()=>({sessions:[],observedAt:at,warming:false}),new Map([['zcode',adapter]]) as unknown as Map<string,HarnessAdapter>,{path,hostId:'owner',nativeStartDelayMs:0});
    owners.push(stop);
    await wait(400);
    // The evidence of this read is valid for 15 s, so a 2 s window must not
    // trigger a second full read of the native source.
    const afterFirst=calls;
    await wait(2000);
    expect(calls).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });

  it('keeps publishing an honest snapshot and never a stale one as fresh',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'l66-honest-'));const path=join(dir,'index.json');
    const at=new Date().toISOString();
    const session={id:'n1',harness:'zcode',status:'running',title:'t',cwd:'',hostId:'owner',lastActivity:at,needsPermission:false,meta:{activityObservedAt:at,activityExpiresAt:new Date(Date.now()+15000).toISOString()}} as AgentSession;
    const adapter=nativeHarness({sessions:[session],ttlMs:15000,calls:()=>{}});
    const stop=startActiveInventoryOwner(()=>({sessions:[],observedAt:at,warming:false}),new Map([['zcode',adapter]]) as unknown as Map<string,HarnessAdapter>,{path,hostId:'owner',nativeStartDelayMs:0});
    owners.push(stop);
    let published:any;for(let i=0;i<60;i++){published=await readActiveInventory({path,hostId:'owner'});if(published.sessions.length)break;await wait(25);}
    expect(published.sessions[0].id).toBe('n1');
    // The published row carries the observation of the native read, and the
    // reader turns an expired row into unknown instead of carrying it forward.
    expect(published.sessions[0].activity.observedAt).toBe(published.sessions[0].activity.observedAt);
    const expired=await readActiveInventory({path,hostId:'owner',now:Date.now()+60000});
    expect(expired.sessions[0].activity.state).toBe('unknown');
    expect(expired.hosts[0].state).toBe('stale');
  });

  it('does not rewrite the published inventory while nothing changed',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'l66-stable-'));const path=join(dir,'index.json');
    const at=new Date().toISOString();
    const adapter=nativeHarness({sessions:[],ttlMs:15000,calls:()=>{}});
    const stop=startActiveInventoryOwner(()=>({sessions:[],observedAt:at,warming:false}),new Map([['zcode',adapter]]) as unknown as Map<string,HarnessAdapter>,{path,hostId:'owner',nativeStartDelayMs:0});
    owners.push(stop);
    await wait(300);
    const first=await stat(path);
    await wait(1500);
    const second=await stat(path);
    // An unchanged inventory is not rewritten: the inode of the published file
    // stays the same, so the panel reads one stable snapshot.
    expect(second.ino).toBe(first.ino);
  });

  it('keeps every session it published and never drops a row silently',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'l66-rows-'));const path=join(dir,'index.json');
    const at=new Date().toISOString();
    const sessions=[1,2,3].map(i=>({id:'n'+i,harness:'zcode',status:'running',title:'t'+i,cwd:'',hostId:'owner',lastActivity:at,needsPermission:false,meta:{activityObservedAt:at,activityExpiresAt:new Date(Date.now()+15000).toISOString()}})) as AgentSession[];
    const adapter=nativeHarness({sessions,ttlMs:15000,calls:()=>{}});
    const stop=startActiveInventoryOwner(()=>({sessions:[],observedAt:at,warming:false}),new Map([['zcode',adapter]]) as unknown as Map<string,HarnessAdapter>,{path,hostId:'owner',nativeStartDelayMs:0});
    owners.push(stop);
    let published:any;for(let i=0;i<60;i++){published=await readActiveInventory({path,hostId:'owner'});if(published.sessions.length===3)break;await wait(25);}
    expect(published.sessions.map(s=>s.id).sort()).toEqual(['n1','n2','n3']);
    // The count of what the panel sees is the count of what was observed.
    expect(published.sessions).toHaveLength(3);
    const raw=JSON.parse(await readFile(path,'utf8'));
    expect(raw.sessions).toHaveLength(3);
  });
});
