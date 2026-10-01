import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, noul, readYesNo, STAKES_BANDS, readingsOf, type JudgmentPort, type YesNoReading } from '@goodvibes-jev/judgment';
import { BROWSER_JUDGMENT_PATH, createBrowserJudgmentHttpHandler, type AuthenticatedPrincipal } from '../daemon-sdk/src/index.ts';
import { BrowserJudgmentRegistry, BrowserJudgmentReferences, BrowserJudgmentService, type BrowserJudgmentProjection } from '../sdk/src/platform/judgment-browser/index.ts';
import { validateBrowserJudgmentProjection } from '../sdk/src/platform/judgment-browser/projection.ts';

const ID = 'webui.errors.daemon-refusal' as const;
const names = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'] as const;
const questions = Object.fromEntries(names.map((name) => [name, noul(`Read ${name}.`)]));
const principal: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
const basis = { method_unknown: 'http-status-not-404' } as const;

function fixture(options: { status?: unknown; omitMethod?: boolean; structuralBasis?: unknown; held?: boolean;
  compoundOutcome?: unknown; probabilities?: Partial<Record<typeof names[number], number>>; valueMethod?: boolean } = {}) {
  const log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const port = withDecisionLog({ model: 'jev-1.13.0', async ask(request) {
    calls++;
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined,
      answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name,
        { type: 'noul', noul: options.probabilities?.[name as typeof names[number]] ?? 0.01 }])) as never };
  } } satisfies JudgmentPort, log);
  const registry = new BrowserJudgmentRegistry();
  registry.register({ id: ID, version: 1, questions, maxCalls: 1,
    resolve: async () => ({ state: { message: 'fixture error', ...(options.status === undefined ? {} : { status: options.status }) },
      sourceBinding: 'fixture-source', assertCurrent() {} }),
    run: async (active, state, { signal }) => {
      const asked = Object.fromEntries(Object.entries(questions).filter(([name]) => !options.omitMethod || name !== 'method_unknown'));
      const result = await active.ask({ state: state as never, questions: asked, signal });
      const readings = Object.fromEntries(Object.entries(result.answers).map(([name, answer]) =>
        [name, readYesNo(answer as never, STAKES_BANDS.medium.yesNo)])) as Record<string, YesNoReading>;
      active.recorder?.recordReadings(result.decisionId!, Object.fromEntries(Object.entries(readings).map(([name, reading]) => [name, { ...reading }])));
      return readings;
    },
    project: (readings) => ({
      ...(options.held ? { status: 'held', reason: 'uncertain' } : { status: 'settled', value: {
        ...Object.fromEntries(names.map((name) => [name, readings[name]?.verdict === 'yes'])),
        ...(options.valueMethod === undefined ? {} : { method_unknown: options.valueMethod }),
      } }),
      readings,
      ...(Object.hasOwn(options, 'structuralBasis') ? { structuralBasis: options.structuralBasis } : {}),
      ...(Object.hasOwn(options, 'compoundOutcome') ? { compoundOutcome: options.compoundOutcome } : {}),
    }) as BrowserJudgmentProjection<never>,
  });
  const service = new BrowserJudgmentService({ registry, references: new BrowserJudgmentReferences(),
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port, assertCurrent() {} }), authorize: () => true });
  const handler = createBrowserJudgmentHttpHandler({ authenticate: () => principal, sameOrigins: () => ['https://daemon.fixture.invalid'],
    cors: () => ({ enabled: false, allowedOrigins: [] }), service });
  return { log, service, calls: () => calls, send: (extraInput: object = {}) => handler(new Request(`https://daemon.fixture.invalid${BROWSER_JUDGMENT_PATH}`, {
    method: 'POST', headers: { origin: 'https://daemon.fixture.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: ID, batteryVersion: 1, input: { errorRef: 'fixture', ...extraInput } }),
  })) };
}

