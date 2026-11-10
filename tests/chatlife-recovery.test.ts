import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserChatDraftStore } from '../src/adapters/browser-chat-drafts.js';

it('discards only pending drafts in the selected account and preserves uncertain sends', async()=>{
  const root=await mkdtemp(join(tmpdir(),'chatlife-recovery-'));
  try {
    const s=new BrowserChatDraftStore('chatgpt',root);
    await s.useScope('a'.repeat(64));
    const pending=await s.create(); const unknown=await s.create();
    await s.startSend(unknown.id); await s.markUncertain(unknown.id);
    await expect(s.discard(unknown.id)).rejects.toThrow();
    await s.discard(pending.id);
    await s.useScope('b'.repeat(64));
    await expect(s.discard(unknown.id)).rejects.toThrow();
    await s.useScope('a'.repeat(64));
    expect(s.get(pending.id)).toBeUndefined(); expect(s.get(unknown.id)?.state).toBe('uncertain');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('persists the accepted original command reference across restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'chatlife-recovery-'));
  try {
    const s=new BrowserChatDraftStore('chatgpt',root);await s.useScope('a'.repeat(64));
    const draft=await s.create();await s.startSend(draft.id);
    await s.recordCommand(draft.id,'agent-default:abc');await s.markUncertain(draft.id);
    const next=new BrowserChatDraftStore('chatgpt',root);await next.useScope('a'.repeat(64));
    expect(next.get(draft.id)?.commandId).toBe('agent-default:abc');
  } finally { await rm(root,{recursive:true,force:true}); }
});
