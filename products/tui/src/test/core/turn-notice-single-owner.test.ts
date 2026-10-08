/**
 * One end-of-turn notice per user turn (owner rulings 2026-09-29: every
 * notification names the work; fixes are automatic).
 *
 * 1. The TUI's long-task notifier owns the turn's desktop popup, so the wiring
 *    hands the SDK Orchestrator's own end-of-turn popup off: a long turn pops
 *    once, not twice. What the Orchestrator's popup gave the TUI and the
 *    long-task path did not (the bell above 5s, behavior.notifyOnComplete) is
 *    kept here.
 * 2. Provider failover re-submits the failed turn on another provider. The
 *    user asked once, so the user gets one notice, for how it finally ended:
 *    a failover that then succeeds says it finished, a failover whose retry
 *    also fails says it failed, never a failure and then a success.
 *
 * The turn wiring and the stream wiring are linked here the way main.ts links
 * them (onFailoverRetry: continueTurnAfterFailover), on one shared bus, with
 * the turn wiring subscribed first as in main.ts.
 */
import { describe, expect, mock, test } from 'bun:test';
import { wireTurnEventHandlers, type WireTurnEventHandlersOptions } from '../../core/turn-event-wiring.ts';
import { wireStreamEventMetrics, type WireStreamEventMetricsOptions, type StreamMetrics } from '../../core/stream-event-wiring.ts';
import type { WebhookNotifier } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { makeTestSurface } from '../helpers/session-surface.ts';
import { createCancelGeneration } from '../../core/turn-cancellation.ts';
import type { Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';

const ASK = 'Migrate the billing tables to the new schema';

type Bus = { on(type: string, h: (e: unknown) => void): () => void; emit(type: string, e: unknown): void };
function bus(): Bus {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    on(type, h) {
      listeners.set(type, [...(listeners.get(type) ?? []), h]);
      return () => listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== h));
    },
    emit(type, e) { for (const h of (listeners.get(type) ?? []).slice()) h(e); },
  };
}

function metrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0,
    ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    toolArgsByCallId: new Map(),
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface HarnessOptions {
  readonly config?: Record<string, unknown>;
  /** The failover chain; empty means the optimizer is off. */
  readonly chain?: Array<{ providerId: string; modelId: string }>;
  readonly handOff?: () => () => void;
  readonly graceMs?: number;
  readonly synchronousRetry?: boolean;
  readonly retryMissing?: boolean;
  readonly memory?: Promise<void>;
}

