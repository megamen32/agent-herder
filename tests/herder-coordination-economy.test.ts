import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoordinationNoteStore } from '../src/coordination-notes.js';

// Unit; catches context amplification/current-project loss; expected <1s, max 5s.
describe('bounded coordination context', () => {
  async function store() { return new CoordinationNoteStore(join(await mkdtemp(join(tmpdir(), 'herder-economy-')), 'notes.json')); }
  it('recognizes an existing attributed coordination block', async () => {
    const s = await store();
    await s.create({kind:'working',message:'peer task',cwd:'/repo',paths:['x.ts'],authorSessionId:'peer'});
    const wrapped = '<agent-herder-coordination board="repo">already supplied</agent-herder-coordination>\nwork';
    expect(await s.inject({id:'reader',harness:'codex',cwd:'/repo'}, wrapped)).toBe(wrapped);
  });
  it('bounds the complete context and does not repeat unchanged peers after one change', async () => {
    const s = await store();
    const notes = await Promise.all(Array.from({length:12},(_,i)=>s.create({kind:'working',message:`peer-${i} `+'x'.repeat(3500),cwd:'/repo',paths:[`file-${i}.ts`],authorSessionId:`peer-${i}`})));
    const session={id:'reader',harness:'codex',cwd:'/repo'};
    const first=await s.renderForSession(session);
    expect(first!.length).toBeLessThanOrEqual(4000);
    await s.update(notes[0]!.id, 'peer-0', {message:'changed-unique-task'});
    const delta=await s.renderForSession(session);
    expect(delta).toContain('changed-unique-task');
    expect(delta).not.toContain('peer-1 ');
    expect(await s.renderForSession(session)).toBeNull();
  });
  it('exposes the currently declared workspace and expires activity', async () => {
    const s=await store();
    await s.create({kind:'working',message:'real task',cwd:'/actual-project',paths:[],authorSessionId:'agent'});
    expect(s.activeWorkspaceForSession('agent')).toBe('/actual-project');
    await s.inject({id:'agent',harness:'codex',cwd:'/launch'}, 'message');
    expect(s.activeWorkspaceForSession('agent')).toBe('/actual-project');
    const presence=(s as unknown as {presence: Map<string,Map<string,number>>}).presence;
    presence.get('agent')!.set('/actual-project', Date.now()-25*60*60*1000);
    expect(s.presenceForSession('agent')).toBeNull();
  });
});

it('reports release of the final owner once',async()=>{
 const s=new CoordinationNoteStore(join(await mkdtemp(join(tmpdir(),'herder-release-')),'notes.json'));
 const n=await s.create({kind:'working',message:'editing',cwd:'/repo',paths:['owned.ts'],authorSessionId:'peer'});
 const session={id:'reader',harness:'codex',cwd:'/repo'};
 await s.renderForSession(session);await s.delete(n.id,'peer');
 expect(await s.renderForSession(session)).toContain('Ownership released');
 expect(await s.renderForSession(session)).toBeNull();
});
it('does not inject sibling project ownership from a parent launch directory',async()=>{
 const s=new CoordinationNoteStore(join(await mkdtemp(join(tmpdir(),'herder-siblings-')),'notes.json'));
 await s.create({kind:'working',message:'unrelated project',cwd:'/projects/other',paths:['other.ts'],authorSessionId:'peer'});
 expect(await s.renderForSession({id:'reader',harness:'codex',cwd:'/projects'})).toBeNull();
});
it('coalesces automatic file roster changes within one minute without discarding them',async()=>{
 const s=new CoordinationNoteStore(join(await mkdtemp(join(tmpdir(),'herder-auto-context-')),'notes.json'));
 await s.reservePaths({harness:'codex',sessionId:'peer',cwd:'/repo',paths:['one.ts']});
 const session={id:'reader',harness:'codex',cwd:'/repo'};
 expect(await s.renderForSession(session)).toContain('one.ts');
 await s.reservePaths({harness:'codex',sessionId:'peer',cwd:'/repo',paths:['two.ts']});
 expect(await s.renderForSession(session)).toBeNull();
 const state=(s as any).injectionState;const key=[...state.keys()][0];state.get(key).at-=61000;
 expect(await s.renderForSession(session)).toContain('two.ts');
});
