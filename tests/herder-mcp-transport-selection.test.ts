// Fast unit: expected 1s/max 10s. Catches an unused stdio channel in a managed
// HTTP singleton; SDK double establishes only transport-selection behavior.
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({serve:vi.fn()}));
vi.mock('@modelcontextprotocol/server/stdio',()=>({serveStdio:state.serve}));
import {startSelectedStdio} from '../src/mcp/transport-selection.js';
beforeEach(()=>state.serve.mockClear());
describe('managed HTTP transport choice',()=>{
 it('does not attach a stdio channel or construct a stdio server when HTTP is configured',()=>{
  const factory=vi.fn(),onerror=vi.fn();
  expect(startSelectedStdio('18789',factory,onerror)).toBe(false);
  expect(state.serve).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();
 });
 it('keeps the original standalone CLI factory/error handler when HTTP is absent',()=>{
  const factory=vi.fn(),onerror=vi.fn();
  expect(startSelectedStdio(undefined,factory,onerror)).toBe(true);
  expect(state.serve).toHaveBeenCalledExactlyOnceWith(factory,{onerror});
 });
});