function harness(opts: HarnessOptions = {}) {
  const desktop: Array<{ title: string; body: string }> = [];
  const terminal: string[] = [];
  const webhook: Array<Parameters<WebhookNotifier['sendNotification']>[0]> = [];
  const bells: number[] = [];
  const retries: string[] = [];
  let submittedAfterMemory = 0;
  let capturedAuthority: (() => boolean) | undefined;
  let capturedSignal: AbortSignal | undefined;
  const turns = bus(); const tools = bus(); const agents = bus(); const contracts = bus();
  let now = 1_000;
  const tracker = new FocusTracker();
  tracker.setFocused(false);
  // These named-notice routing tests explicitly use the public content-enabled setting.
  const settings: Record<string, unknown> = { 'behavior.notifyAfterSeconds': 30, 'behavior.notificationsMetadataOnly': false, ...opts.config };
  const orchestrator: Record<string, unknown> = { lastInputTokens: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  // This is the SDK state after TURN_ERROR has run finalizeTurn/stopThinking.
  // main.ts passes this exact cancellation action to both Esc and Ctrl+C.
  const abort = mock(() => {});
  const cancelGeneration = createCancelGeneration(
    { isThinking: false, abort } as unknown as Orchestrator,
    { stop: () => false },
    () => streamWiring.cancelPendingRecovery(),
  );
  if (opts.handOff) orchestrator['turnEndNotice'] = { handOff: opts.handOff };
  const turnOptions = {
    events: { turns, tools, agents, contracts },
    conversation: {
      toJSON: () => { throw new Error('stub: no persistence in this test'); },
      getTitleSource: () => 'system',
      title: '',
      getLastUserMessage: () => null,
      getMessageCount: () => 0,
    },
    runtime: { sessionId: 'test-sess-id-001', model: 'm', provider: 'p' },
    orchestrator,
    configManager: { get: (key: string) => settings[key] },
    providerRegistry: {
      getCurrentModel: () => ({ contextWindow: 200_000, id: 'test-model' }),
      getContextWindowForModel: (m: { contextWindow: number }) => m.contextWindow,
    },
    systemMessageRouter: { high: () => {}, low: () => {}, routeSystemMessage: () => {} },
    hookDispatcher: { fire: mock(async () => ({ ok: true })) },
    surface: makeTestSurface('/tmp/notice-owner-workdir', '/tmp/notice-owner-home'),
    gitStatusProvider: { refresh: async () => null },
    lastGitInfoRef: { value: null },
    buildSessionContinuityHints: () => ({}),
    render: () => {},
    webhookNotifier: {
      getUrls: () => ['https://example.invalid/hook'],
      sendNotification: mock(async (delivery: Parameters<WebhookNotifier['sendNotification']>[0]) => { webhook.push(delivery); }),
    } as unknown as WebhookNotifier,
    focusTracker: tracker,
    terminalNotifier: { notify: (_signal: string, message: string) => { terminal.push(message); } },
    notifyDesktop: (title: string, body: string) => { desktop.push({ title, body }); },
    ringBell: () => { bells.push(now); },
    _failoverRetryGraceMs: opts.graceMs ?? 5_000,
    _clock: () => now,
  } as unknown as WireTurnEventHandlersOptions;
  const turnWiring = wireTurnEventHandlers(turnOptions) as ReturnType<typeof wireTurnEventHandlers> & {
    continueTurnAfterFailover?: () => void;
  };

  let currentKey = 'anthropic:claude-sonnet';
  const chain = opts.chain ?? [];
  const streamOptions = {
    events: { turns, tools },
    orchestrator: { streamingOutputTokens: 0 },
    providerRegistry: {
      getCurrentModel: () => ({ provider: currentKey.split(':')[0]!, registryKey: currentKey }),
      setCurrentModel: (key: string) => { currentKey = key; },
    },
    systemMessageRouter: { high: () => {}, low: () => {}, userReceipt: () => {} },
    render: () => {},
    metrics: metrics(),
    providerOptimizer: chain.length > 0 ? {
      enabled: true,
      testFallback: () => ({ chain: chain.map((node, position) => ({ position, capable: true, ...node })) }),
      recordFallbackTransition: () => {},
      fallbackLog: [],
    } : undefined,
    // As in main.ts: a pre-submission snapshot exists, so the turn is re-submitted.
    retryTurn: (notice?: string, isCurrent?: () => boolean, signal?: AbortSignal) => {
      if (opts.retryMissing) return false;
      retries.push(notice ?? '');
      capturedAuthority = isCurrent;
      capturedSignal = signal;
      if (opts.memory) void opts.memory.then(() => {
        if (!isCurrent?.()) return;
        submittedAfterMemory++;
        turns.emit('TURN_SUBMITTED', { turnId: 'late-retry', prompt: ASK });
      });
      if (opts.synchronousRetry) turns.emit('TURN_SUBMITTED', { turnId: 'sync-retry', prompt: ASK });
      return true;
    },
    onFailoverRetry: turnWiring.continueTurnAfterFailover,
    beginFailoverNotice: turnWiring.beginFailoverNotice,
  } as unknown as WireStreamEventMetricsOptions;
  const streamWiring = wireStreamEventMetrics(streamOptions);

  return {
    desktop, terminal, webhook, bells, retries, turnWiring, streamWiring, cancelGeneration, abort,
    submittedAfterMemory: () => submittedAfterMemory, authority: () => capturedAuthority?.(), signal: () => capturedSignal,
    close: () => { for (const unsub of [...streamWiring.unsubs, ...turnWiring.unsubs]) unsub(); },
    advance: (ms: number) => { now += ms; },
    turn: (type: string, payload: Record<string, unknown>) => turns.emit(type, { type, ...payload }),
  };
}


describe('one desktop popup per turn: the TUI owns it, the Orchestrator hands its own off', () => {
  test('the wiring hands the Orchestrator popup off, and its unsubscribe gives it back', () => {
    let released = 0;
    const handOff = mock(() => () => { released += 1; });
    const h = harness({ handOff });
    expect(handOff).toHaveBeenCalledTimes(1);
    for (const unsub of h.turnWiring.unsubs) unsub();
    expect(released).toBe(1);
  });

  test('a turn under the popup threshold still rings the bell above 5s, as the Orchestrator popup did', async () => {
    const h = harness();
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(12_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(1);
  });

  test('behavior.notifyOnComplete off keeps the desktop popup and the bell off, as it did for the Orchestrator popup', async () => {
    const h = harness({ config: { 'behavior.notifyOnComplete': false } });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(45_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(0);
    // The webhook is the long-task path's own channel, governed by notifyAfterSeconds.
    expect(h.webhook).toHaveLength(1);
  });
});

describe('the one popup comes past 30s, as the Orchestrator popup it replaced did, whatever notifyAfterSeconds says', () => {
  // behavior.notifyAfterSeconds unset: its default (60) applies.
  const defaults = { 'behavior.notifyAfterSeconds': undefined };

  test('a 35s turn with the default threshold pops exactly once, naming the work; the webhook waits for the threshold', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(`${h.desktop[0]!.title} ${h.desktop[0]!.body}`).toContain('Migrate the billing tables');
    expect(h.webhook).toHaveLength(0);
    expect(h.bells).toHaveLength(0); // the popup rings the bell itself
  });

  test('a 75s turn with the default threshold: one popup and the webhook', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(75_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(h.webhook).toHaveLength(1);
  });

  test('notifyAfterSeconds 0 turns the webhook off; a 35s turn still pops once', async () => {
    const h = harness({ config: { 'behavior.notifyAfterSeconds': 0 } });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(1);
    expect(h.webhook).toHaveLength(0);
  });

  test('a 25s turn with the default threshold: no popup, the bell', async () => {
    const h = harness({ config: defaults });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(25_000);
    h.turn('TURN_COMPLETED', { turnId: 't1', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    expect(h.bells).toHaveLength(1);
  });
});

describe('one notice per user turn across a provider failover', () => {
  test('failover then success: one notice, it finished, timed from the user submission', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_COMPLETED', { turnId: 't2', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toEqual([{ title: ASK, body: 'Done in 1m' }]);
    expect(h.terminal).toEqual([`${ASK}: Done in 1m`]);
    expect(h.webhook.map(delivery => delivery.kind === 'turn' ? { ...delivery, facts: { ...delivery.facts } } : delivery)).toEqual([{ kind: 'turn', facts: {
      outcome: 'completed', elapsedMs: 60_000, name: ASK, reason: null,
      sessionId: 'test-sess-id-001', subject: 'turn', toolCalls: 0, filesChanged: 0, agentsStarted: 0, reviewScore: null,
    } }]);
  });

  test('failover whose retry also fails: one failure notice, with the final reason', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_ERROR', { turnId: 't2', error: 'Rate limited by openai', stopReason: 'provider_error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 1m: Rate limited by openai' }]);
    expect(h.terminal).toHaveLength(1);
    expect(h.terminal[0]).toContain('Failed after 1m');
  });

  test('without failover a failed turn is told once, as before', async () => {
    const h = harness();
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 40s: Provider returned HTTP 502' }]);
    expect(h.terminal).toHaveLength(1);
  });

  test('a retry that never starts still gets its failure told, after the grace period', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }], graceMs: 20 });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    expect(h.desktop).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 40s: Provider returned HTTP 502' }]);
    expect(h.terminal).toHaveLength(1);
  });

  test('the next user turn after a finished failover is its own turn', async () => {
    const h = harness({ chain: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }, { providerId: 'openai', modelId: 'gpt-5' }] });
    h.turn('TURN_SUBMITTED', { turnId: 't1', prompt: ASK });
    h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 't1', error: 'Provider returned HTTP 502', stopReason: 'provider_error' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't2', prompt: ASK });
    h.advance(20_000);
    h.turn('TURN_COMPLETED', { turnId: 't2', response: 'ok', stopReason: 'completed' });
    await flush();
    h.turn('TURN_SUBMITTED', { turnId: 't3', prompt: 'Now update the README' });
    h.advance(35_000);
    h.turn('TURN_COMPLETED', { turnId: 't3', response: 'ok', stopReason: 'completed' });
    await flush();
    expect(h.desktop).toEqual([
      { title: ASK, body: 'Done in 1m' },
      { title: 'Now update the README', body: 'Done in 35s' },
    ]);
  });
});


