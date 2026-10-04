import { expect, test } from 'bun:test';
import { createSystemOnePort, JudgmentError, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  decideNativeIntake, NATIVE_INTAKE_COVERAGE_SITE, NATIVE_INTAKE_DECISION_SITE, NATIVE_INTAKE_ROUTE_SITE,
  readNativeIntakeRoute, validateNativeRequirementProposal, type NativeIntakeReadInput,
} from '../sdk/src/platform/workflow/work-ledger/native-intake-decisions.js';

const binding = { sourceId: 'source', inputRevision: 'source-1', actionId: 'intake', actionRevision: 'routing-1', authorityId: 'owner', authorityRevision: 'authority-1', scopeId: 'project', scopeRevision: 'scope-1' };
const text = 'Add JSON export.';
const proposal = { sourceRevision: 'source-1', spans: [{ partId: 'input' as const, start: 0, end: text.length }] };
const requirements = () => validateNativeRequirementProposal(text, 'source-1', proposal);
const repair = { ref: { id: 'repair', revision: 'repair-1', kind: 'revise-action' as const }, description: 'Propose new ranges from the unchanged complete source.', input: { operation: 'propose-ranges' } };
function input(port: JudgmentPort, log: SqliteDecisionLog): NativeIntakeReadInput { return { text, sourceRevision: 'source-1', port, decisionLog: log, binding, assertCurrent() {} }; }
function answers(options: { route?: 'converse' | 'answer' | 'contract'; routeConfidence?: number; fidelity?: 'supports' | 'contradicts' | 'says_nothing'; missing?: number; final?: string } = {}) {
  return fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, options.route ?? 'contract', options.routeConfidence ?? 0.99);
    if (name === 'relation') return choiceAnswer(question, options.fidelity ?? 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(options.missing ?? 0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, options.final ?? 'act', 0.99);
  });
}

test('range materialization preserves exact Unicode, whitespace, duplicate occurrences and uncovered positions', () => {
  const source = ' 🌻 Keep logs. Keep logs.\n';
  const first = source.indexOf('Keep logs.'), second = source.lastIndexOf('Keep logs.');
  const raw = { sourceRevision: 'v1', spans: [{ partId: 'input', start: first, end: first + 10 }, { partId: 'input', start: second, end: second + 10 }] };
  const value = validateNativeRequirementProposal(source, 'v1', raw);
  expect(value.criteria).toEqual(['Keep logs.', 'Keep logs.']);
  expect(value.uncovered.map(range => range.text)).toEqual([' 🌻 ', ' ', '\n']);
  expect(value.uncovered.every(range => source.slice(range.start, range.end) === range.text)).toBe(true);
  raw.spans[0]!.start = 0;
  expect(value.proposal.spans[0]!.start).toBe(first);
  expect(Object.isFrozen(value.criteria)).toBe(true);
  const one = validateNativeRequirementProposal(source, 'v1', { sourceRevision: 'v1', spans: [{ partId: 'input', start: first, end: first + 10 }] });
  expect(one.uncovered.at(-1)?.text).toBe(' Keep logs.\n');
});

test('range validator refuses stale, malformed, generated, overlapping and surrogate-splitting proposals', () => {
  const bad: unknown[] = [
    { ...proposal, sourceRevision: 'old' }, { ...proposal, criteria: ['fabricated'] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: 3, text: 'Add' }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 3, end: 6 }, { partId: 'input', start: 0, end: 3 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: 5 }, { partId: 'input', start: 4, end: 8 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'attachment', start: 0, end: 3 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: -1, end: 3 }] },
    { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0.5, end: 3 }] },
    { sourceRevision: 'source-1', spans: new Array(1) }, new Proxy(proposal, {}),
  ];
  let getterCalls = 0;
  bad.push({ get sourceRevision() { getterCalls++; return 'source-1'; }, spans: [] });
  for (const value of bad) expect(() => validateNativeRequirementProposal(text, 'source-1', value)).toThrow();
  expect(getterCalls).toBe(0);
  expect(() => validateNativeRequirementProposal('🌻 task', 'v1', { sourceRevision: 'v1', spans: [{ partId: 'input', start: 1, end: 7 }] })).toThrow();
});

