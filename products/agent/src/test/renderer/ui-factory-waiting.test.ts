/**
 * ui-factory-waiting.test.ts, the honest waiting-state wording.
 *
 * UIFactory.busyPhrase derives WHICH waiting state applies (renderer-local)
 * and defers the exact wording to the SDK presentation contract's
 * waitingPhrase(). This proves the state derivation + contract consumption:
 * approval / pre-first-token / stalled / thinking, plus the tool-active stall
 * suppression, plus that THINKING_PHRASES is the SDK's (no local re-mint).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { setActiveThemeMode } from '../../renderer/theme.ts';
import { THINKING_PHRASES } from '@goodvibes-jev/engine/sdk/platform/presentation';

afterEach(() => setActiveThemeMode('dark'));

const STALL = 3_000; // > THINKING_STALL_FREEZE_MS (2500)

describe('computeStallInfo', () => {
  test('undefined until a delta clock exists', () => {
    expect(UIFactory.computeStallInfo(undefined, undefined, undefined, 1000)).toBeUndefined();
  });
  test('reports elapsed silence from the last delta', () => {
    const info = UIFactory.computeStallInfo(1000, undefined, undefined, 4000);
    expect(info?.msSinceLastDelta).toBe(3000);
    expect(info?.reconnect).toBeUndefined();
  });
});

describe('computeRenderStallInfo suppresses stall while a tool is active', () => {
  test('tool active → no stall info (no false Stalled during tool exec)', () => {
    expect(UIFactory.computeRenderStallInfo({ toolActive: true, lastDeltaAtMs: 0, nowMs: STALL })).toBeUndefined();
  });
  test('no tool → stall info flows through', () => {
    const info = UIFactory.computeRenderStallInfo({ toolActive: false, lastDeltaAtMs: 0, nowMs: STALL });
    expect(info?.msSinceLastDelta).toBe(STALL);
  });
});

describe('busyPhrase honest waiting states (the status line\'s phrase)', () => {
  test('approval pending → "Waiting for your approval"', () => {
    expect(UIFactory.busyPhrase(0, undefined, undefined, true)).toContain('Waiting for your approval');
  });

  test('pre-first-token silence → "Waiting for model Ns..." not "Stalled"', () => {
    const out = UIFactory.busyPhrase(0, 0, { msSinceLastDelta: STALL });
    expect(out).toContain('Waiting for model 3s...');
    expect(out).not.toContain('Stalled');
  });

  test('post-stream silence (tokens already flowed) → "Stalled Ns..."', () => {
    expect(UIFactory.busyPhrase(0, 5, { msSinceLastDelta: STALL })).toContain('Stalled 3s...');
  });

  test('reconnecting → "Reconnecting (attempt n/m)..."', () => {
    expect(UIFactory.busyPhrase(0, 5, { msSinceLastDelta: STALL, reconnect: { attempt: 2, maxAttempts: 5 } })).toContain('Reconnecting (attempt 2/5)...');
  });

  test('no stall → a rotated THINKING_PHRASE from the SDK contract', () => {
    expect(UIFactory.busyPhrase(0)).toContain(THINKING_PHRASES[0]); // frame 0 → 'Thinking...'
  });

  test('the throbber never shows tok/s while waiting on an approval', async () => {
    const { buildShellFooter } = await import('../../renderer/shell-surface.ts');
    const { resolveThrobberActivity } = await import('../../renderer/throbber.ts');
    const activity = resolveThrobberActivity({
      turnActive: true, compacting: false, now: 0, modelPhrase: UIFactory.busyPhrase(0, undefined, undefined, true), tokenSpeed: 42,
      pendingApproval: { name: 'exec', args: { command: 'ls' } },
    })!;
    const throbber = buildShellFooter({
      width: 120, promptText: '', promptLineCount: 1, usage: { up: 0, down: 0 }, showExitNotice: false, lastCopyTime: 0,
      runningAgentCount: 0, runningProcessCount: 0, indicatorFocused: false,
      throbber: { spinner: '-', frame: 0, activity }, turnRunning: true,
    }).lines[1]!.map((c) => c.char).join('');
    expect(throbber).toContain('Waiting for your approval');
    expect(throbber).not.toContain('tok/s');
  });
});