describe('async error reading shares the one-turn notice owner', () => {
  const chain = [{ providerId: 'openai', modelId: 'gpt-5' }];
  function delayedReading() {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { await pending; throw new Error('reader unavailable'); } });
    return { release, restore: () => { release(); installJudgmentPort(previous); } };
  }
  for (const synchronousRetry of [false, true]) {
    test(`a delayed reading with ${synchronousRetry ? 'synchronous' : 'asynchronous'} retry keeps one timed user turn`, async () => {
      const read = delayedReading(); const h = harness({ chain, synchronousRetry });
      try {
        h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
        h.turn('TURN_ERROR', { turnId: 'first', error: 'first provider failed' }); await flush();
        expect(h.desktop).toEqual([]); expect(h.terminal).toEqual([]); expect(h.retries).toEqual([]);
        read.release(); await flush(); expect(h.retries).toHaveLength(1); expect(h.desktop).toEqual([]);
        if (!synchronousRetry) h.turn('TURN_SUBMITTED', { turnId: 'later-retry', prompt: ASK });
        h.advance(20_000);
        h.turn('TURN_COMPLETED', { turnId: synchronousRetry ? 'sync-retry' : 'later-retry', response: 'done', stopReason: 'completed' }); await flush();
        expect(h.desktop).toEqual([{ title: ASK, body: 'Done in 1m' }]); expect(h.terminal).toHaveLength(1);
      } finally { h.close(); read.restore(); }
    });
  }
  test('cancelling while the read is pending emits only cancellation and never retries', async () => {
    const read = delayedReading(); const h = harness({ chain });
    try {
      h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
      h.turn('TURN_ERROR', { turnId: 'first', error: 'first failed' }); await flush();
      h.turn('TURN_CANCEL', { turnId: 'first', reason: 'User cancelled' });
      read.release(); await flush();
      expect(h.retries).toEqual([]); expect(h.desktop).toHaveLength(1); expect(h.desktop[0]?.body).toContain('Cancelled');
    } finally { h.close(); read.restore(); }
  });
  test('a new user submission cancels the old hold and owns its own completion', async () => {
    const read = delayedReading(); const h = harness({ chain });
    try {
      h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
      h.turn('TURN_ERROR', { turnId: 'first', error: 'first failed' }); await flush();
      h.streamWiring.clearFailoverVisited(); h.turn('TURN_SUBMITTED', { turnId: 'new', prompt: 'New work' });
      read.release(); await flush(); h.advance(35_000);
      h.turn('TURN_COMPLETED', { turnId: 'new', response: 'done', stopReason: 'completed' }); await flush();
      expect(h.retries).toEqual([]); expect(h.desktop).toEqual([{ title: 'New work', body: 'Done in 35s' }]);
    } finally { h.close(); read.restore(); }
  });
  test('a retry that cannot be submitted releases its held failure exactly once', async () => {
    const read = delayedReading(); const h = harness({ chain, retryMissing: true });
    try {
      h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
      h.turn('TURN_ERROR', { turnId: 'first', error: 'first failed' }); await flush(); expect(h.desktop).toEqual([]);
      read.release(); await flush(); expect(h.desktop).toEqual([{ title: ASK, body: 'Failed after 40s: first failed' }]);
    } finally { h.close(); read.restore(); }
  });
  test('the turn owner grace deadline revokes a still-pending retry', async () => {
    const read = delayedReading(); const h = harness({ chain, graceMs: 5 });
    try {
      h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
      h.turn('TURN_ERROR', { turnId: 'first', error: 'first failed' }); await new Promise(resolve => setTimeout(resolve, 20));
      expect(h.desktop).toHaveLength(1); read.release(); await flush();
      expect(h.retries).toEqual([]); expect(h.desktop).toHaveLength(1);
    } finally { h.close(); read.restore(); }
  });
});

