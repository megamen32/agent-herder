// Fast unit, expected .1s/max2s. A repeated Continue click must not create a
// second native intent while the first acknowledgement is still uncertain.
import {expect,it,vi} from 'vitest';
import {planContinuation, type OutboxEntry} from '../src/web-ui/composer-delivery.js';
it.each(['ready','sending','accepted','deferred','pending','unknown'] as const)('keeps the same %s continuation rather than sending another one',status=>{
 const fresh=vi.fn(()=> 'new-id');
 const first=planContinuation([],'zcode:owned',fresh);
 const entry={inputId:first.inputId,sessionKey:'zcode:owned',text:first.text,mode:'queue',createdAt:1,status} as OutboxEntry;
 expect(planContinuation([entry],'zcode:owned',fresh)).toEqual({...first,alreadyPending:status!=='ready'});
 expect(fresh).toHaveBeenCalledTimes(1);
});
it('permits the next explicit continuation after actual delivery and isolates session identities',()=>{
 const first=planContinuation([],'zcode:first',()=> 'first-id');
 const entry={inputId:first.inputId,sessionKey:'zcode:first',text:first.text,mode:'queue',createdAt:1,status:'delivered'} as OutboxEntry;
 expect(planContinuation([entry],'zcode:first',()=> 'second-id')).toMatchObject({inputId:'second-id',alreadyPending:false});
 expect(planContinuation([{...entry,status:'pending'}],'zcode:second',()=> 'other-id')).toMatchObject({inputId:'other-id',alreadyPending:false});
});
