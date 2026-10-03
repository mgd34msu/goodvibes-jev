import { describe, expect, test } from 'bun:test';
import { ContextAccountingHolder, createContextAccountingTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { bindOrchestratorContextAccounting } from '../../runtime/context-accounting-source.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

interface ParsedOutput {
  available: boolean;
  reason?: string;
  scope?: string;
  sessionId?: string;
  tokenBudget?: {
    measured: { input: number; output: number; cacheRead: number; cacheWrite: number };
    lastInputTokens: number;
    contextWindow: number | null;
    contextUsedPctEstimated: number | null;
  };
  compaction?: { isCompacting: boolean; compactionCount?: number };
}

function fakeOrchestrator(turnInjections: unknown[] = []) {
  return {
    usage: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 60 },
    lastInputTokens: 2500,
    getTurnInjections: () => turnInjections as never,
  };
}

describe('bindOrchestratorContextAccounting (SDK 1.6.1 context_accounting tool)', () => {
  test('unbound holder: the context_accounting tool reports the honest "no live session context" message', async () => {
    const holder = new ContextAccountingHolder();
    const tool = createContextAccountingTool(holder);
    const result = await tool.execute({}, {} as never);
    expect(result.success).toBe(true);
    const parsed = JSON.parse((result as { output: string }).output) as ParsedOutput;
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe('No live session context is bound to this tool instance. Context accounting is populated on the interactive session.');
  });

  test('bound to a real Orchestrator-backed source: the tool returns real token/injection/compaction data, not the unbound message', async () => {
    const holder = new ContextAccountingHolder();
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    const orchestrator = fakeOrchestrator();

    const unbind = bindOrchestratorContextAccounting({
      orchestrator,
      holder,
      runtimeBus,
      runtimeStore,
      sessionId: 'session-ctx-1',
      getContextWindow: () => 200_000,
      scope: 'main session',
    });

    const tool = createContextAccountingTool(holder);
    const result = await tool.execute({}, {} as never);
    expect(result.success).toBe(true);
    const parsed = JSON.parse((result as { output: string }).output) as ParsedOutput;
    expect(parsed.available).toBe(true);
    expect(parsed.scope).toBe('main session');
    expect(parsed.sessionId).toBe('session-ctx-1');
    expect(parsed.tokenBudget).toEqual({
      measured: { input: 1200, output: 340, cacheRead: 900, cacheWrite: 60 },
      lastInputTokens: 2500,
      contextWindow: 200_000,
      contextUsedPctEstimated: 1.3,
    });
    expect(parsed.compaction).toEqual({ isCompacting: false, compactionCount: 0 });

    unbind();
  });

  test('compaction state and count track live runtime-store/bus signals for this session only', async () => {
    const holder = new ContextAccountingHolder();
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    const orchestrator = fakeOrchestrator();

    const unbind = bindOrchestratorContextAccounting({
      orchestrator,
      holder,
      runtimeBus,
      runtimeStore,
      sessionId: 'session-ctx-2',
      getContextWindow: () => null,
    });
    const tool = createContextAccountingTool(holder);

    // A compaction pass is in progress: reflected via the same session-domain
    // reducer state agent-runtime-events.ts's 'compaction' domain subscription
    // already updates in production.
    runtimeStore.setState((state) => ({ ...state, session: { ...state.session, compactionState: 'autocompact' } }));
    let parsed = JSON.parse((await tool.execute({}, {} as never) as { output: string }).output) as ParsedOutput;
    expect(parsed.compaction?.isCompacting).toBe(true);
    expect(parsed.compaction?.compactionCount).toBe(0);

    // An applied receipt for THIS session increments the count.
    runtimeBus.emit('compaction', createEventEnvelope('COMPACTION_RECEIPT', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 'session-ctx-2',
      trigger: 'auto',
      strategy: 'structured',
      tokensBefore: 10_000,
      tokensAfter: 3_000,
      messagesBefore: 30,
      messagesAfter: 5,
      qualityScore: 0.95,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: true,
      validationPassed: true,
      sectionsIncluded: [],
      outcome: 'applied',
    }, { sessionId: 'session-ctx-2', source: 'test-suite' }));
    // A kept-original receipt for a DIFFERENT session must not inflate this count.
    runtimeBus.emit('compaction', createEventEnvelope('COMPACTION_RECEIPT', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 'session-other',
      trigger: 'auto',
      strategy: 'structured',
      tokensBefore: 10_000,
      tokensAfter: 3_000,
      messagesBefore: 30,
      messagesAfter: 5,
      qualityScore: 0.95,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: true,
      validationPassed: true,
      sectionsIncluded: [],
      outcome: 'applied',
    }, { sessionId: 'session-other', source: 'test-suite' }));
    await flushMicrotasks();

    runtimeStore.setState((state) => ({ ...state, session: { ...state.session, compactionState: 'done' } }));
    parsed = JSON.parse((await tool.execute({}, {} as never) as { output: string }).output) as ParsedOutput;
    expect(parsed.compaction?.isCompacting).toBe(false);
    expect(parsed.compaction?.compactionCount).toBe(1);

    unbind();
    // After unbind the holder reverts to the unbound honesty message.
    parsed = JSON.parse((await tool.execute({}, {} as never) as { output: string }).output) as ParsedOutput;
    expect(parsed.available).toBe(false);
  });
});
