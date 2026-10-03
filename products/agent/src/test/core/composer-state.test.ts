import { describe, expect, test } from 'bun:test';
import { deriveComposerState } from '../../core/composer-state.ts';

describe('composer state', () => {
  test('exposes command mode and approval wait flags', () => {
    const state = deriveComposerState({
      text: '/review current branch',
      commandMode: true,
      pendingApproval: true,
      turnState: 'preflight',
    });
    expect(state.modeLabel).toBe('delegation');
    expect(state.statusLabel).toBe('preflight');
    expect(state.flags).toContain('approval');
    expect(state.flags).toContain('delegation');
    expect(state.pendingRisk).toBe('approval-wait');
  });

  test('marks shell submissions as risky without approval wait', () => {
    const state = deriveComposerState({
      text: '!rm -rf build',
      turnState: 'idle',
    });
    expect(state.modeLabel).toBe('shell');
    expect(state.pendingRisk).toBe('shell');
  });
});
