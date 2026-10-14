// Fast unit; expected .1s/max2s. Lifecycle/resource guards for native catalogue refresh.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startHerderCatalogRefresh} from './catalog-refresh.mjs';
import {stageDesktopCatalogRefresh} from './stage-catalog-refresh.mjs';
function fixture(overrides={}) {
 let tick,rev=1,cleared=false;const calls=[];
 const local={scope:{kind:'local',workspacePath:'/local'},sourceAvailability:'online'};
 const remote={scope:{kind:'remote',workspacePath:'/remote'},sourceAvailability:'online'};
 const offline={scope:{kind:'local',workspacePath:'/offline'},sourceAvailability:'offline'};
 const watcher=startHerderCatalogRefresh({readRevision:()=>rev,listSources:()=>[local,remote,offline],refreshSource:async s=>{calls.push(s.scope.workspacePath)},timers:{setInterval(fn){tick=fn;return{unref(){}}},clearInterval(){cleared=true}},...overrides});
 return{watcher,tick:()=>tick(),change:()=>{rev++},calls,cleared:()=>cleared};
}
test('reads only changed local online catalogues and disposes its timer',async()=>{
 const f=fixture();await f.tick();assert.deepEqual(f.calls,[]);f.change();await f.tick();assert.deepEqual(f.calls,['/local']);await f.tick();assert.equal(f.calls.length,1);f.watcher.dispose();f.change();await f.tick();assert.equal(f.calls.length,1);assert.equal(f.cleared(),true);
});
test('coalesces slow reads and retries a failed change without new queued work',async()=>{
 let release,attempts=0,fail=true;const errors=[];
 const f=fixture({refreshSource:()=>{attempts++;if(fail){fail=false;throw Error('temporary catalogue read');}return new Promise(r=>{release=r})},onError:e=>errors.push(e.message)});
 f.change();await f.tick();assert.equal(errors.length,1);const pending=f.tick();await f.tick();assert.equal(attempts,2);release();await pending;await f.tick();assert.equal(attempts,2);f.watcher.dispose();
});
test('staging rejects an unknown runtime instead of modifying it optimistically',()=>{
 assert.throws(()=>stageDesktopCatalogRefresh('unknown native runtime','/db'),/Unsupported/);
});
