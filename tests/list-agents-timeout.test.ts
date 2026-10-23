import {describe,it,expect,vi} from 'vitest';
import {listAgentsResult} from '../src/mcp-tools/handlers.js';
import {coordinationNotes} from '../src/coordination-notes.js';
describe('list agents discovery deadline',()=>{
 it('allows a ready four-second native page within the thirty-second discovery window',async()=>{
  vi.useFakeTimers();const places=vi.spyOn(coordinationNotes,'activeWorkspaceObservations').mockResolvedValue(new Map());
  try{
   const adapter={type:'codex',listSessions:vi.fn(async()=>{await new Promise(r=>setTimeout(r,4000));return [{id:'native',harness:'codex',status:'running',title:'own',cwd:'/work',lastActivity:new Date().toISOString(),needsPermission:false}];})};
   const pending=listAgentsResult(new Map([['codex',adapter]]) as any,{harness:'codex',hostId:'roomhacker-server-100',status:'running',limit:40});
   await vi.advanceTimersByTimeAsync(4001);const result=await pending;expect(result.unavailable).toEqual([]);expect(result.sessions[0]?.id).toBe('native');expect(adapter.listSessions).toHaveBeenCalledWith({limit:40});
  }finally{places.mockRestore();vi.useRealTimers();}
 });
 it('still returns a bounded unavailable receipt for a hung page',async()=>{
  vi.useFakeTimers();const places=vi.spyOn(coordinationNotes,'activeWorkspaceObservations').mockResolvedValue(new Map());
  try{const pending=listAgentsResult(new Map([['codex',{type:'codex',listSessions:()=>new Promise(()=>{})}]]) as any,{harness:'codex'});await vi.advanceTimersByTimeAsync(30001);expect((await pending).unavailable).toEqual([{harness:'codex',error:'Discovery exceeded 30000 ms'}]);}
  finally{places.mockRestore();vi.useRealTimers();}
 });
});
