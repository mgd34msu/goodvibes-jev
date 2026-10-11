import { afterEach, describe, expect, test } from 'bun:test';
import { createDaemonTelemetryRouteHandlers } from '../daemon-sdk/src/telemetry-routes.js';
import type { AuthenticatedPrincipal } from '../daemon-sdk/src/http-policy.js';
import { DaemonErrorCategory } from '../errors/src/daemon-error-contract.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { emitTurnError, emitTurnSubmitted } from '../sdk/src/platform/runtime/emitters/turn.js';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.js';
import { TelemetryApiService, TelemetryRawViewDisabledError } from '../sdk/src/platform/runtime/telemetry/api.js';
import { sanitizeRecord, sanitizeSpan } from '../sdk/src/platform/runtime/telemetry/api-helpers.js';
import { setTelemetryIncludeRawPrompts } from '../sdk/src/platform/runtime/telemetry/redaction-config.js';

const prompt = 'PRIVATE_PROMPT_OPT_IN_SENTINEL';
const failure = 'PRIVATE_FAILURE_OPT_IN_SENTINEL';
const spanName = 'PRIVATE_SPAN_OPT_IN_SENTINEL';
const services: TelemetryApiService[] = [];
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const principal = (scopes: readonly string[], admin = false): AuthenticatedPrincipal => ({
  principalId: 'telemetry-test', principalKind: 'token', scopes, admin,
});
const sensitive = principal(['read:telemetry', 'read:telemetry-sensitive']);
const admin = principal(['read:telemetry'], true);

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  setTelemetryIncludeRawPrompts(false);
});

function createFixture(enabled = false) {
  let optedIn = enabled;
  const bus = new RuntimeEventBus();
  const service = new TelemetryApiService({
    runtimeBus: bus, runtimeStore: createRuntimeStore(), includeRawPrompts: () => optedIn,
  });
  services.push(service);
  const submit = (text = prompt): void => emitTurnSubmitted(bus, {
    sessionId: 'telemetry-session', traceId: '0123456789abcdef0123456789abcdef', source: 'test',
  }, { turnId: 'telemetry-turn', prompt: text });
  const handlers = (identity: AuthenticatedPrincipal | null = sensitive) => createDaemonTelemetryRouteHandlers({
    telemetryApi: service, ingestSink: service, resolveAuthenticatedPrincipal: () => identity,
  });
  return { bus, service, submit, handlers, setEnabled: (value: boolean): void => { optedIn = value; } };
}

async function populate(fixture: ReturnType<typeof createFixture>): Promise<void> {
  fixture.submit();
  emitTurnError(fixture.bus, {
    sessionId: 'telemetry-session', traceId: '0123456789abcdef0123456789abcdef', source: 'test',
  }, {
    turnId: 'telemetry-turn', error: failure, stopReason: 'provider_error',
  });
  fixture.service.ingestTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ name: spanName }] }] }] });
  await flush();
}

const rawMethods = [
  'getTelemetrySnapshot', 'getTelemetryEvents', 'getTelemetryErrors', 'getTelemetryTraces',
  'getTelemetryMetrics', 'createTelemetryEventStream', 'getTelemetryOtlpLogs', 'getTelemetryOtlpTraces',
] as const;
const request = (query = 'view=raw'): Request => new Request(`http://localhost/api/v1/telemetry?${query}`);

