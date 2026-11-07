import { describe, it, expect } from 'vitest';
import { INCIDENT_EXECUTION, normalizeHealthExecution, normalizeIncidentExecution, healthModelForHarness, isApprovedHealthRoute } from '../src/health-remediation.js';
const direct = { runtime: 'opencode', provider: 'minimax-coding-plan', model: 'MiniMax-M3.1-Flash', reasoning: 'default', topic: 'health' };
describe('direct MiniMax incident contract', () => {
  it('pins the actual provider and model', () => {
    expect(INCIDENT_EXECUTION).toEqual(direct);
    expect(normalizeIncidentExecution(direct)).toEqual(direct);
    expect(normalizeHealthExecution(direct)).toEqual(direct);
    expect(healthModelForHarness('opencode', normalizeHealthExecution(direct))).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');
  });
  it('rejects other incident routes', () => {
    for (const model of ['omniroute/glm-5.3-flash-minimax-m3.1', 'auto/minimax', 'minimax-coding-plan/other']) {
      expect(isApprovedHealthRoute(model)).toBe(false);
      expect(() => normalizeIncidentExecution({...direct, model})).toThrow();
    }
  });
});