test('an accepted failover cannot submit after terminal grace while memory preparation was pending', async () => {
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { throw new Error('Synthetic reading unavailable'); } });
  let release!: () => void;
  const memory = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ chain: [{ providerId: 'openai', modelId: 'gpt-5' }], graceMs: 10, memory });
  try {
    h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 'first', error: 'Synthetic provider error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    expect(h.authority()).toBe(true);
    expect(h.submittedAfterMemory()).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.terminal).toHaveLength(1);
    expect(h.desktop).toHaveLength(1);
    expect(h.desktop[0]?.body).toContain('Failed');
    expect(h.signal()?.aborted).toBe(true);
    release(); await flush();
    expect(h.submittedAfterMemory()).toBe(0);
  } finally { release(); h.close(); installJudgmentPort(previous); }
});


test('the real cancel action revokes an accepted failover while memory preparation is pending', async () => {
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { throw new Error('Synthetic reading unavailable'); } });
  let release!: () => void;
  const memory = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ chain: [{ providerId: 'openai', modelId: 'gpt-5' }], graceMs: 5_000, memory });
  try {
    h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 'first', error: 'Synthetic provider error' });
    await flush();
    expect(h.retries).toHaveLength(1);
    expect(h.submittedAfterMemory()).toBe(0);
    h.cancelGeneration();
    expect(h.abort).toHaveBeenCalledTimes(1);
    release(); await flush();
    expect(h.submittedAfterMemory()).toBe(0);
  } finally { release(); h.close(); installJudgmentPort(previous); }
});