test('work admission records route, per-range fidelity, exact completeness, final disposition and claim', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  expect(fake.requests).toHaveLength(1);
  const result = await decideNativeIntake({ ...read, binding: { ...binding, actionRevision: 'proposal-1' }, routeEvidence, requirements: requirements(), allowAct: true, continuations: [repair], conditions: [] });
  expect(result).toMatchObject({ route: 'work', requirementsSettled: true, problems: [], autonomous: { decision: { outcome: 'act', binding: { actionRevision: 'proposal-1' } } } });
  expect(result.decisionIds).toHaveLength(4);
  for (const id of result.decisionIds) expect(log.get(id)?.status).toBe('answered');
  expect(fake.requests.map(request => request.context?.site)).toEqual([NATIVE_INTAKE_ROUTE_SITE, 'work-ledger.native-intake.requirement', NATIVE_INTAKE_COVERAGE_SITE, NATIVE_INTAKE_DECISION_SITE]);
  expect(fake.requests.every(request => JSON.stringify(request.state).includes(text))).toBe(true);
  expect(JSON.stringify(fake.requests.at(-1)!.state)).not.toContain('"probabilities"');
  expect(log.get(routeEvidence.decisionId)).toMatchObject({ answers: { route: { probabilities: expect.any(Object) } } });
  result.autonomous.recordClaim();
  for (const id of result.decisionIds) expect(log.get(id)).toMatchObject({ notes: expect.arrayContaining([{ kind: 'action', action: `autonomous:claim:${result.autonomous.decision.decisionId}` }]) });
});

test.each(['converse', 'answer'] as const)('%s is routed before extraction but still needs fresh autonomous act', async route => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route }); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: true, continuations: [], conditions: [] });
  expect(result).toMatchObject({ route: 'turn', requirementsSettled: true, autonomous: { decision: { outcome: 'act' } } });
  expect(fake.requests).toHaveLength(2); expect(result.decisionIds).toHaveLength(2);
});

test.each(['uncertain-route', 'empty-work', 'bad-fidelity', 'incomplete', 'host-block'] as const)('%s removes act and selects only a registered repair', async kind => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = answers({ routeConfidence: kind === 'uncertain-route' ? 0.6 : 0.99, fidelity: kind === 'bad-fidelity' ? 'contradicts' : 'supports', missing: kind === 'incomplete' ? 0.25 : 0.01, final: 'revise_0' });
  const read = input(withDecisionLog(fake.port, log), log); const routeEvidence = await readNativeIntakeRoute(read);
  const captured = kind === 'empty-work' ? validateNativeRequirementProposal(text, 'source-1', { sourceRevision: 'source-1', spans: [] }) : requirements();
  const result = await decideNativeIntake({ ...read, routeEvidence, requirements: captured, allowAct: kind !== 'host-block', continuations: [repair], conditions: [] });
  expect(result.autonomous.decision).toMatchObject({ outcome: 'revise', next: repair.ref });
  expect(result.problems.length).toBeGreaterThan(0);
  const question = fake.requests.at(-1)!.questions.disposition!;
  expect(question.type === 'choice' && Object.hasOwn(question.criteria, 'act')).toBe(false);
  if (kind === 'uncertain-route') expect(result.route).toBeUndefined();
});

test('missing source context prevents ordinary turn and retains every source marker in recorded reads', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route: 'converse', final: 'revise_0' });
  const read = { ...input(withDecisionLog(fake.port, log), log), sourceIssues: [{ kind: 'file', label: 'Referenced specification' }] };
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [repair], conditions: [] });
  expect(result.autonomous.decision.outcome).toBe('revise');
  expect(fake.requests.every(request => JSON.stringify(request.state).includes('Referenced specification'))).toBe(true);
  await expect(decideNativeIntake({ ...read, sourceIssues: [], routeEvidence, allowAct: true, continuations: [], conditions: [] })).rejects.toMatchObject({ kind: 'invalid-request' });
});

test('a selected first duplicate leaves the actual second occurrence in completeness evidence', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ missing: 0.99, final: 'revise_0' });
  const read = { ...input(withDecisionLog(fake.port, log), log), text: 'Keep logs. Keep logs.' };
  const routeEvidence = await readNativeIntakeRoute(read);
  const captured = validateNativeRequirementProposal(read.text, 'source-1', { sourceRevision: 'source-1', spans: [{ partId: 'input', start: 0, end: 10 }] });
  const result = await decideNativeIntake({ ...read, routeEvidence, requirements: captured, allowAct: true, continuations: [repair], conditions: [] });
  expect(result.coverage?.parts).toMatchObject([{ kind: 'selected', range: { start: 0, end: 10 } }, { kind: 'uncovered', range: { start: 10, end: 21, text: ' Keep logs.' } }]);
  expect(result.requirementsSettled).toBe(false);
});

test('unsupported act without alternatives is a recorded refusal, never an invented receipt', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route: 'answer' }); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [], conditions: [] });
  expect(result.autonomous.decision.outcome).toBe('reject');
  expect(fake.requests.at(-1)?.questions.refuse?.type).toBe('noul');
  expect(() => result.autonomous.recordClaim()).toThrow('only an act');
});

test('forged route and changed source or authority cannot reuse real route evidence', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const base = { ...read, routeEvidence, requirements: requirements(), allowAct: true, continuations: [], conditions: [] };
  for (const altered of [{ ...base, routeEvidence: { ...routeEvidence } }, { ...base, text: `${text} Another task.` }, { ...base, binding: { ...binding, authorityRevision: 'revoked' } }]) {
    await expect(decideNativeIntake(altered)).rejects.toMatchObject({ kind: 'invalid-request' });
  }
  expect(fake.requests).toHaveLength(1);
});

