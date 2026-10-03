/**
 * thinking-overlay.test.ts, the extracted stall clock + overlay builder.
 */

import { describe, expect, test } from 'bun:test';
import { ThinkingStallClock, buildThrobberState, buildThinkingOverlay, createThrobberSource, mainPermissionAsk, type ThinkingOverlayDeps, type ThrobberDeps } from '../../core/thinking-overlay.ts';

const STALL = 3_000; // > THINKING_STALL_FREEZE_MS (2500)

function fakeOrchestrator(over: Partial<ThinkingOverlayDeps['orchestrator']> = {}): ThinkingOverlayDeps['orchestrator'] {
  return {
    isThinking: true,
    getSpinner: () => '-',
    thinkingFrame: 0,
    streamingInputTokens: 0,
    streamingOutputTokens: 0,
    ...over,
  };
}
const cfg = { get: () => false } as ThinkingOverlayDeps['configManager'];

describe('ThinkingStallClock', () => {
  test('seeds at turn start (no stall on the first tick)', () => {
    const clock = new ThinkingStallClock();
    const info = clock.tick(0, false, 1000);
    expect(info?.msSinceLastDelta).toBe(0);
  });

  test('reports growing silence when output does not advance', () => {
    const clock = new ThinkingStallClock();
    clock.tick(0, false, 1000);        // seed
    const info = clock.tick(0, false, 1000 + STALL);
    expect(info?.msSinceLastDelta).toBe(STALL);
  });

  test('an output-token advance resets the silence', () => {
    const clock = new ThinkingStallClock();
    clock.tick(0, false, 1000);
    clock.tick(5, false, 1000 + STALL); // tokens advanced → clock moves forward
    const info = clock.tick(5, false, 1000 + STALL + 10);
    expect(info?.msSinceLastDelta).toBe(10);
  });

  test('tool active suppresses stall detection', () => {
    const clock = new ThinkingStallClock();
    clock.tick(0, false, 1000);
    expect(clock.tick(0, true, 1000 + STALL)).toBeUndefined();
  });

  test('reset re-seeds the next turn', () => {
    const clock = new ThinkingStallClock();
    clock.tick(0, false, 1000);
    clock.reset();
    expect(clock.tick(0, false, 5000)?.msSinceLastDelta).toBe(0); // seeded fresh at 5000
  });
});

describe('buildThrobberState and buildThinkingOverlay', () => {
  const base = (over: Partial<ThrobberDeps> = {}): ThrobberDeps => ({
    orchestrator: fakeOrchestrator(),
    configManager: cfg,
    streamToolPreview: undefined,
    streamTokenSpeed: 0,
    approvalPending: false,
    width: 60,
    clock: new ThinkingStallClock(),
    pendingApproval: null,
    activeTool: null,
    compacting: false,
    ...over,
  });

  test('the throbber state is null at rest and the clock resets', () => {
    const clock = new ThinkingStallClock();
    clock.tick(0, false, 1000); // seed it
    expect(buildThrobberState(base({ orchestrator: fakeOrchestrator({ isThinking: false }), clock }))).toBeNull();
    // clock was reset → next tick re-seeds (no stall)
    expect(clock.tick(0, false, 99_999)?.msSinceLastDelta).toBe(0);
  });

  test('thinking → the model\'s honest phrase with the turn elapsed', () => {
    const state = buildThrobberState(base());
    expect(state).not.toBeNull();
    expect(state!.spinner).toBe('-');
    expect(state!.activity.kind).toBe('model');
    if (state!.activity.kind === 'model') {
      expect(state!.activity.phrase.length).toBeGreaterThan(0);
      expect(state!.activity.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('a running tool is named with its argument', () => {
    const state = buildThrobberState(base({ activeTool: { name: 'exec', args: { command: 'bun test' }, startedAtMs: Date.now() - 2_000 } }));
    expect(state!.activity).toMatchObject({ kind: 'tool', tool: 'Running a command', argument: 'bun test' });
  });

  test('a pending approval comes first and names the call it holds', () => {
    const state = buildThrobberState(base({ approvalPending: true, pendingApproval: { name: 'exec', args: { command: 'rm -rf dist' } }, activeTool: { name: 'exec', args: { command: 'rm -rf dist' } } }));
    expect(state!.activity).toMatchObject({ kind: 'approval', tool: 'Running a command', argument: 'rm -rf dist' });
  });

  test('a compaction shows even with no turn running', () => {
    const state = buildThrobberState(base({ orchestrator: fakeOrchestrator({ isThinking: false }), compacting: true, compactingSinceMs: Date.now() - 4_000 }));
    expect(state!.activity.kind).toBe('compacting');
  });

  test('the transcript gets no rows of its own unless the tool preview is on', () => {
    expect(buildThinkingOverlay(base({ orchestrator: fakeOrchestrator({ isThinking: false }) }))).toEqual([]);
    expect(buildThinkingOverlay(base({ streamToolPreview: 'web_search {"q": "fares"}' })).length).toBeLessThanOrEqual(1);
  });
});

describe('the throbber source', () => {
  const deps = (over: Partial<ThinkingOverlayDeps> = {}): ThinkingOverlayDeps => ({
    orchestrator: fakeOrchestrator(), configManager: cfg, streamToolPreview: undefined, streamTokenSpeed: 0,
    approvalPending: false, width: 60, clock: new ThinkingStallClock(), ...over,
  });
  function fakeTools() {
    const listeners = new Map<string, Array<(ev: never) => void>>();
    return {
      on(event: string, handler: (ev: never) => void) { listeners.set(event, [...(listeners.get(event) ?? []), handler]); return () => {}; },
      emit(event: string, payload: Record<string, unknown>) { for (const h of listeners.get(event) ?? []) h(payload as never); },
    };
  }

  test('only main\'s own ask counts: an ask brokered for a background agent is not main\'s activity', () => {
    const own = { tool: 'exec', args: {} };
    expect(mainPermissionAsk(own)).toBe(own);
    expect(mainPermissionAsk({ tool: 'exec', args: {}, attribution: { agentId: 'eng' } })).toBeNull();
    expect(mainPermissionAsk(null)).toBeNull();
  });

  test('names the running call from the tool events, and forgets it once the turn ends', () => {
    const tools = fakeTools();
    const source = createThrobberSource(tools as never, () => false);
    tools.emit('TOOL_RECEIVED', { callId: 'c1', tool: 'exec', args: { command: 'bun test' } });
    tools.emit('TOOL_EXECUTING', { callId: 'c1', tool: 'exec', startedAt: Date.now() });
    expect(source.state({ ...deps(), pendingApproval: null })!.activity).toMatchObject({ kind: 'tool', argument: 'bun test' });
    expect(source.state({ ...deps({ orchestrator: fakeOrchestrator({ isThinking: false }) }), pendingApproval: null })).toBeNull();
    expect(source.state({ ...deps(), pendingApproval: null })!.activity.kind).toBe('model');
  });

  test('a compaction shows with its own elapsed clock, and goes when it ends', () => {
    let compacting = true;
    const source = createThrobberSource(fakeTools() as never, () => compacting);
    const idle = { ...deps({ orchestrator: fakeOrchestrator({ isThinking: false }) }), pendingApproval: null };
    const state = source.state(idle);
    expect(state!.activity.kind).toBe('compacting');
    if (state!.activity.kind === 'compacting') expect(state!.activity.elapsedMs).toBeGreaterThanOrEqual(0);
    compacting = false;
    expect(source.state(idle)).toBeNull();
  });
});
