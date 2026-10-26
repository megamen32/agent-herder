import {it,expect} from 'vitest';
import {readOpenCodeActiveSessions} from '../src/adapters/opencode-active.js';
it('joins per-session pending permissions into the bounded active snapshot, including listed idle sessions',async()=>{
 const calls:string[]=[];const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{calls.push(path);if(path==='/api/session/active')return {ancient:{status:'running'},waiting:{status:'idle'}};if(path==='/api/session/ancient/permission')return [];if(path==='/api/session/waiting/permission')return [{id:'per_waiting',sessionID:'waiting',action:'shell',resources:['python3 -c print(1)']}];if(path==='/api/permission/request')return [];return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions.map(s=>s.id).sort()).toEqual(['ancient','waiting']);expect(out.sessions.find(s=>s.id==='waiting')?.status).toBe('needs_input');expect(out.sessions.find(s=>s.id==='waiting')?.needsPermission).toBe(true);expect(calls).toContain('/api/session/waiting/permission');expect(calls.every(path=>path!=='/api/session'&&!path.startsWith('/api/session?'))).toBe(true);expect(out.receipt.exhaustive).toBe(true);
});
it('uses one global compatibility read only when the exact session endpoint returns 404',async()=>{
 const calls:string[]=[];const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{calls.push(path);if(path==='/api/session/active')return {a:{status:'running'},b:{status:'idle'}};if(path==='/api/session/a/permission'||path==='/api/session/b/permission')throw Error('opencode_active_native_http_404');if(path==='/api/permission/request')return [{id:'per_a',sessionID:'a',action:'shell'},{id:'per_b',sessionID:'b',action:'shell'}];return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions.map(s=>s.id).sort()).toEqual(['a','b']);expect(out.sessions.every(s=>s.needsPermission)).toBe(true);expect(calls.filter(path=>path==='/api/permission/request')).toHaveLength(1);
});
it('recovers a global-listed pending session absent from active only when its exact route returns 404',async()=>{
 const calls:string[]=[];const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{calls.push(path);if(path==='/api/session/active')return {};if(path==='/api/permission/request')return [{id:'per_waiting',sessionID:'waiting',action:'shell'}];if(path==='/api/session/waiting/permission')throw Error('opencode_active_native_http_404');return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions).toMatchObject([{id:'waiting',status:'needs_input',needsPermission:true}]);expect(out.receipt.exhaustive).toBe(true);expect(calls).toContain('/api/session/waiting/permission');
});
it('does not trust a global pending candidate when its exact session route returns empty',async()=>{
 const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{if(path==='/api/session/active')return {};if(path==='/api/permission/request')return [{id:'per_stale',sessionID:'stale',action:'shell'}];if(path==='/api/session/stale/permission')return [];return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions).toEqual([]);expect(out.receipt.exhaustive).toBe(true);
});
it('marks the permission snapshot incomplete when a 404 has no global compatibility result',async()=>{
 const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{if(path==='/api/session/active')return {unknown:{status:'running'}};if(path==='/api/permission/request')return [];if(path==='/api/session/unknown/permission')throw Error('opencode_active_native_http_404');return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions).toMatchObject([{id:'unknown',status:'running',needsPermission:false}]);expect(out.receipt.exhaustive).toBe(false);
});
it('native unavailable is not empty complete',async()=>{await expect(readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async()=>{throw Error('offline');}})).rejects.toThrow('offline');});
