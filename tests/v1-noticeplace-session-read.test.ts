import { describe, expect, it, vi } from 'vitest';
import { createNoticePlaceSessionRead } from '../src/automation/v1-noticeplace-session-read.js';

function fixture() {
  const row = {session_ref:'session:repair',address:{native_session_id:'ses_native'},human_stop:{held:false},
    native:{id:'ses_native',harness:'opencode',cwd:'/project',status:'idle',title:'Repair',hostId:'localhost',
      lastActivity:'2026-11-08T19:00:00Z',needsPermission:false,model:'minimax-coding-plan/MiniMax-M3.1-Flash'}};
  const page = {session_ref:'session:repair',page:{messages:[{id:'msg_1',role:'assistant',text:'{"status":"fixed"}'}],complete:false}};
  const call = vi.fn(async (name:string,_args:Record<string,unknown>):Promise<unknown> => name==='sessions'?{sessions:[row]}:page);
  return {row,page,call,reader:createNoticePlaceSessionRead({port:{call},instanceRef:'opencode-noticeplace-local',cwd:'/project'})};
}
describe('NoticePlace ordinary session reads through Rust',()=>{
  it('returns helper-compatible details and stable progress without claiming full history',async()=>{
    const f=fixture();
    const details:any=await f.reader.read('session:repair','details');
    expect(details.session.id).toBe('session:repair');
    expect(details.nativeSessionId).toBe('ses_native');
    expect(details.messages[0]).toMatchObject({role:'assistant',text:'{"status":"fixed"}',parts:[]});
    expect(details.history.complete).toBe(false);
    const progress:any=await f.reader.read('session:repair','progress');
    expect(progress.session.status).toBe('idle');
    expect(progress.fingerprint).toMatch(/^progress:/);
    expect(await f.reader.read('session:repair','progress')).toEqual(progress);
    expect(f.call.mock.calls.every(([name])=>name==='sessions'||name==='session')).toBe(true);
  });
  it.each(['native','cwd','harness','status','hold','ref'])('rejects contradictory or missing %s authority',async field=>{
    const f=fixture();
    if(field==='native') f.row.native.id='someone_else';
    if(field==='cwd') f.row.native.cwd='/foreign';
    if(field==='harness') f.row.native.harness='codex';
    if(field==='status') f.row.native.status='guessed';
    if(field==='hold') delete (f.row as any).human_stop;
    if(field==='ref') f.page.session_ref='session:foreign';
    await expect(f.reader.read('session:repair','details')).rejects.toThrow();
  });
  it('keeps authoritative HumanStop and rejects absent session instead of guessing idle',async()=>{
    const f=fixture();f.row.human_stop.held=true;
    expect(await f.reader.read('session:repair','details')).toMatchObject({humanStopHeld:true});
    await expect(f.reader.read('session:missing','progress')).rejects.toThrow();
  });
  it('changes progress fingerprint when an actual repair reply arrives',async()=>{
    const f=fixture();const before:any=await f.reader.read('session:repair','progress');
    f.page.page.messages[0]!.text='Completed independent verification';
    const after:any=await f.reader.read('session:repair','progress');
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
