import { describe, it, expect } from 'vitest';
import { INCIDENT_EXECUTION, normalizeHealthExecution, normalizeIncidentExecution, healthModelForHarness, isApprovedHealthRoute } from '../src/health-remediation.js';
const direct = { runtime: 'opencode', provider: 'minimax-coding-plan', model: 'MiniMax-M3.1-Flash', reasoning: 'default', topic: 'health' };
const luna = { runtime: 'opencode', provider: 'omniroute', model: 'omniroute/cx/gpt-6-luna', reasoning: 'default', topic: 'health' };
describe('Herder incident execution model contract', () => {
  it('defaults to Luna while retaining the direct MiniMax profile for rollout compatibility', () => {
    expect(INCIDENT_EXECUTION).toEqual(luna);
    expect(normalizeIncidentExecution(direct)).toEqual(direct);
    expect(normalizeHealthExecution(direct)).toEqual(direct);
    expect(healthModelForHarness('opencode', normalizeHealthExecution(direct))).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');
    expect(normalizeIncidentExecution(luna)).toEqual(luna);
  });
  it('rejects other incident routes', () => {
    for (const model of ['bad model', 'x'.repeat(257), 'bad\nmodel']) {
      expect(isApprovedHealthRoute(model)).toBe(false);
      expect(() => normalizeIncidentExecution({...direct, model})).toThrow();
    }
    expect(normalizeIncidentExecution({...luna, model: 'omniroute/cx/gpt-6-luna/extra'}).model).toBe('omniroute/cx/gpt-6-luna/extra');
  });
});
