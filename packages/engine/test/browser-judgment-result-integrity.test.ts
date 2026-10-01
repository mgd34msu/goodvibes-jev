import { describe, expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, noul, readYesNo, STAKES_BANDS, type JudgmentPort, type YesNoReading } from '@goodvibes-jev/judgment';
import { BROWSER_JUDGMENT_PATH, createBrowserJudgmentHttpHandler, type AuthenticatedPrincipal } from '../daemon-sdk/src/index.ts';
import { BrowserJudgmentRegistry, BrowserJudgmentReferences, BrowserJudgmentService } from '../sdk/src/platform/judgment-browser/index.ts';

const ID = 'webui.palette.command-rank' as const;
const questions = { match: noul('Does the command match the query?') };
const principal: AuthenticatedPrincipal = { principalId: 'fixture-owner', principalKind: 'user', admin: true, scopes: ['write:judgment'] };
type Projection = 'valid' | 'swapped' | 'accepted-no' | 'rejected-yes';

/** Actual service, HTTP handler and recorder; only provider/authentication are synthetic. */
function fixture(projection: Projection) {
  const log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const inner: JudgmentPort = { model: 'jev-1.13.0', async ask(request) {
    calls++;
    const index = (request.state as { candidateIndex: number }).candidateIndex;
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0',
      answers: { match: { type: 'noul', noul: index === 0 ? 0.01 : 0.99 } } as never,
      usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, requestId: undefined };
  } };
  const port = withDecisionLog(inner, log);
  const registry = new BrowserJudgmentRegistry();
  registry.register({ id: ID, version: 1, questions, maxCalls: 2,
    resolve: async () => ({ state: { query: 'fixture' }, sourceBinding: 'fixture-source', assertCurrent() {} }),
    run: async (active, state, { signal }) => {
      const readings: Record<string, YesNoReading> = {};
      for (let candidateIndex = 0; candidateIndex < 2; candidateIndex++) {
        const result = await active.ask({ state: { ...state, candidateIndex }, questions, signal });
        const reading = readYesNo(result.answers.match, STAKES_BANDS.medium.yesNo);
        readings[`candidate_${candidateIndex}`] = reading;
        active.recorder?.recordReadings(result.decisionId!, { [`candidate_${candidateIndex}`]: { ...reading } });
      }
      return readings;
    },
    project: (readings) => ({ status: 'settled', readings, value: { registryVersion: 'v1',
      accepted: projection === 'rejected-yes' ? [] : projection === 'swapped' ? [{ candidateIndex: 0, probability: 0.01 }]
        : projection === 'accepted-no' ? [{ candidateIndex: 1, probability: 0.99 }, { candidateIndex: 0, probability: 0.01 }]
          : [{ candidateIndex: 1, probability: 0.99 }],
      rejected: projection === 'rejected-yes' ? [0, 1] : projection === 'accepted-no' ? [] : projection === 'swapped' ? [1] : [0],
    } }),
  });
  const service = new BrowserJudgmentService({ registry, references: new BrowserJudgmentReferences(),
    currentRoute: () => ({ revision: 'fixture-route', kind: 'local', port, assertCurrent() {} }), authorize: () => true });
  const handler = createBrowserJudgmentHttpHandler({ authenticate: () => principal, sameOrigins: () => ['https://daemon.fixture.invalid'],
    cors: () => ({ enabled: false, allowedOrigins: [] }), service });
  return { log, service, calls: () => calls, send: () => handler(new Request(`https://daemon.fixture.invalid${BROWSER_JUDGMENT_PATH}`, {
    method: 'POST', headers: { origin: 'https://daemon.fixture.invalid', 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, requestId: crypto.randomUUID(), battery: ID, batteryVersion: 1,
      input: { query: { kind: 'inline', text: 'fixture' }, registryVersion: 'v1',
        candidates: [{ kind: 'builtin', commandId: 'a' }, { kind: 'builtin', commandId: 'b' }] } }),
  })) };
}

describe('recorded palette result integrity', () => {
  test.each(['swapped', 'accepted-no', 'rejected-yes'] as const)('refuses %s despite genuine recorded act readings', async (projection) => {
    const f = fixture(projection);
    try {
      const response = await f.send();
      expect(response.status).toBe(502);
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'held', error: { code: 'JUDGMENT_INVALID_RESPONSE' } });
      expect(Object.hasOwn(body, 'value')).toBe(false);
      expect(f.calls()).toBe(2);
      expect(f.log.query({ status: 'answered' })).toHaveLength(2);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });

  test('accepts the exact recorded yes/no partition without adding a threshold', async () => {
    const f = fixture('valid');
    try {
      const response = await f.send();
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe('settled');
      expect(body.outcome).toBe('act');
      expect(body.value).toEqual({ registryVersion: 'v1', accepted: [{ candidateIndex: 1, probability: 0.99 }], rejected: [0] });
      expect(body.evidence).toHaveLength(2);
      expect(f.log.query({ status: 'answered' })).toHaveLength(2);
    } finally { await f.service.close(); f.log[Symbol.dispose](); }
  });
});
