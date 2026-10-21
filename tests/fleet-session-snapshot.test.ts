import {describe,it,expect} from 'vitest';
import {failedSessionSnapshot} from '../src/web-ui/fleet/session-snapshot.js';

describe('fleet session list recovery',()=>{
 it('keeps the last successful list for the same machine and marks it stale after a failed refresh',()=>{
  const last={hostId:'roomhacker-server-100',sessions:[{id:'native-1'}],complete:true,stale:false,hasPrevious:true};
  expect(failedSessionSnapshot(last,last.hostId)).toEqual({
   hostId:last.hostId,sessions:last.sessions,complete:false,stale:true,hasPrevious:true,
  });
 });

 it('never carries one machine session list into another machine after a read failure',()=>{
  const last={hostId:'server-44',sessions:[{id:'foreign-native'}],complete:true,stale:false,hasPrevious:true};
  expect(failedSessionSnapshot(last,'roomhacker-server-100')).toEqual({
   hostId:'roomhacker-server-100',sessions:[],complete:false,stale:true,hasPrevious:false,
  });
 });

 it('does not claim a previous list when the first read fails',()=>{
  expect(failedSessionSnapshot(null,'roomhacker-server-100')).toEqual({
   hostId:'roomhacker-server-100',sessions:[],complete:false,stale:true,hasPrevious:false,
  });
 });
});