test('the real cancel action revokes the pending reading while the SDK is idle', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { await pending; throw new Error('reading unavailable'); } });
  const h = harness({ chain: [{ providerId: 'openai', modelId: 'gpt-5' }] });
  try {
    h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 'first', error: 'provider failed' }); await flush();
    expect(h.retries).toEqual([]); h.cancelGeneration(); expect(h.abort).toHaveBeenCalledTimes(1);
    release(); await flush();
    expect(h.retries).toEqual([]); expect(h.terminal).toHaveLength(1); expect(h.desktop[0]?.body).toContain('Cancelled');
  } finally { release(); h.close(); installJudgmentPort(previous); }
});


test('successful synchronous submission transfers the old hold without aborting the newer turn', async () => {
  const previous = installJudgmentPort({ model: 'jev-1.13.0', async ask() { throw new Error('reading unavailable'); } });
  const h = harness({ chain: [{ providerId: 'openai', modelId: 'gpt-5' }], synchronousRetry: true });
  try {
    h.turn('TURN_SUBMITTED', { turnId: 'first', prompt: ASK }); h.advance(40_000);
    h.turn('TURN_ERROR', { turnId: 'first', error: 'failed' }); await flush();
    expect(h.retries).toHaveLength(1); expect(h.signal()?.aborted).toBe(false);
    expect(h.streamWiring.cancelPendingRecovery()).toBe(false);
    h.turn('TURN_CANCEL', { turnId: 'first', reason: 'stale cancel' });
    expect(h.signal()?.aborted).toBe(false); expect(h.terminal).toEqual([]);
    h.advance(20_000); h.turn('TURN_COMPLETED', { turnId: 'sync-retry', response: 'done', stopReason: 'completed' }); await flush();
    expect(h.signal()?.aborted).toBe(false); expect(h.desktop).toEqual([{ title: ASK, body: 'Done in 1m' }]);
  } finally { h.close(); installJudgmentPort(previous); }
});
