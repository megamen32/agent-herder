import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, it, expect} from 'vitest';
import {SessionSidebarRow} from '../src/web-ui/session-sidebar.js';

describe('sidebar row (focused renderer; expected2s/max20s)', () => {
 it('uses separate open and pin buttons and one compact identity line', () => {
  const html=renderToStaticMarkup(<SessionSidebarRow session={{id:'native',hostId:'roomhacker-server-100',harness:'codex',title:'Long task title',cwd:'/launch',status:'running',lastActivity:'2026-10-13T12:00:00Z'}} title="Long task title" selected={false} pinned={true} canPin={true} statusClass="running" onSelect={()=>{}} onPin={()=>{}} />);
  expect(html.match(/<button/g)).toHaveLength(2);
  expect(html).toContain('Codex · 100');expect(html).toContain('session-identity');
  expect(html).toContain('aria-pressed="true"');expect(html).toContain('Открепить сессию: Long task title');
  expect(html).not.toMatch(/<button[^>]*>[\s\S]*<button[\s\S]*<\/button>[\s\S]*<\/button>/);
  expect(html).not.toContain('/api/');
 });
 it('disables pin before verified host/account metadata is available', () => {
  const html=renderToStaticMarkup(<SessionSidebarRow session={{id:'native',harness:'zcode',title:'Task',cwd:'',status:'idle',lastActivity:''}} title="Task" selected={false} pinned={false} canPin={false} statusClass="idle" onSelect={()=>{}} onPin={()=>{}} />);
  expect(html).toContain('Машина не подтверждена');expect(html).toContain('disabled=""');expect(html).toContain('aria-pressed="false"');
 });
});
