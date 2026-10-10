import {describe,it,expect} from 'vitest';
import {fleetSessionLink} from '../src/web-ui/fleet/session-link.js';
// Fast unit; purpose: real receipt address stays on its host, expected1s/max120s.
describe('fleet created-session link',()=>{
 const host={hostId:'88',label:'88',uiUrl:'https://agent88.bezrabotnyi.com/'};
 it('opens a newly created native thread directly without requiring discovery',()=>{
  expect(fleetSessionLink(host,{hostId:'88',harness:'codex',nativeSessionId:'native:id'})).toBe('https://agent88.bezrabotnyi.com/#/session/codex%3Anative%3Aid');
 });
 it('refuses a different destination machine',()=>{expect(fleetSessionLink(host,{hostId:'100',harness:'codex',nativeSessionId:'same'})).toBeUndefined();});
 it('does not invent an endpoint for an unregistered cabinet',()=>{expect(fleetSessionLink(undefined,{hostId:'88',harness:'codex',nativeSessionId:'same'})).toBeUndefined();});
});
