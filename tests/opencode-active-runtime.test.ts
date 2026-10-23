import {it,expect} from 'vitest';
import {readOpenCodeActiveSessions} from '../src/adapters/opencode-active.js';
it('enumerates native active identities outside historical newest100 and includes waiting',async()=>{
 const calls:string[]=[];const out=await readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async path=>{calls.push(path);if(path==='/api/session/active')return {ancient:{status:'running'}};if(path==='/api/permission/request')return [{sessionID:'waiting'}];return {id:path.split('/').at(-1),title:'native',directory:'/code'};}});
 expect(out.sessions.map(s=>s.id).sort()).toEqual(['ancient','waiting']);expect(out.sessions.find(s=>s.id==='waiting')?.status).toBe('needs_input');expect(calls).not.toContain('/api/session');expect(out.receipt.exhaustive).toBe(true);
});
it('native unavailable is not empty complete',async()=>{await expect(readOpenCodeActiveSessions({v2:true,hostId:'owner',read:async()=>{throw Error('offline');}})).rejects.toThrow('offline');});
