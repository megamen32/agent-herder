import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import type {SessionMessageView} from '../src/types/index.js';
import type {OutboxEntry} from '../src/web-ui/composer-delivery.js';
import {projectDeliveredChat,resolveDeliveredImages} from '../src/web-ui/delivered-chat.js';

const at=Date.parse('2026-10-13T10:00:00Z');
const sent=(extra:Partial<OutboxEntry>={}):OutboxEntry=>({inputId:'input-a',sessionKey:'zcode:s1',text:'**Уточнение:** только причина',mode:'steer',status:'delivered',createdAt:at,...extra});
const native=(extra:Partial<SessionMessageView>={}):SessionMessageView=>({id:'native-user',role:'user',timestamp:new Date(at+200).toISOString(),text:'**Уточнение:** только причина',parts:[{type:'text',text:'**Уточнение:** только причина'}],...extra});

describe('confirmed delivery joins the conversation without another send',()=>{
 it('puts confirmed text in the chat, not a composer card, while native history is still missing',()=>{
  const view=projectDeliveredChat([], [sent()], 'zcode:s1');
  expect(view.messages).toHaveLength(1);expect(view.messages[0]).toMatchObject({role:'user',text:sent().text});expect(view.pending).toEqual([]);
 });
 it('keeps uncertain acceptance and failures in the composer, without claiming delivery',()=>{
  for(const status of ['ready','sending','accepted','deferred','pending','unknown','failed'] as const){
   const entry=sent({status});const view=projectDeliveredChat([], [entry], 'zcode:s1');expect(view.messages).toEqual([]);expect(view.pending).toEqual([entry]);
  }
 });
 it('replaces the local delivered bubble with one matching native user message on refresh',()=>{
  const item=native();const view=projectDeliveredChat([item], [sent()], 'zcode:s1');expect(view.messages).toEqual([item]);expect(view.pending).toEqual([]);
 });
 it('does not mistake an earlier identical task for the newly delivered clarification',()=>{
  const old=native({timestamp:new Date(at-60_000).toISOString()});expect(projectDeliveredChat([old],[sent()],'zcode:s1').messages).toHaveLength(2);
 });
 it('does not treat an earlier same-turn message as a new steer input',()=>{
  const old=native({turnId:'same-turn',timestamp:new Date(at-60_000).toISOString()});
  expect(projectDeliveredChat([old],[sent({nativeTurnId:'same-turn'})],'zcode:s1').messages).toHaveLength(2);
 });
 it('does not merge a later unrelated identical task or a different known native turn',()=>{
  const later=native({timestamp:new Date(at+60_000).toISOString()});expect(projectDeliveredChat([later],[sent()],'zcode:s1').messages).toHaveLength(2);
  const different=native({turnId:'turn-b'});expect(projectDeliveredChat([different],[sent({nativeTurnId:'turn-a'})],'zcode:s1').messages).toHaveLength(2);
 });
 it('uses a proven turn or a later observed queue admission without confusing send time with execution time',()=>{
  const later=native({turnId:'turn-a',timestamp:new Date(at+60_000).toISOString()});expect(projectDeliveredChat([later],[sent({nativeTurnId:'turn-a'})],'zcode:s1').messages).toEqual([later]);
  const queued=native({timestamp:new Date(at+60_000).toISOString()});expect(projectDeliveredChat([queued],[sent({deliveredAt:at+60_100})],'zcode:s1').messages).toEqual([queued]);
 });
 it('matches identical repeated sends one for one instead of dropping a message',()=>{
  const items=[sent(),sent({inputId:'input-b',createdAt:at+100})];const view=projectDeliveredChat([native()],items,'zcode:s1');expect(view.messages).toHaveLength(2);expect(view.pending).toEqual([]);
 });
 it('leaves another session outbox alone and does not mutate native messages or receipts',()=>{
  const item=native();const entry=sent();const before=JSON.stringify({item,entry});expect(projectDeliveredChat([item],[entry],'codex:s1').messages).toEqual([item]);expect(JSON.stringify({item,entry})).toBe(before);
 });
 it('renders attachments with the normal user message even when only the delivery receipt is available',()=>{
  const image={id:'a'.repeat(64),url:'/api/session-images/'+ 'a'.repeat(64),fileName:'screen.png',mimeType:'image/png',bytes:1};
  const view=projectDeliveredChat([],[sent({images:[image]})],'zcode:s1');expect(view.messages[0].parts).toContainEqual({type:'image',imageUrl:image.url,fileName:image.fileName});
 });
 it('recognizes an exact input ID even when native images use data URLs',()=>{
  const image={id:'a'.repeat(64),url:'/api/session-images/'+ 'a'.repeat(64),fileName:'screen.png',mimeType:'image/png',bytes:8};
  const item=native({id:'input-a',parts:[{type:'text',text:sent().text},{type:'image',imageUrl:'data:image/png;base64,iVBORw0KGgo='}]});
  expect(projectDeliveredChat([item],[sent({images:[image]})],'zcode:s1').messages).toEqual([item]);
 });
 it('matches Codex dataURL bytes to the real upload SHA, not just image count or same turn',async()=>{
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  const id=createHash('sha256').update('codex\0s1\0screen.png\0').update(bytes).digest('hex');
  const image={id,url:'/api/session-images/'+id,fileName:'screen.png',mimeType:'image/png',bytes:bytes.length};
  const entry=sent({sessionKey:'codex:s1',nativeTurnId:'turn-photo',images:[image]});
  const item=native({turnId:'turn-photo',parts:[{type:'text',text:sent().text},{type:'image',imageUrl:'data:image/png;base64,'+bytes.toString('base64')}]});
  const matches=await resolveDeliveredImages([item],[entry],'codex:s1');
  expect(projectDeliveredChat([item],[entry],'codex:s1',matches).messages).toEqual([item]);
  const other=native({turnId:'turn-photo',parts:[{type:'text',text:sent().text},{type:'image',imageUrl:'data:image/png;base64,'+Buffer.from([1,2,3]).toString('base64')}]});
  const noMatch=await resolveDeliveredImages([other],[entry],'codex:s1');
  expect(projectDeliveredChat([other],[entry],'codex:s1',noMatch).messages).toHaveLength(2);
 });
 it('inserts a delivered clarification at its send time without reordering native history',()=>{
  const before=native({id:'assistant-a',role:'assistant',timestamp:new Date(at-100).toISOString(),text:'Начало'});
  const after=native({id:'assistant-b',role:'assistant',timestamp:new Date(at+1000).toISOString(),text:'Продолжение'});
  const view=projectDeliveredChat([before,after],[sent()],'zcode:s1');expect(view.messages.map(m=>m.text)).toEqual(['Начало',sent().text,'Продолжение']);
 });
});