describe('server-bound structural omission', () => {
  test('structural error facts cannot be attached to another battery', () => {
    const request = { protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.status.badge-tone', batteryVersion: 1,
      input: { vocabulary: 'badge', source: { kind: 'catalog', labelId: 'fixture' } } } as const;
    expect(() => validateBrowserJudgmentProjection(request, { status: 'held', reason: 'uncertain', structuralBasis: basis,
      readings: { badge: { kind: 'choice', choice: 'ok', confidence: 0.42,
        probabilities: { ok: 0.61, warning: 0.35, bad: 0.04, neutral: 0 }, outcome: 'escalate' } } }, { status: 500 })).toThrow();
  });

  test('non404 yields four genuine readings and an explicit structural false', async () => {
    const f = fixture({ status: 500, omitMethod: true, structuralBasis: basis });
    try {
      const response = await f.send();
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'settled', structuralBasis: basis, value: { method_unknown: false }, outcome: 'act' });
      expect(Object.keys(body.readings as object)).toEqual(names.slice(0, -1));
      expect(f.calls()).toBe(1);
      const [entry] = f.log.query({ status: 'answered' });
      expect(entry).toBeDefined();
      expect(Object.keys(readingsOf(entry!)!)).toEqual(names.slice(0, -1));
      expect(body.evidence).toHaveLength(1);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test.each([undefined, null, 0, 99, 404, 600, 200.5, '500'])('cannot justify omission with invalid, missing or404 server status %s', async (status) => {
    const f = fixture({ status, omitMethod: true, structuralBasis: basis });
    try {
      const response = await f.send();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ status: 'held', error: { code: 'JUDGMENT_INVALID_RESPONSE' } });
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test.each([
    { status: 500, omitMethod: true },
    { status: 500, omitMethod: true, structuralBasis: { method_unknown: 'synthetic-private' } },
    { status: 500, omitMethod: true, structuralBasis: { ...basis, private_state: 'synthetic-private' } },
    { status: 500, omitMethod: true, structuralBasis: basis, valueMethod: true },
  ])('requires the exact explicit basis and a false value', async (options) => {
    const f = fixture(options);
    try { expect((await f.send()).status).toBe(502); }
    finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('structural omission also preserves a genuine held reading without a value', async () => {
    const f = fixture({ status: 500, omitMethod: true, structuralBasis: basis, held: true,
      probabilities: { session_active: 0.5 } });
    try {
      const response = await f.send();
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'held', structuralBasis: basis, outcome: 'escalate' });
      expect(Object.keys(body.readings as object)).toEqual(names.slice(0, -1));
      expect(Object.hasOwn(body, 'value')).toBe(false);
      const [entry] = f.log.query({ status: 'answered' });
      expect(Object.keys(readingsOf(entry!)!)).toEqual(names.slice(0, -1));
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('suppressing a genuine method yes requires the server structural basis', async () => {
    for (const explicit of [false, true]) {
      const f = fixture({ status: 500, probabilities: { method_unknown: 0.99 }, valueMethod: false,
        ...(explicit ? { structuralBasis: basis } : {}) });
      try {
        const response = await f.send();
        expect(response.status).toBe(explicit ? 200 : 502);
        if (explicit) expect(await response.json()).toMatchObject({ structuralBasis: basis,
          value: { method_unknown: false }, readings: { method_unknown: { verdict: 'yes', probability: 0.99 } } });
      } finally { await f.service.close(); f.log[Symbol.dispose](); }
    }
  });

  test('the browser cannot supply the server status or structural basis', async () => {
    const f = fixture({ status: 404, omitMethod: true, structuralBasis: basis });
    try {
      const response = await f.send({ status: 500, structuralBasis: basis });
      expect(response.status).toBe(400);
      expect(f.calls()).toBe(0);
      expect(f.log.query()).toHaveLength(0);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
});

describe('compound uncertainty cannot lower genuine outcomes', () => {
  test.each(['confirm', 'escalate'] as const)('an all-act conflict holds at explicit %s without a value or invented reading', async (compoundOutcome) => {
    const f = fixture({ status: 404, held: true, compoundOutcome, probabilities: { session_closed: 0.99, session_active: 0.99 } });
    try {
      const response = await f.send();
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe('held'); expect(body.outcome).toBe(compoundOutcome);
      expect(Object.hasOwn(body, 'value')).toBe(false);
      expect(Object.hasOwn(body, 'compoundOutcome')).toBe(false);
      expect(Object.values(body.readings as Record<string, { outcome: string }>).every((reading) => reading.outcome === 'act')).toBe(true);
      expect(f.log.query({ status: 'answered' })).toHaveLength(1);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('an escalate item cannot be lowered by a confirm compound floor', async () => {
    const f = fixture({ status: 404, held: true, compoundOutcome: 'confirm', probabilities: { session_active: 0.5 } });
    try { expect(await (await f.send()).json()).toMatchObject({ status: 'held', outcome: 'escalate' }); }
    finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test.each([
    { status: 404, held: true },
    { status: 404, held: true, compoundOutcome: 'act' },
    { status: 404, compoundOutcome: 'escalate' },
    { status: 404, held: true, compoundOutcome: 'synthetic-private' },
  ])('rejects an unsupported compound claim or a held all-act result without a floor', async (options) => {
    const f = fixture(options);
    try { expect((await f.send()).status).toBe(502); }
    finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
});
