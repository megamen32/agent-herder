import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, it, expect} from 'vitest';
import {SessionSidebarRow} from '../src/web-ui/session-sidebar.js';

describe('sidebar row (focused renderer; expected2s/max20s)', () => {
 it('uses separate open and pin buttons and one compact identity line', () => {
  const html=renderToStaticMarkup(<SessionSidebarRow session={{id:'native',hostId:'roomhacker-server-100',harness:'codex',title:'Long task title',cwd:'/launch',status:'running',lastActivity:'2026-10-13T12:00:00Z'}} title="Long task title" selected={false} pinned={true} canPin={true} statusClass="running" onSelect={()=>{}} onPin={()=>{}} />);
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain('Codex · Сервер 100');expect(html).toContain('session-identity');
  expect(html).toContain('aria-pressed="true"');expect(html).toContain('Открепить сессию: Long task title');
  expect(html).not.toMatch(/<button[^>]*>[\s\S]*<button[\s\S]*<\/button>[\s\S]*<\/button>/);
  expect(html).not.toContain('/api/');
 });
 it('disables pin before verified host/account metadata is available', () => {
  const html=renderToStaticMarkup(<SessionSidebarRow session={{id:'native',harness:'zcode',title:'Task',cwd:'',status:'idle',lastActivity:''}} title="Task" selected={false} pinned={false} canPin={false} statusClass="idle" onSelect={()=>{}} onPin={()=>{}} />);
  expect(html).toContain('Машина не подтверждена');expect(html).toContain('disabled=""');expect(html).toContain('aria-pressed="false"');
 });
 it('binds the rendered row to exact native identity, owner host and canonical status', () => {
  for(const harness of ['chatgpt','zai','opencode','codex','zcode']){
   const html=renderToStaticMarkup(<SessionSidebarRow session={{id:'native-'+harness,hostId:'roomhacker-server-100',harness,title:'Task',cwd:'',status:'running',lastActivity:''}} title="Task" selected={false} pinned={false} canPin={true} statusClass="running" onSelect={()=>{}} onPin={()=>{}} />);
   expect(html).toContain('data-native-session-id="native-'+harness+'"');
   expect(html).toContain('data-harness="'+harness+'"');
   expect(html).toContain('data-status="running"');
   expect(html).toContain('data-host-id="roomhacker-server-100"');
  }
 });
 it('uses explicit local native identity and never presents a core reference as native', () => {
  const render=(id:string,meta?:Record<string,unknown>,remote?:boolean)=>renderToStaticMarkup(<SessionSidebarRow session={{id,meta,remote,harness:'opencode',title:'Task',cwd:'',status:'stopped',lastActivity:''}} title="Task" selected={false} pinned={false} canPin={false} statusClass="idle" onSelect={()=>{}} onPin={()=>{}} />);
  expect(render('session:core',{nativeSessionId:'ses_native'})).toContain('data-native-session-id="ses_native"');
  expect(render('session:core')).not.toContain('data-native-session-id');
  expect(render('session:core',{nativeSessionId:'session:other-core'})).not.toContain('data-native-session-id');
  expect(render('remote-native',{nativeSessionId:'local-alias'},true)).toContain('data-native-session-id="remote-native"');
  expect(render('ses_native')).not.toContain('data-host-id');
 });
});
