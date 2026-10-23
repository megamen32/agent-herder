import {describe,it,expect} from 'vitest';
import {filterActiveInventory} from '../src/active-session-inventory.js';
describe('active inventory',()=>{
 it('filters by work host before pagination, runtime remains separate',()=>{
  const sessions=Array.from({length:150},(_,i)=>({id:String(i),harness:'minimax-code',title:'task',runtimeHostId:'m1',activity:{state:'active',observedAt:'2026-10-23T18:00:00Z',evidence:'native'},workspaces:i<149?[]:[{hostId:'server100',absolutePath:'/code'}]}));
  const out=filterActiveInventory({sessions,hosts:[],partial:false},{hostId:'server100',limit:1});
  expect(out.total).toBe(1);expect(out.sessions[0].id).toBe('149');expect(out.sessions[0].runtimeHostId).toBe('m1');
  expect(filterActiveInventory({sessions,hosts:[],partial:false},{}).sessions).toHaveLength(150);
 });
 it('preserves unknown workspaces in unfiltered result',()=>{
  const out=filterActiveInventory({sessions:[{id:'a',runtimeHostId:'m1',harness:'codex',title:'a',activity:{state:'active',observedAt:'x',evidence:'native'},workspaces:[]}],hosts:[],partial:true},{});
  expect(out.total).toBe(1);expect(out.unknownWorkspaceCount).toBe(1);expect(out.partial).toBe(true);
 });
});

import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readActiveInventory,activeInventoryFleet} from '../src/active-session-inventory.js';
it('expired activity is unknown without renewing owner freshness',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'active-expiry-'));const path=join(dir,'index.json');
 await writeFile(path,JSON.stringify({sessions:[{id:'a',runtimeHostId:'owner',workspaces:[],activity:{state:'active',observedAt:'2026-10-23T18:00:00Z'}}],hosts:[{hostId:'owner',observedAt:'2026-10-23T18:00:00Z',state:'available'}],partial:false}));
 const out=await readActiveInventory({path,hostId:'owner',now:Date.parse('2026-10-23T18:01:00Z')});
 expect(out.partial).toBe(true);expect(out.sessions[0].activity.state).toBe('unknown');expect(out.hosts[0].observedAt).toBe('2026-10-23T18:00:00Z');
});
it('one unavailable owner preserves others and cannot look like complete zero',async()=>{
 const out=await activeInventoryFleet({},[{hostId:'a',target:'a'},{hostId:'b',target:'b'}],async p=>{if(p.hostId==='b')throw Error('offline');return {sessions:[{id:'x',runtimeHostId:'a',workspaces:[]}],hosts:[{hostId:'a',state:'available',observedAt:'now'}],partial:false};});
 expect(out.total).toBe(1);expect(out.partial).toBe(true);expect(out.hosts[1].state).toBe('unavailable');
});
it('work host filter remains partial when unassigned sessions could match',()=>{
 const out=filterActiveInventory({sessions:[{id:'a',runtimeHostId:'m1',harness:'codex',title:'a',activity:{state:'active',observedAt:'x',evidence:'native'},workspaces:[]}],hosts:[],partial:false},{hostId:'server100'});
 expect(out.total).toBe(0);expect(out.partial).toBe(true);expect(out.activeCountExact).toBeNull();expect(out.unassignedWorkspaceCount).toBe(1);
});
