import { afterEach, describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { TelemetryApiService } from '@/runtime/index.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { redactSensitiveDataAsync, redactionCredential } from '@goodvibes-jev/engine/sdk/platform/utils';
import { isDeepStrictEqual } from 'node:util';


// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('TelemetryApiService', () => {
  let service: TelemetryApiService | null = null;
  let previousPort: ReturnType<typeof installJudgmentPort>;

  afterEach(async () => {
    service?.dispose();
    service = null;
    installJudgmentPort(previousPort);
  });

  test('captures canonical telemetry, normalized errors, synthesized spans, and OTLP views', async () => {
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();

    runtimeStore.setState((state) => ({
      ...state,
      session: {
        ...state.session,
        id: 'session-telemetry',
        status: 'active',
        startedAt: 1_000,
      },
      telemetry: {
        ...state.telemetry,
        sessionCorrelationId: 'corr-session',
        currentTurnCorrelationId: 'corr-turn',
        dbAvailable: true,
      },
    }));

    let includeRawPrompts = false;
    const telemetry = new TelemetryApiService({
      includeRawPrompts: () => includeRawPrompts,
      runtimeBus,
      runtimeStore,
      eventLimit: 20,
      errorLimit: 10,
      spanLimit: 10,
    });

    service = telemetry;
    const publicText = ['provider socket hang up', 'ECONNREFUSED connecting to collector'];
    const publicQuestions = Object.fromEntries(Object.entries(redactionCredential.items).map(([name, item]) => [name, item.question]));
    const fake = fakePort((name, question, state) => {
      if ((name === 'lineHasCredential' || name === 'spanIsCredential') && isDeepStrictEqual(question, publicQuestions[name])
        && publicText.some(text => isDeepStrictEqual(state, {
          phase: 'source', target: 'whole-line', parts: [{ kind: 'text', text }],
        }))) return noulAnswer(0.01);
      throw new Error(`Unexpected telemetry diagnostic question: ${name}`);
    });
    previousPort = installJudgmentPort(fake.port);
    for (const text of publicText) expect(await redactSensitiveDataAsync(text)).toBe(text);

    runtimeBus.emit('turn', createEventEnvelope('TURN_SUBMITTED', {
      type: 'TURN_SUBMITTED',
      turnId: 'turn-1',
      prompt: 'hello',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
      turnId: 'turn-1',
    }));

    runtimeBus.emit('turn', createEventEnvelope('TURN_ERROR', {
      type: 'TURN_ERROR',
      turnId: 'turn-1',
      error: 'provider socket hang up',
      stopReason: 'provider_error',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
      turnId: 'turn-1',
    }));

    runtimeBus.emit('transport', createEventEnvelope('TRANSPORT_TERMINAL_FAILURE', {
      type: 'TRANSPORT_TERMINAL_FAILURE',
      transportId: 'daemon',
      error: 'ECONNREFUSED connecting to collector',
    }, {
      sessionId: 'session-telemetry',
      source: 'test-suite',
      traceId: '123e4567-e89b-12d3-a456-426614174000',
    }));

    await flushMicrotasks();
    const snapshot = telemetry.getSnapshot({ limit: 5 });
    expect(snapshot.capabilities.signals.events).toBe(true);
    expect(snapshot.runtime.sessionId).toBe('session-telemetry');
    expect(snapshot.view).toBe('safe');
    expect(snapshot.recent.events.items).toHaveLength(3);
    expect(snapshot.aggregates.totalEvents).toBe(3);
    expect(snapshot.aggregates.totalErrors).toBeGreaterThanOrEqual(2);
    const submitted = snapshot.recent.events.items.find((record) => record.type === 'TURN_SUBMITTED');
    expect((submitted?.payload as { prompt?: string } | undefined)?.prompt).toBe('[REDACTED]');
    expect(JSON.stringify(snapshot.recent.events.items)).not.toContain('hello');

    const errors = telemetry.listErrors({ limit: 5 });
    expect(errors).toHaveLength(2);
    const transportError = errors.find((record) => record.type === 'TRANSPORT_TERMINAL_FAILURE');
    expect(transportError?.error?.source).toBe('transport');
    // Event errors are plain text. ECONNREFUSED in prose is not a structured
    // errno, so synchronous normalization must not invent a network category.
    expect(transportError?.error?.category).toBe('unknown');
    expect(() => telemetry.listErrors({ limit: 5, view: 'raw' })).toThrow('Raw telemetry is disabled');
    includeRawPrompts = true;
    expect(telemetry.listErrors({ limit: 5, view: 'raw' })
      .find((record) => record.type === 'TRANSPORT_TERMINAL_FAILURE')?.error?.message)
      .toBe('ECONNREFUSED connecting to collector');

    const spans = telemetry.listSpans({ limit: 5 });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('[REDACTED]');
    expect(telemetry.listSpans({ limit: 5, view: 'raw' })[0]?.name).toBe('turn.lifecycle');
    expect(spans[0]?.status.code).toBe(2);

    const otlpTraces = telemetry.buildOtlpTraceDocument({ limit: 5 }) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    expect(otlpTraces.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe('[REDACTED]');
    const rawOtlpTraces = telemetry.buildOtlpTraceDocument({ limit: 5, view: 'raw' }) as typeof otlpTraces;
    expect(rawOtlpTraces.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.name).toBe('turn.lifecycle');

    const otlpLogs = telemetry.buildOtlpLogDocument({ limit: 5 }) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ severityText: string }> }> }>;
    };
    expect(otlpLogs.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(3);
    expect(otlpLogs.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.severityText).toBe('ERROR');

    const otlpMetrics = telemetry.buildOtlpMetricDocument() as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }>;
    };
    expect(otlpMetrics.resourceMetrics[0]?.scopeMetrics[0]?.metrics.map((metric) => metric.name))
      .toContain('goodvibes.telemetry.events.total');

    const rawEvents = telemetry.listEvents({ limit: 5, view: 'raw' });
    const rawSubmitted = rawEvents.find((record) => record.type === 'TURN_SUBMITTED');
    expect((rawSubmitted?.payload as { prompt?: string } | undefined)?.prompt).toBe('hello');

    const firstPage = telemetry.listEventPage({ limit: 1 });
    expect(firstPage.pageInfo.hasMore).toBe(true);
    expect(firstPage.pageInfo.nextCursor).toBe(telemetry.listEventPage({ limit: 2 }).items[1]?.id);
    const secondPage = telemetry.listEventPage({ limit: 1, cursor: firstPage.pageInfo.nextCursor });
    expect(secondPage.items).toHaveLength(1);

    includeRawPrompts = false;
    expect(() => telemetry.listEvents({ view: 'raw' })).toThrow('Raw telemetry is disabled');
    expect(() => telemetry.listErrors({ view: 'raw' })).toThrow('Raw telemetry is disabled');
    expect(() => telemetry.listSpans({ view: 'raw' })).toThrow('Raw telemetry is disabled');
  });
});