test('missing recorder or mismatched log lineage fails closed', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers();
  await expect(readNativeIntakeRoute(input(fake.port, log))).rejects.toMatchObject({ kind: 'unrecorded' });
  expect(fake.requests).toHaveLength(0);
  const read = { ...input(withDecisionLog(fake.port, log), log), decisionLog: { get() { return undefined; } } };
  await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'unrecorded' });
});

test('binding input revision must identify the captured source before any reading', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  await expect(readNativeIntakeRoute({ ...read, binding: { ...binding, inputRevision: 'unrelated' } })).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(fake.requests).toHaveLength(0);
});

test('projecting machine readings never weakens the complete-source privacy boundary', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  await expect(readNativeIntakeRoute({ ...read, text: 'Use card 4111111111111111 for this task.' })).rejects.toMatchObject({ problem: 'card-material' });
  expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
});

test('revocation during an abort-ignoring answer prevents interpretation and later claim', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); let current = true;
  const borrowed: JudgmentPort = { ...fake.port, async ask(request) { const result = await fake.port.ask(request); current = false; return result; } };
  const read = { ...input(withDecisionLog(borrowed, log), log), assertCurrent() { if (!current) throw new JudgmentError('aborted', 'revoked'); } };
  await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'aborted' });
  expect(log.query()).toMatchObject([{ status: 'answered', notes: [] }]);
});

test('live currentness remains enforced after a successful disposition', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route: 'answer' }); let current = true;
  const read = { ...input(withDecisionLog(fake.port, log), log), assertCurrent() { if (!current) throw new JudgmentError('aborted', 'revoked'); } };
  const routeEvidence = await readNativeIntakeRoute(read);
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: true, continuations: [], conditions: [] });
  current = false;
  expect(() => result.autonomous.assertCurrent()).toThrow(); expect(() => result.autonomous.recordClaim()).toThrow();
});

test('malformed proposal cannot manufacture a full-root criterion or ask semantic verification', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers(); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const malformed = { proposal: { sourceRevision: 'stale', spans: [] }, criteria: [text], uncovered: [] };
  await expect(decideNativeIntake({ ...read, routeEvidence, requirements: malformed, allowAct: true, continuations: [repair], conditions: [] })).rejects.toMatchObject({ kind: 'invalid-request' });
  expect(fake.requests).toHaveLength(1);
  const empty = { proposal: { sourceRevision: 'source-1', spans: [] }, criteria: [text], uncovered: [] };
  const result = await decideNativeIntake({ ...read, routeEvidence, requirements: empty, allowAct: true, continuations: [], conditions: [] });
  expect(result.requirements?.criteria).toEqual([]);
  expect(result.autonomous.decision.outcome).toBe('reject');
});

test('registered external condition produces a bound defer without acting or waiting inside the reader', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = answers({ route: 'answer', final: 'defer_0' }); const read = input(withDecisionLog(fake.port, log), log);
  const routeEvidence = await readNativeIntakeRoute(read);
  const condition = { ref: { id: 'evidence-ready', revision: 'pending-1' }, description: 'The registered evidence source changes.' };
  const result = await decideNativeIntake({ ...read, routeEvidence, allowAct: false, continuations: [], conditions: [condition] });
  expect(result.autonomous.decision).toMatchObject({ outcome: 'defer', until: condition.ref });
  expect(() => result.autonomous.recordClaim()).toThrow('only an act');
});

test.each(['recover', 'revoke', 'abort'] as const)('shared transport retry retains native lifetime: %s', async behavior => {
  using log = new SqliteDecisionLog(':memory:'); const controller = new AbortController();
  let attempts = 0, progress = 0, current = true;
  const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: PINNED_MODEL,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, timeoutMs: 1_000,
    fetch: async (_url, init) => {
      if (++attempts === 1) return new Response('', { status: 503 });
      const wire = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
      return Response.json({ model: PINNED_MODEL, answers: { route: choiceAnswer(wire.questions.route!, 'answer', 0.99) }, usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  const read = { ...input(withDecisionLog(transport, log), log), signal: controller.signal,
    assertCurrent() { if (!current) throw new JudgmentError('aborted', 'revoked'); },
    onRetry() { progress++; if (behavior === 'revoke') current = false; if (behavior === 'abort') controller.abort(); },
  };
  if (behavior === 'recover') {
    const result = await readNativeIntakeRoute(read);
    expect(result.settled).toBe(true); expect(attempts).toBe(2);
    expect(log.get(result.decisionId)?.lineage?.attempts).toHaveLength(2);
  } else {
    await expect(readNativeIntakeRoute(read)).rejects.toMatchObject({ kind: 'aborted' });
    expect(attempts).toBe(1); expect(log.query()).toMatchObject([{ status: 'failed' }]);
  }
  expect(progress).toBe(1);
});
