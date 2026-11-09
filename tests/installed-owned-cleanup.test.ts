import {describe, it, expect} from 'vitest';
import {cleanupOwnedCanary, type OwnedCanaryBinding, type OwnedCanaryState} from './native/installed-owned-cleanup.js';

const binding: OwnedCanaryBinding = {runId:'own-run',coreSessionRef:'session:created-here',nativeId:'native-created-here',
  harness:'opencode',hostId:'host-owner',cwd:'/owned/project',createReceiptId:'confirmed-create-receipt'};
function stand(options: {terminal?: boolean; unknown?: boolean; neverTerminal?: boolean; unsupported?: boolean; wrong?: boolean} = {}) {
  let now = Date.parse('2026-11-09T00:00:00Z'), terminal = options.terminal ?? false;
  const calls: string[] = [], records: Array<{kind:string;value:any}> = [];
  const port = {
    async read(): Promise<OwnedCanaryState> {calls.push('read');return {nativeId:options.wrong?'another-native':binding.nativeId,
      harness:binding.harness,hostId:binding.hostId,cwd:binding.cwd,observedAt:new Date(now).toISOString(),
      status:terminal?'idle':'running',terminal,cancellation:options.unsupported?'unsupported':'supported',
      generation:'exact-native-generation',raw:{exactNative:true}};},
    async hold() {calls.push('hold');},
    async cancel() {calls.push('cancel');if(!options.neverTerminal)terminal=true;
      if(options.unknown)throw Object.assign(Error('private transport error'),{receipt:{acceptedTask:'native-accepted'}});
      return {accepted:true,raw:{nativeAccepted:true}};},
    async archive() {calls.push('archive');},
    async record(kind: string, value: any) {records.push({kind,value});},
  };
  return {calls,records,port,options:{now:()=>now,sleep:async(ms:number)=>{now+=ms;},deadlineMs:1500}};
}
describe('exact owned native cleanup never retries cancellation', () => {
  it('archives a proven terminal session without holding or canceling', async () => {
    const s=stand({terminal:true});await cleanupOwnedCanary(binding,s.port,s.options);
    expect(s.calls).toEqual(['read','archive']);
  });
  it.each([false,true])('reconciles accepted or unknown cancellation through native terminal evidence: %s', async unknown => {
    const s=stand({unknown});await cleanupOwnedCanary(binding,s.port,s.options);
    expect(s.calls.filter(x=>x==='cancel')).toHaveLength(1);
    expect(s.calls.at(-1)).toBe('archive');
    expect(s.records.some(x=>x.kind===(unknown?'cancel_unknown':'cancel_receipt'))).toBe(true);
    expect(s.records.some(x=>x.kind==='terminal_state')).toBe(true);
  });
  it('never archives or retries when accepted cancellation has no terminal proof', async () => {
    const s=stand({unknown:true,neverTerminal:true});
    await expect(cleanupOwnedCanary(binding,s.port,s.options)).rejects.toThrow('owned_cleanup_terminal_unconfirmed_no_replay');
    expect(s.calls.filter(x=>x==='cancel')).toHaveLength(1);expect(s.calls).not.toContain('archive');
  });
  it('keeps unsupported producer cancellation explicit', async () => {
    const s=stand({unsupported:true});
    await expect(cleanupOwnedCanary(binding,s.port,s.options)).rejects.toThrow('owned_cleanup_cancel_unsupported_not_terminal');
    expect(s.calls).not.toContain('cancel');expect(s.calls).not.toContain('archive');
  });
  it('refuses wrong native binding before any hold, cancel or archive', async () => {
    const s=stand({wrong:true});await expect(cleanupOwnedCanary(binding,s.port,s.options)).rejects.toThrow('owned_cleanup_native_state_unproven');
    expect(s.calls).toEqual(['read']);
    await expect(cleanupOwnedCanary({...binding,createReceiptId:''},s.port,s.options)).rejects.toThrow('owned_cleanup_binding_missing');
  });
});
