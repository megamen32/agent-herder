import {describe, it, expect} from 'vitest';
import {createHash} from 'node:crypto';
import {validateCodexCanaryProof} from './native/installed-codex-proof.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const at = Date.parse('2026-11-09T00:00:00Z');
const pairs = [{prompt: 'First exact prompt', token: 'FIRST_TOKEN'}, {prompt: 'Second exact prompt', token: 'SECOND_TOKEN'}];
const expected = {nativeId: 'native-thread', cwd: '/owned/project', hostId: 'owner-host', pairs, now: at};
function proof() {
  const session = {id: expected.nativeId, harness: 'codex', cwd: expected.cwd, hostId: expected.hostId, status: 'idle'};
  const turns = pairs.map((pair, i) => ({id: 'turn-' + i, status: 'completed', error: null, items: [
    {id: 'user-' + i, type: 'userMessage', content: [{type: 'text', text: pair.prompt}]},
    {id: 'assistant-' + i, type: 'agentMessage', phase: 'final_answer', text: pair.token},
  ]}));
  const transcriptTail = JSON.stringify(turns);
  return {capability: 'registered-canary-completed-turns', source: 'codex-native-thread-read-completion',
    native_session_id: session.id, cwd: session.cwd, canonical_status: 'idle', observed_at: new Date(at).toISOString(),
    completed_turn_ids: turns.map(turn => turn.id), latest_turn_id: turns.at(-1)!.id,
    canonical_transcript_sha256: hash(transcriptTail), fingerprint: 'a'.repeat(64),
    native_messages_receipt: pairs.flatMap((pair, i) => [
      {role: 'user', text: pair.prompt, turnId: 'turn-' + i},
      {role: 'assistant', text: pair.token, turnId: 'turn-' + i},
    ]),
    canonical_completion_receipt: {session, turnId: turns.at(-1)!.id, transcriptTail, fingerprint: 'a'.repeat(64)}};
}
function changeTurn(value: ReturnType<typeof proof>, mutate: (turns: any[]) => void) {
  const turns = JSON.parse(value.canonical_completion_receipt.transcriptTail); mutate(turns);
  value.canonical_completion_receipt.transcriptTail = JSON.stringify(turns);
  value.canonical_transcript_sha256 = hash(value.canonical_completion_receipt.transcriptTail);
}
describe('independent Codex canonical completion proof', () => {
  it('binds two exact native completed turns without claiming owner-global inventory', () => {
    const value = proof(); expect(validateCodexCanaryProof(value, expected, hash)).toBe(value);
  });
  it('remains self-contained when serialized into the protected native reader child', () => {
    const serialized = Function('return (' + validateCodexCanaryProof.toString() + ')')();
    const value = proof(); expect(serialized(value, expected, hash)).toBe(value);
  });
  it.each(['wrong-id', 'wrong-cwd', 'wrong-host', 'wrong-turn', 'stale', 'wrong-source', 'missing-prompt',
    'missing-token', 'wrong-message-turn', 'in-progress', 'failed-turn', 'non-final', 'unknown-effect', 'unfinished-effect', 'digest'])('rejects %s', mutation => {
    const value = proof();
    switch (mutation) {
      case 'wrong-id': value.canonical_completion_receipt.session.id = 'another-thread'; break;
      case 'wrong-cwd': value.cwd = '/another/project'; break;
      case 'wrong-host': value.canonical_completion_receipt.session.hostId = 'other-host'; break;
      case 'wrong-turn': value.latest_turn_id = 'another-turn'; break;
      case 'stale': value.observed_at = new Date(at - 31000).toISOString(); break;
      case 'wrong-source': value.source = 'connected-native-controller-list'; break;
      case 'missing-prompt': changeTurn(value, turns => {turns[0].items[0].content[0].text = 'not the canary';}); break;
      case 'missing-token': changeTurn(value, turns => {turns[0].items[1].text = 'not the token';}); break;
      case 'wrong-message-turn': value.native_messages_receipt[0].turnId = 'wrong-turn'; break;
      case 'in-progress': changeTurn(value, turns => {turns[0].status = 'inProgress';}); break;
      case 'failed-turn': changeTurn(value, turns => {turns[0].error = {message: 'failed'};}); break;
      case 'non-final': changeTurn(value, turns => {turns[1].items[1].phase = 'commentary';}); break;
      case 'unknown-effect': changeTurn(value, turns => {turns[0].items.splice(1, 0, {id:'x', type:'unknownMutation'});}); break;
      case 'unfinished-effect': changeTurn(value, turns => {turns[0].items.splice(1, 0, {id:'x', type:'commandExecution', status:'inProgress'});}); break;
      case 'digest': value.canonical_transcript_sha256 = 'b'.repeat(64); break;
    }
    expect(() => validateCodexCanaryProof(value, expected, hash)).toThrow('codex_canary_completion_unproven');
  });
  it('rejects duplicate canary turns and a later unrequested canonical turn', () => {
    const duplicate = proof(); duplicate.completed_turn_ids[1] = duplicate.completed_turn_ids[0];
    expect(() => validateCodexCanaryProof(duplicate, expected, hash)).toThrow();
    const extra = proof(); changeTurn(extra, turns => {turns.push({...turns[1], id:'later-turn'});});
    expect(() => validateCodexCanaryProof(extra, expected, hash)).toThrow();
  });
});
