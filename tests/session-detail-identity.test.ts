import { describe, expect, it } from 'vitest';
import { detailQuery, resolveDetailHost, verifiedDetailAttributes } from '../src/web-ui/session-detail-identity.js';

const expected = { id: 'ses_native', harness: 'opencode', hostId: 'server100' };

describe('native session detail identity', () => {
  it('requires the confirmed native response to match every selected identity field', () => {
    expect(verifiedDetailAttributes(expected, expected, true)).toEqual({
      'data-details-verified': 'true', 'data-native-session-id': 'ses_native',
      'data-harness': 'opencode', 'data-host-id': 'server100',
    });
    for (const response of [
      { ...expected, id: 'ses_other' }, { ...expected, harness: 'codex' },
      { ...expected, hostId: 'server44' }, { ...expected, hostId: undefined },
    ]) expect(verifiedDetailAttributes(expected, response, true)).toEqual({});
  });

  it('never certifies stale, cached, absent, or core-reference detail identities', () => {
    expect(verifiedDetailAttributes(expected, expected, false)).toEqual({});
    expect(verifiedDetailAttributes(expected, undefined, true)).toEqual({});
    expect(verifiedDetailAttributes({ ...expected, hostId: undefined }, expected, true)).toEqual({});
    const core = { ...expected, id: 'session:core-reference' };
    expect(verifiedDetailAttributes(core, core, true)).toEqual({});
  });

  it('uses a unique catalog host and refuses ambiguous cross-host native IDs', () => {
    expect(resolveDetailHost([expected], 'opencode', 'ses_native', 'fallback')).toBe('server100');
    expect(resolveDetailHost([expected, { ...expected }], 'opencode', 'ses_native')).toBe('server100');
    expect(resolveDetailHost([expected, { ...expected, hostId: 'server44' }], 'opencode', 'ses_native', 'server100')).toBeUndefined();
    expect(resolveDetailHost([], 'opencode', 'ses_native', 'server100')).toBe('server100');
    expect(resolveDetailHost([], 'opencode', 'ses_native')).toBeUndefined();
  });

  it('passes the selected host to both actual details loader requests', () => {
    const quick = new URLSearchParams(detailQuery(12, true, 'host:100'));
    const full = new URLSearchParams(detailQuery(50, false, 'host:100'));
    expect(Object.fromEntries(quick)).toEqual({ limit: '12', quick: '1', runtimeHostId: 'host:100' });
    expect(Object.fromEntries(full)).toEqual({ limit: '50', runtimeHostId: 'host:100' });
    expect(new URLSearchParams(detailQuery(12, true)).has('runtimeHostId')).toBe(false);
  });
});