describe('telemetry opt-in at the actual egress boundary', () => {
  test('default-off rejects every raw service projection and reports unavailable raw access', async () => {
    const fixture = createFixture();
    await populate(fixture);
    const reads = [
      () => fixture.service.getSnapshot({ view: 'raw' }),
      () => fixture.service.listEvents({ view: 'raw' }),
      () => fixture.service.listErrors({}, 'raw'),
      () => fixture.service.listSpans({ view: 'raw' }),
      () => fixture.service.listEventPage({ view: 'raw' }),
      () => fixture.service.listErrorPage({ view: 'raw' }),
      () => fixture.service.listSpanPage({ view: 'raw' }),
      () => fixture.service.createStream(request(), { view: 'raw' }),
      () => fixture.service.buildOtlpLogDocument({ view: 'raw' }),
      () => fixture.service.buildOtlpTraceDocument({}, 'raw'),
    ];
    for (const read of reads) expect(read).toThrow(TelemetryRawViewDisabledError);
    expect(fixture.service.getSnapshot({}, 'safe', true).rawAccessible).toBe(false);
    const safeViews = [
      fixture.service.getSnapshot(), fixture.service.listEvents(), fixture.service.listErrors(),
      fixture.service.listSpans(), fixture.service.buildOtlpLogDocument(), fixture.service.buildOtlpTraceDocument(),
    ];
    for (const projection of safeViews) {
      const serialized = JSON.stringify(projection);
      for (const content of [prompt, failure, spanName]) expect(serialized).not.toContain(content);
    }
  });

  test('HTTP requires both the current opt-in and actual sensitive authorization', async () => {
    const fixture = createFixture();
    for (const identity of [sensitive, admin]) {
      const handlers = fixture.handlers(identity);
      for (const name of rawMethods) {
        const response = await handlers[name](request('view=raw&cursor=invalid'));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'TELEMETRY_RAW_DISABLED', category: DaemonErrorCategory.AUTHORIZATION });
      }
    }
    fixture.setEnabled(true);
    for (const name of rawMethods) {
      const missing = await fixture.handlers(principal(['read:telemetry']))[name](request());
      expect(missing.status).toBe(403);
      expect(await missing.json()).toMatchObject({ code: 'MISSING_SCOPE' });
      expect((await fixture.handlers(null)[name](request())).status).toBe(401);
      expect((await fixture.handlers(principal(['read:telemetry-sensitive']))[name](request())).status).toBe(403);
    }
    await populate(fixture);
    const response = await fixture.handlers().getTelemetryEvents(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(prompt);
    const safe = await fixture.handlers().getTelemetryEvents(request('view=safe'));
    expect(await safe.text()).not.toContain(prompt);
    fixture.setEnabled(false);
    const revoked = await fixture.handlers().getTelemetryEvents(request());
    expect(revoked.status).toBe(403);
    expect(await revoked.text()).not.toContain(prompt);
  });

  test('bootstrap reporting and a different daemon opt-in cannot grant raw service access', () => {
    const enabled = createFixture(true);
    const disabled = createFixture();
    setTelemetryIncludeRawPrompts(true);
    const defaultService = new TelemetryApiService({ runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
    services.push(defaultService);
    expect(enabled.service.isRawEnabled()).toBe(true);
    expect(disabled.service.isRawEnabled()).toBe(false);
    expect(defaultService.isRawEnabled()).toBe(false);
    expect(() => defaultService.listEvents({ view: 'raw' })).toThrow(TelemetryRawViewDisabledError);
  });

  test('raw SSE terminates on live opt-in revocation before another event is emitted', async () => {
    const fixture = createFixture(true);
    const response = fixture.service.createStream(request(), { view: 'raw' });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"view":"raw"');
    fixture.submit();
    await flush();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(prompt);
    fixture.setEnabled(false);
    const pending = reader.read().then(
      () => ({ kind: 'data' } as const),
      (error: unknown) => ({ kind: 'error', error } as const),
    );
    fixture.submit('AFTER_REVOCATION_PRIVATE_PROMPT');
    await flush();
    const settled = await pending;
    expect(settled.kind).toBe('error');
    if (settled.kind === 'error') expect(settled.error).toBeInstanceOf(TelemetryRawViewDisabledError);
    reader.releaseLock();
  }, 3_000);

  test('default safe SSE preserves the safe label and redacts live prompt text', async () => {
    const fixture = createFixture();
    const response = fixture.service.createStream(request('view=safe'));
    const reader = response.body!.getReader();
    const ready = new TextDecoder().decode((await reader.read()).value);
    expect(ready).toContain('"view":"safe"');
    expect(ready).toContain('"rawAccessible":false');
    fixture.submit();
    await flush();
    expect(new TextDecoder().decode((await reader.read()).value)).not.toContain(prompt);
    await reader.cancel();
  });

  test('normalized error text and span status text are redacted without losing structural fields', async () => {
    const fixture = createFixture(true);
    await populate(fixture);
    const record = fixture.service.listErrors({}, 'raw')[0]!;
    expect(record.error).toBeDefined();
    const rawRecord = { ...record, message: failure, error: {
      ...record.error!, message: failure, summary: failure, hint: failure,
    } };
    const safeRecord = sanitizeRecord(rawRecord, 'safe');
    expect(JSON.stringify(safeRecord)).not.toContain(failure);
    expect(safeRecord.error?.category).toBe(rawRecord.error.category);
    expect(safeRecord.error?.recoverable).toBe(rawRecord.error.recoverable);
    expect(sanitizeRecord(rawRecord, 'raw').error?.summary).toBe(failure);
    const rawSpan = { ...fixture.service.listSpans({}, 'raw')[0]!, status: {
      ...fixture.service.listSpans({}, 'raw')[0]!.status, message: failure,
    } };
    const safeSpan = sanitizeSpan(rawSpan, 'safe');
    expect(JSON.stringify(safeSpan)).not.toContain(failure);
    expect(safeSpan.status.code).toBe(rawSpan.status.code);
    expect(sanitizeSpan(rawSpan, 'raw').status.message).toBe(failure);
  });
});
