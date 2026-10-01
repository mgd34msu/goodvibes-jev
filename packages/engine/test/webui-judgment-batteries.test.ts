import { describe, expect, test } from 'bun:test';
import {
  JudgmentError, withDecisionLog, type DecisionEntry, type DecisionId, type DecisionLog,
  type DecisionNote, type JudgmentPort, type NewDecisionEntry,
} from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { validateWebuiAnswers, withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';
import { commandRankBattery, daemonRefusalBattery, statusToneBattery, WEBUI_BATTERY_QUESTIONS } from '../sdk/src/platform/judgment-browser/batteries/webui-specs.ts';
import { readCommandRank, readDaemonRefusal, readStatusTone, readStructuredDaemonRefusal } from '../sdk/src/platform/judgment-browser/batteries/webui-readers.ts';
import { REFUSAL_ITEMS, type ResolvedCommandRank, type ResolvedDaemonRefusal, type ResolvedStatus } from '../sdk/src/platform/judgment-browser/batteries/webui-types.ts';

const refusal = (message: string, status = 404): ResolvedDaemonRefusal => ({ methodId: 'sessions.delete', message, status });
const rank = (count = 3): ResolvedCommandRank => ({ query: 'start over', registryVersion: 'catalog-1', candidates: Array.from({ length: count }, (_, index) => ({ title: index === 0 ? 'New Chat' : `Command ${index}`, group: 'Commands' })) });
const readyFalse = { session_not_found: false, session_closed: false, session_active: false, session_not_local: false, method_unknown: false };
function memoryLog() {
  const entries: NewDecisionEntry[] = [];
  const notes: { id: string; note: DecisionNote }[] = [];
  const log: DecisionLog = {
    record(entry) { entries.push(entry); return `decision-${entries.length}` as DecisionId; },
    attach(id, note) { notes.push({ id, note }); },
    get() { return undefined; }, query() { return [] as DecisionEntry[]; },
  };
  return { log, entries, notes };
}
function configured(answer: Parameters<typeof fakePort>[0]) {
  const fake = fakePort(answer);
  const recording = memoryLog();
  return { ...fake, ...recording, port: withDecisionLog(withWebuiAnswerBoundary(fake.port), recording.log) };
}

describe('fixed WebUI batteries', () => {
  test('IDs, versions and complete fixed question maps match the three registrations', () => {
    expect([daemonRefusalBattery, statusToneBattery, commandRankBattery].map(({ name, version }) => [name, version])).toEqual([
      ['webui.errors.daemon-refusal', 1], ['webui.status.badge-tone', 1], ['webui.palette.command-rank', 1],
    ]);
    expect(Object.keys(WEBUI_BATTERY_QUESTIONS[daemonRefusalBattery.name]!)).toEqual([...REFUSAL_ITEMS]);
    expect(Object.keys(WEBUI_BATTERY_QUESTIONS[statusToneBattery.name]!)).toEqual(['badge', 'library_dot']);
    expect(Object.keys(WEBUI_BATTERY_QUESTIONS[commandRankBattery.name]!)).toEqual(['match']);
  });

  test('synthetic calibration fixtures cover negation, missing resources, both vocabularies and nonlexical intent', async () => {
    // Fixture-driven answer replay checks plumbing and coverage, not live accuracy.
    for (const battery of [daemonRefusalBattery, statusToneBattery, commandRankBattery]) {
      const expectations = new Map(battery.fixtures.map((fixture) => [JSON.stringify(fixture.state), fixture.expect]));
      const { port } = fakePort((name, question, state) => {
        const expected = expectations.get(JSON.stringify(state)) as Record<string, string> | undefined;
        return question.type === 'noul' ? noulAnswer(expected?.[name] === 'yes' ? 0.99 : 0.01) : choiceAnswer(question, expected?.[name] ?? '', 0.99);
      });
      const checks = await battery.checkFixtures(withWebuiAnswerBoundary(port));
      expect(checks.length).toBeGreaterThanOrEqual(battery.fixtureCount);
      expect(checks.every((check) => check.correct && check.outcome === 'act')).toBe(true);
    }
    expect(daemonRefusalBattery.fixtures.some((fixture) => fixture.name === 'attachment absent but session exists')).toBe(true);
    expect(statusToneBattery.fixtures.some((fixture) => fixture.name === 'inactive is not active')).toBe(true);
    expect(commandRankBattery.fixtures.some((fixture) => fixture.name === 'start over finds new chat')).toBe(true);
  });
});

describe('daemon refusal reader', () => {
  test('caller-side exact codes override prose without probabilities or decision IDs', () => {
    for (const [code, item] of [['SESSION_NOT_FOUND', 'session_not_found'], ['SESSION_CLOSED', 'session_closed'], ['SESSION_ACTIVE', 'session_active'], ['SESSION_NOT_LOCAL', 'session_not_local'], ['METHOD_NOT_FOUND', 'method_unknown']] as const) {
      const result = readStructuredDaemonRefusal({ ...refusal('Unrelated contradictory explanation'), code });
      expect(result).toEqual({ status: 'ready', basis: 'structured', value: { ...readyFalse, [item]: true } });
      expect(JSON.stringify(result)).not.toContain('probabilit');
      expect(result).not.toHaveProperty('decisionIds');
    }
    expect(readStructuredDaemonRefusal({ ...refusal('Unknown gateway method', 500), code: 'METHOD_NOT_FOUND' })).toEqual({ status: 'ready', basis: 'structured', value: readyFalse });
  });

  test('endpoint reader holds known structural cases without a value, port call or fabricated reading', async () => {
    const fake = configured(() => { throw new Error('must not call'); });
    const known = [
      ...['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'SESSION_ACTIVE', 'SESSION_NOT_LOCAL', 'METHOD_NOT_FOUND', 'NO_ACTIVE_TURN', 'CONFLICT', 'IMAP_AUTH_FAILED', 'SMTP_AUTH_FAILED'].map((code) => ({ ...refusal('Unrelated contradictory explanation'), code })),
      { ...refusal('Unknown gateway method', 500), code: 'METHOD_NOT_FOUND' },
      refusal('session closed', 401), refusal('session closed', 0),
      { ...refusal('session closed'), category: 'network' as const },
    ];
    for (const source of known) {
      expect(await readDaemonRefusal(fake.port, source)).toEqual({ status: 'held', reason: 'unsupported-input' });
      expect(await readDaemonRefusal(undefined, source)).toEqual({ status: 'held', reason: 'unsupported-input' });
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.entries).toHaveLength(0);
    expect(fake.notes).toHaveLength(0);
  });

  test('known auth/network and non-session wire codes remain deterministic', async () => {
    for (const source of [{ ...refusal('session not found'), code: 'CONFLICT' }, { ...refusal('session is active'), code: 'NO_ACTIVE_TURN' }, { ...refusal('session closed'), code: 'IMAP_AUTH_FAILED' }, { ...refusal('session closed'), code: 'SMTP_AUTH_FAILED' }, refusal('session closed', 401), refusal('session closed', 0), { ...refusal('session closed'), category: 'network' as const }]) {
      expect(readStructuredDaemonRefusal(source)).toEqual({ status: 'ready', value: readyFalse, basis: 'structured' });
    }
    expect(readStructuredDaemonRefusal(refusal('Unknown gateway method'))).toBeUndefined();
  });

  test('one request reads five facts; non-404 excludes method_unknown and fixes it false', async () => {
    const fake = configured((name) => noulAnswer(name === 'session_not_local' ? 0.98 : 0.02));
    const source = refusal('This daemon does not host a live runtime for the existing session.');
    expect(readStructuredDaemonRefusal(source)).toBeUndefined();
    const result = await readDaemonRefusal(fake.port, source);
    expect(result).toEqual({ status: 'ready', basis: 'judgment', value: { ...readyFalse, session_not_local: true }, decisionIds: ['decision-1'] });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).toEqual([...REFUSAL_ITEMS]);
    expect(fake.entries).toHaveLength(1);
    expect(fake.entries[0]).toMatchObject({ status: 'answered', context: { battery: 'webui.errors.daemon-refusal', batteryVersion: 1 } });
    expect(fake.notes.find(({ note }) => note.kind === 'readings')?.note).toMatchObject({ kind: 'readings', readings: { session_not_local: { kind: 'yes-no', probability: 0.98, verdict: 'yes', outcome: 'act' } } });
    const other = configured(() => noulAnswer(0.01));
    expect(await readDaemonRefusal(other.port, refusal('Unknown gateway method', 500))).toMatchObject({ status: 'ready', value: readyFalse });
    expect(Object.keys(other.requests[0]!.questions)).not.toContain('method_unknown');
  });

  test('reader follows semantic answers contrary to the old substring rules', async () => {
    const fake = configured(() => noulAnswer(0.01));
    expect(await readDaemonRefusal(fake.port, refusal('The session was found; its attachment was not found.'))).toMatchObject({ status: 'ready', value: readyFalse });
    expect(await readDaemonRefusal(fake.port, refusal('No session is active. Storage unavailable.', 500))).toMatchObject({ status: 'ready', value: readyFalse });
    expect(fake.requests).toHaveLength(2);
  });

  test('confirm and escalate remain distinct, with no executable value', async () => {
    for (const [probability, outcome] of [[0.8, 'confirm'], [0.5, 'escalate']] as const) {
      const fake = configured((name) => noulAnswer(name === 'session_closed' ? probability : 0.01));
      expect(await readDaemonRefusal(fake.port, refusal('Ambiguous current failure'))).toEqual({ status: 'uncertain', reason: 'unsettled', outcome });
    }
    const mixed = configured((name) => noulAnswer(name === 'session_closed' ? 0.8 : name === 'session_active' ? 0.5 : 0.01));
    expect(await readDaemonRefusal(mixed.port, refusal('Mixed evidence'))).toEqual({ status: 'uncertain', reason: 'unsettled', outcome: 'escalate' });
  });

  test('conflicting acted facts escalate, but locality alone is not a missing session', async () => {
    for (const yes of [['session_not_found', 'session_not_local'], ['session_closed', 'session_active'], ['method_unknown', 'session_not_found']]) {
      const fake = configured((name) => noulAnswer(yes.includes(name) ? 0.99 : 0.01));
      expect(await readDaemonRefusal(fake.port, refusal('Contradictory evidence'))).toEqual({ status: 'uncertain', reason: 'conflicting-evidence', outcome: 'escalate' });
    }
  });
});

describe('status tone reader', () => {
  test('known tones are deterministic and the two vocabularies remain separate', async () => {
    expect(await readStatusTone(undefined, { kind: 'structured', vocabulary: 'library-dot', tone: 'info' })).toEqual({ status: 'ready', basis: 'structured', value: { vocabulary: 'library-dot', tone: 'info' } });
    const fake = configured((name, question) => choiceAnswer(question, name === 'badge' ? 'neutral' : 'idle', 0.9));
    for (const vocabulary of ['badge', 'library-dot'] as const) {
      expect(await readStatusTone(fake.port, { kind: 'text', vocabulary, status: 'inactive', domain: 'session' })).toMatchObject({ status: 'ready', value: { vocabulary, tone: vocabulary === 'badge' ? 'neutral' : 'idle' } });
    }
    expect(fake.requests.map((request) => Object.keys(request.questions))).toEqual([['badge'], ['library_dot']]);
  });

  test('low-confidence choice never leaks the selected tone into a non-ready result', async () => {
    for (const [confidence, outcome] of [[0.57, 'confirm'], [0.4, 'escalate']] as const) {
      const fake = configured((_name, question) => ({ type: 'choice', choice: 'warning', confidence, probabilities: { warning: confidence, ok: (1 - confidence) / 3, bad: (1 - confidence) / 3, neutral: (1 - confidence) / 3 } }));
      expect(await readStatusTone(fake.port, { kind: 'text', vocabulary: 'badge', domain: 'candidate', status: 'possibly ready, maybe stale' })).toEqual({ status: 'uncertain', reason: 'unsettled', outcome });
    }
  });

  test('unknown vocabularies, structured enum values and domains hold before asking', async () => {
    const fake = configured(() => { throw new Error('must not call'); });
    for (const input of [
      { kind: 'text', vocabulary: 'unknown', status: 'ready', domain: 'session' },
      { kind: 'structured', vocabulary: 'badge', tone: 'info' },
      { kind: 'text', vocabulary: 'badge', status: 'ready', domain: 'browser instructions' },
    ]) expect(await readStatusTone(fake.port, input as ResolvedStatus)).toEqual({ status: 'held', reason: 'unsupported-input' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('palette ranking', () => {
  test('all candidates are represented once with real probabilities and stable ties', async () => {
    const probabilities = [0.92, 0.01, 0.99, 0.92];
    const fake = configured((_name, _question, state) => noulAnswer(probabilities[state && typeof state === 'object' && 'candidate' in state && (state.candidate as { title: string }).title === 'New Chat' ? 0 : Number((state as { candidate: { title: string } }).candidate.title.split(' ')[1])]!));
    expect(await readCommandRank(fake.port, rank(4))).toEqual({ status: 'ready', basis: 'judgment', decisionIds: ['decision-1', 'decision-2', 'decision-3', 'decision-4'], value: { registryVersion: 'catalog-1', accepted: [{ candidateIndex: 2, probability: 0.99 }, { candidateIndex: 0, probability: 0.92 }, { candidateIndex: 3, probability: 0.92 }], rejected: [1] } });
    expect(fake.requests).toHaveLength(4);
    expect(fake.requests.every((request) => Object.keys(request.questions).join() === 'match')).toBe(true);
    const logged = JSON.stringify({ entries: fake.entries, notes: fake.notes });
    expect(logged).not.toContain('start over');
    expect(logged).not.toContain('New Chat');
    expect(logged).toContain('candidateIndex');
  });

  test('one uncertain candidate holds the entire ranking and preserves confirm/escalate', async () => {
    for (const [p, outcome] of [[0.57, 'confirm'], [0.5, 'escalate']] as const) {
      const fake = configured((_name, _question, state) => noulAnswer((state as { candidate: { title: string } }).candidate.title === 'New Chat' ? p : 0.9));
      expect(await readCommandRank(fake.port, rank())).toEqual({ status: 'uncertain', reason: 'unsettled', outcome });
      expect(fake.requests).toHaveLength(3);
    }
  });

  test('full 64 candidate set is read with at most four requests in flight', async () => {
    const base = fakePort(() => noulAnswer(0.01));
    let active = 0;
    let peak = 0;
    const delayed: JudgmentPort = { model: base.port.model, async ask(request) {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      try { return await base.port.ask(request); } finally { active--; }
    } };
    const result = await readCommandRank(withWebuiAnswerBoundary(delayed), rank(64));
    expect(peak).toBe(4);
    expect(base.requests).toHaveLength(64);
    expect(result).toMatchObject({ status: 'ready', value: { accepted: [], rejected: Array.from({ length: 64 }, (_, index) => index) } });
  });

  test('cancellation stops new scheduling and discards late in-flight answers', async () => {
    const controller = new AbortController();
    const base = fakePort(() => noulAnswer(0.99));
    const releases: (() => void)[] = [];
    let launched = 0;
    const slow: JudgmentPort = { model: base.port.model, async ask(request) {
      launched++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return base.port.ask(request);
    } };
    const pending = readCommandRank(withWebuiAnswerBoundary(slow), rank(12), { signal: controller.signal });
    await Promise.resolve();
    expect(launched).toBe(4);
    controller.abort();
    releases.forEach((release) => release());
    expect(await pending).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(launched).toBe(4);
  });

  test('unavailable port, malformed output and empty query never manufacture ranking weights', async () => {
    expect(await readCommandRank(undefined, rank())).toEqual({ status: 'unavailable', reason: 'unconfigured' });
    expect(await readCommandRank(undefined, { ...rank(), query: '  ' })).toEqual({ status: 'held', reason: 'unsupported-input' });
    const bad = configured(() => ({ type: 'noul', noul: Number.NaN }));
    expect(await readCommandRank(bad.port, rank())).toEqual({ status: 'unavailable', reason: 'invalid-response' });
  });
});

describe('source preflight and retention boundary', () => {
  test('credential/card material past every proposed clip and beyond candidate cap never reaches a port or log', async () => {
    const fake = configured(() => noulAnswer(0.99));
    expect(await readDaemonRefusal(fake.port, refusal('x'.repeat(5000) + ' apiKey=synthetic-secret'))).toEqual({ status: 'held', reason: 'unsafe-input' });
    expect(await readStatusTone(fake.port, { kind: 'text', vocabulary: 'badge', domain: 'session', status: 'x'.repeat(300) + ' password=synthetic-secret' })).toEqual({ status: 'held', reason: 'unsafe-input' });
    expect(await readCommandRank(fake.port, { ...rank(), query: 'x'.repeat(300) + ' cardNumber=4111111111111111' })).toEqual({ status: 'held', reason: 'unsafe-input' });
    expect(await readCommandRank(fake.port, { ...rank(65), candidates: [...rank(64).candidates, { title: 'apiKey=synthetic-secret' }] })).toEqual({ status: 'held', reason: 'unsafe-input' });
    expect(fake.requests).toHaveLength(0);
    expect(fake.entries).toHaveLength(0);
  });

  test('unclipped source bounds, unknown fields and accessors hold without invoking hooks', async () => {
    const fake = configured(() => noulAnswer(0.99));
    expect(await readCommandRank(fake.port, rank(65))).toEqual({ status: 'held', reason: 'budget' });
    expect(await readDaemonRefusal(fake.port, refusal('é'.repeat(2100)))).toEqual({ status: 'held', reason: 'budget' });
    expect(await readCommandRank(fake.port, { ...rank(), candidates: [{ title: 'New Chat', sessionId: 'private-session-id' }] } as unknown as ResolvedCommandRank)).toEqual({ status: 'held', reason: 'unsupported-input' });
    let calls = 0;
    const input = { ...refusal(''), get message() { calls++; return 'secret'; } };
    expect(await readDaemonRefusal(fake.port, input)).toEqual({ status: 'held', reason: 'unsupported-input' });
    expect(calls).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  test('strict answer validation rejects extra fields/answers and contradictory distributions', () => {
    const questions = { match: commandRankBattery.items.match.question };
    for (const answers of [null, {}, { match: null }, { match: noulAnswer(-0.1) }, { match: noulAnswer(Infinity) }, { match: { ...noulAnswer(0.9), explanation: 'echoed private input' } }, { match: noulAnswer(0.9), extra: noulAnswer(0.9) }]) {
      expect(() => validateWebuiAnswers(questions, answers)).toThrow('Invalid WebUI judgment response.');
    }
    const choices = { badge: statusToneBattery.items.badge.question };
    const valid = choiceAnswer(choices.badge, 'ok', 0.9);
    for (const answer of [{ ...valid, confidence: 0.8 }, { ...valid, choice: 'other' }, { ...valid, probabilities: { ...valid.probabilities, neutral: 0.5 } }, { ...valid, probabilities: { ok: 0.9 } }, { ...valid, probabilities: { ...valid.probabilities, other: 0 } }]) {
      expect(() => validateWebuiAnswers(choices, { badge: answer })).toThrow('Invalid WebUI judgment response.');
    }
    expect(validateWebuiAnswers(choices, { badge: valid })).toMatchObject({ badge: valid });
  });

  test('raw output extensions and failure echoes are scrubbed before decision logging', async () => {
    const echo = 'private-query-echo';
    const extra = configured(() => ({ ...noulAnswer(0.9), explanation: echo }));
    expect(await readCommandRank(extra.port, rank(1))).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    expect(JSON.stringify(extra.entries)).not.toContain(echo);
    expect(extra.entries[0]!.status).toBe('failed');
    const base: JudgmentPort = { model: 'jev-1.13.0', async ask() { throw new JudgmentError('unavailable', echo, { requestId: echo }); } };
    const recording = memoryLog();
    const logged = withDecisionLog(withWebuiAnswerBoundary(base), recording.log);
    expect(await readCommandRank(logged, rank(1))).toEqual({ status: 'unavailable', reason: 'offline' });
    expect(JSON.stringify(recording.entries)).not.toContain(echo);
    expect(() => withWebuiAnswerBoundary(logged)).toThrow('must precede decision logging');
  });

  test('lineage array hooks are rejected without executing accessors, map, iterators or species', async () => {
    const base = fakePort(() => noulAnswer(0.99));
    let hooks = 0;
    const makeAttempt = () => ({ attempt: 1, endpointIndex: 0, endpointKind: 'local', requestedModel: base.port.model, latencyMs: 1, outcome: 'answered' });
    const mapArray = [makeAttempt()];
    Object.defineProperty(mapArray, 'map', { get() { hooks++; return Array.prototype.map; } });
    const indexArray = [makeAttempt()];
    Object.defineProperty(indexArray, '0', { get() { hooks++; return makeAttempt(); } });
    const speciesArray = [makeAttempt()];
    Object.defineProperty(speciesArray, 'constructor', { value: { get [Symbol.species]() { hooks++; return Array; } } });
    const iteratorArray = [makeAttempt()];
    Object.defineProperty(iteratorArray, Symbol.iterator, { get() { hooks++; return Array.prototype[Symbol.iterator]; } });
    for (const attempts of [mapArray, indexArray, speciesArray, iteratorArray]) {
      const hostile: JudgmentPort = { model: base.port.model, async ask(request) {
        const result = await base.port.ask(request);
        return { ...result, lineage: { logicalRequestId: '00000000-0000-0000-0000-000000000001', attempts } } as typeof result;
      } };
      expect(await readCommandRank(withWebuiAnswerBoundary(hostile), rank(1))).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    }
    expect(hooks).toBe(0);
  });

  test('a server-approved alias keeps actual model provenance and strips provider IDs', async () => {
    const base = fakePort(() => noulAnswer(0.99));
    const aliasPort: JudgmentPort = { model: 'approved-alias', async ask(request) {
      const result = await base.port.ask(request);
      return { ...result, requestedModel: 'approved-alias', model: 'jev-1.13.0', requestId: 'private-query-echo', lineage: {
        logicalRequestId: '00000000-0000-0000-0000-000000000001', attempts: [{ attempt: 1, endpointIndex: 0, endpointKind: 'local', requestedModel: 'approved-alias', latencyMs: 1, outcome: 'answered', requestId: 'private-query-echo' }],
      } };
    } };
    expect(await readCommandRank(withWebuiAnswerBoundary(aliasPort), rank(1))).toEqual({ status: 'unavailable', reason: 'invalid-response' });
    const recording = memoryLog();
    const approved = withDecisionLog(withWebuiAnswerBoundary(aliasPort, { returnedModels: { 'approved-alias': ['jev-1.13.0'] } }), recording.log);
    expect(await readCommandRank(approved, rank(1))).toMatchObject({ status: 'ready' });
    expect(recording.entries[0]).toMatchObject({ requestedModel: 'approved-alias', model: 'jev-1.13.0' });
    expect(JSON.stringify(recording.entries)).not.toContain('private-query-echo');
    expect(recording.entries[0]!.lineage?.attempts).toHaveLength(1);
  });

  test('pre-aborted calls do no work; preflight snapshots prevent post-launch input mutation', async () => {
    const fake = configured(() => noulAnswer(0.01));
    const controller = new AbortController();
    controller.abort();
    expect(await readCommandRank(fake.port, rank(), { signal: controller.signal })).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(fake.requests).toHaveLength(0);
    const mutable = { query: 'start over', registryVersion: 'catalog-1', candidates: Array.from({ length: 8 }, () => ({ title: 'New Chat' })) };
    const snapshot = fakePort((_name, _question, state) => {
      mutable.candidates[7]!.title = 'apiKey=should-not-enter-state';
      return noulAnswer((state as { candidate: { title: string } }).candidate.title === 'New Chat' ? 0.99 : 0.01);
    });
    expect(await readCommandRank(withWebuiAnswerBoundary(snapshot.port), mutable)).toMatchObject({ status: 'ready', value: { rejected: [] } });
    expect(snapshot.requests.every((request) => (request.state as { candidate: { title: string } }).candidate.title === 'New Chat')).toBe(true);
  });
});
