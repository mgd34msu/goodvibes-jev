import { expect, test } from 'bun:test';
import { createSystemOnePort, JudgmentError, noul, PINNED_MODEL, SqliteDecisionLog, withDecisionLog, type JsonValue, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { decideAutonomous, type AutonomousDecisionInput } from '../sdk/src/platform/gate/autonomous-decision.js';
import { decideAutonomousTool } from '../sdk/src/platform/permissions/autonomous.js';
const binding = { sourceId: 'source', inputRevision: 'input-1', actionId: 'action', actionRevision: 'action-1', authorityId: 'actor', authorityRevision: 'authority-1', scopeId: 'project', scopeRevision: 'scope-1' };
function input(port: AutonomousDecisionInput['port']): AutonomousDecisionInput {
  return { port, site: 'test.native-operation', instructions: 'Choose the bound native operation.', actionDescription: 'Carry out the exact offered operation', binding,
    state: { goal: 'Full original goal', criteria: ['First requirement', 'Second requirement'] }, evidence: [{ id: 'evidence', revision: 'evidence-1' }],
    continuations: [{ ref: { id: 'repair', revision: 'repair-1', kind: 'revise-action' }, description: 'Prepare the registered repair', input: { operation: 'repair-plan' } }],
    conditions: [], allowAct: true, assertCurrent: () => {} };
}

test('shared evaluator selects a bound native continuation with actual recorded provenance and no fake tool', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = fakePort((_name, question) => choiceAnswer(question, 'revise_0', 0.99));
  const result = await decideAutonomous(input(withDecisionLog(fake.port, log)));
  expect(result.decision).toMatchObject({ outcome: 'revise', next: { id: 'repair', revision: 'repair-1', kind: 'revise-action' } });
  expect(result.decision.judgmentDecisionIds).toHaveLength(1); expect(log.query().map(entry => String(entry.id))).toContain(result.decision.judgmentDecisionIds[0]!);
  expect(fake.requests[0]!.context).toEqual({ battery: 'engine.gate.autonomous-disposition', batteryVersion: 1, pattern: 'dispatch', site: 'test.native-operation' }); expect(JSON.stringify(fake.requests[0]!.state)).not.toContain('toolName');
  expect(() => result.recordClaim()).toThrow('only an act');
});

test('real tool adapter retains its detached registered tool revision over the same evaluator', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = fakePort((_name, question) => choiceAnswer(question, 'revise_0', 0.99));
  const revision = { ref: { id: 'read-alternative', revision: 'revision-1', kind: 'revise-action' as const }, toolName: 'read', args: { file: 'README.md' } };
  const pending = decideAutonomousTool({ port: withDecisionLog(fake.port, log), binding, state: { toolName: 'read', args: { file: 'src/index.ts' } }, evidence: [{ id: 'input', revision: 'input-1' }], choices: { revisions: [revision] }, allowAct: true, assertCurrent: () => {} });
  revision.args.file = 'later-caller-mutation'; const result = await pending;
  expect(result.revision?.args).toEqual({ file: 'README.md' }); expect(result.decision.outcome).toBe('revise');
  expect(fake.requests[0]!.context).toEqual({ battery: 'engine.gate.autonomous-disposition', batteryVersion: 1, pattern: 'dispatch', site: 'engine.gate.autonomous-tool' });
});

test('unrecorded semantic input fails before any reading rather than manufacturing lineage', async () => {
  const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  await expect(decideAutonomous(input(fake.port))).rejects.toMatchObject({ kind: 'unrecorded' }); expect(fake.requests).toHaveLength(0);
});

test('weak act with no continuation uses one recorded refusal reading, never a singleton choice or invented rejection', async () => {
  using log = new SqliteDecisionLog(':memory:'); const names: string[] = [];
  const fake = fakePort((name, question) => { names.push(name); return name === 'refuse' ? noulAnswer(0.99) : choiceAnswer(question, 'act', 0.7); });
  const result = await decideAutonomous({ ...input(withDecisionLog(fake.port, log)), continuations: [] });
  expect(names).toEqual(['disposition', 'refuse']);
  expect(fake.requests.map(request => request.context)).toEqual([
    { battery: 'engine.gate.autonomous-disposition', batteryVersion: 1, pattern: 'dispatch', site: 'test.native-operation' },
    { battery: 'engine.gate.autonomous-refusal', batteryVersion: 1, pattern: 'dispatch', site: 'test.native-operation' },
  ]); expect(result.decision.outcome).toBe('reject'); expect(result.decision.judgmentDecisionIds).toHaveLength(2);
});

test('an unsettled sole refusal is an operational failure with no synthesized semantic receipt', async () => {
  using log = new SqliteDecisionLog(':memory:'); const fake = fakePort(() => noulAnswer(0.5));
  await expect(decideAutonomous({ ...input(withDecisionLog(fake.port, log)), allowAct: false, continuations: [] })).rejects.toMatchObject({ kind: 'invalid-response' });
  expect(fake.requests).toHaveLength(1); expect(log.query()).toHaveLength(1);
});


test('weak act retains the host catalog and resolves once using only the offered non-executing choices', async () => {
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const fake = fakePort((_name, question) => choiceAnswer(question, ++calls === 1 ? 'act' : 'defer_1', calls === 1 ? 0.7 : 0.99));
  const conditions = [{ ref: { id: 'worker', revision: 'busy' }, description: 'Worker becomes idle' }, { ref: { id: 'evidence', revision: 'pending' }, description: 'Required evidence arrives' }];
  const candidate = input(withDecisionLog(fake.port, log));
  const result = await decideAutonomous({ ...candidate, conditions });
  expect(result.decision).toMatchObject({ outcome: 'defer', until: conditions[1]!.ref });
  expect(result.decision.judgmentDecisionIds).toHaveLength(2);
  const questions = fake.requests.map(request => request.questions.disposition!);
  expect(questions[0]).toMatchObject({ type: 'choice', instructions: candidate.instructions, criteria: { act: candidate.actionDescription, revise_0: candidate.continuations[0]!.description } });
  expect(Object.keys(questions[1]!.type === 'choice' ? questions[1]!.criteria : {})).toEqual(['reject', 'revise_0', 'defer_0', 'defer_1']);
  expect<unknown>(fake.requests[0]!.state).toEqual({ input: candidate.state, binding, evidence: candidate.evidence, offeredChoices: { continuations: candidate.continuations, resumeConditions: conditions } });
  expect(fake.requests[1]!.state).toEqual({ ...fake.requests[0]!.state as object, uncertainty: 'The prior act candidate did not reach the high-stakes band. Select a legal non-executing outcome.' });
  expect(fake.requests.map(request => request.context?.battery)).toEqual(['engine.gate.autonomous-disposition', 'engine.gate.autonomous-disposition']);
});

test.each(['disposition', 'refusal'] as const)('%s preserves supporting IDs, reading notes and action attribution', async kind => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => name === 'disposition' ? choiceAnswer(question, 'act', 0.99) : noulAnswer(0.99));
  const recorded = withDecisionLog(fake.port, log);
  const support = await recorded.ask({ state: 'supporting evidence', questions: { support: noul('Is the evidence current?') } });
  const notes: { id: string; readings?: JsonValue; action?: string }[] = [];
  const port = { ...recorded, recorder: {
    recordReadings(id: string, readings: JsonValue) { notes.push({ id, readings }); recorded.recorder!.recordReadings(id, readings); },
    recordAction(id: string, action: string) { notes.push({ id, action }); recorded.recorder!.recordAction(id, action); },
  } };
  const result = await decideAutonomous({ ...input(port), allowAct: kind === 'disposition', continuations: [], supportingDecisionIds: [support.decisionId!] });
  const ids = result.decision.judgmentDecisionIds;
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(support.decisionId);
  expect(result.context.judgmentDecisionIds).toEqual(ids);
  expect(log.get(ids[1]!)?.context).toEqual({ battery: `engine.gate.autonomous-${kind}`, batteryVersion: 1, pattern: 'dispatch', site: 'test.native-operation' });
  expect<unknown>(notes).toEqual([
    { id: ids[1]!, readings: kind === 'disposition' ? { choice: 'act', confidence: 0.99, bandOutcome: 'act' } : { refusal: 'yes', probability: 0.99, bandOutcome: 'act' } },
    ...ids.flatMap(id => [{ id, readings: { autonomousDecision: result.decision } }, { id, action: `autonomous:${result.decision.outcome}:${result.decision.decisionId}` }]),
  ]);
  if (kind === 'disposition') {
    result.recordClaim();
    expect(notes.slice(-2)).toEqual(ids.map(id => ({ id, action: `autonomous:claim:${result.decision.decisionId}` })));
  }
});

test.each(['disposition', 'refusal'] as const)('%s rechecks authority after the answer before reading or recording a conclusion', async kind => {
  using log = new SqliteDecisionLog(':memory:');
  let current = true;
  const fake = fakePort((name, question) => name === 'disposition' ? choiceAnswer(question, 'act', 0.99) : noulAnswer(0.99));
  const port = withDecisionLog({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); current = false; return result; } }, log);
  await expect(decideAutonomous({ ...input(port), allowAct: kind === 'disposition', continuations: [], assertCurrent: () => { if (!current) throw new JudgmentError('rejected', 'authority changed'); } })).rejects.toMatchObject({ kind: 'rejected' });
  const entries = log.query(); expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ status: 'answered', notes: [] });
});

test.each(['disposition', 'refusal'] as const)('%s requires an actual call decision ID before recording a reading', async kind => {
  const fake = fakePort((name, question) => name === 'disposition' ? choiceAnswer(question, 'act', 0.99) : noulAnswer(0.99));
  let notes = 0;
  const port = { ...fake.port, recorder: { recordReadings() { notes++; }, recordAction() { notes++; } } };
  await expect(decideAutonomous({ ...input(port), allowAct: kind === 'disposition', continuations: [] })).rejects.toMatchObject({ kind: 'unrecorded' });
  expect(fake.requests).toHaveLength(1); expect(notes).toBe(0);
});

test.each(['disposition', 'refusal'] as const)('%s forwards retry progress, cancellation and current-authority checks through the registered decision', async kind => {
  for (const change of ['recover', 'revoke', 'abort'] as const) {
    using log = new SqliteDecisionLog(':memory:');
    const controller = new AbortController();
    let attempts = 0, progress = 0, current = true, authorityChecks = 0;
    const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: PINNED_MODEL, timeoutMs: 1_000,
      retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async (_url, init) => {
        if (++attempts === 1) return new Response('', { status: 503 });
        const wire = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
        const answers = kind === 'disposition' ? { disposition: choiceAnswer(wire.questions.disposition!, 'act', 0.99) } : { refuse: noulAnswer(0.99) };
        return Response.json({ model: PINNED_MODEL, answers, usage: { input_tokens: 1, output_tokens: 1 } });
      } });
    const candidate = { ...input(withDecisionLog(transport, log)), allowAct: kind === 'disposition', continuations: [], signal: controller.signal,
      assertCurrent: () => { authorityChecks++; if (!current) throw new JudgmentError('rejected', 'authority changed'); },
      onRetry: () => { progress++; if (change === 'revoke') current = false; if (change === 'abort') controller.abort(); },
    };
    if (change === 'recover') {
      const result = await decideAutonomous(candidate);
      expect(result.decision.outcome).toBe(kind === 'disposition' ? 'act' : 'reject');
      expect(result.decision.judgmentDecisionIds).toHaveLength(1);
      expect(log.get(result.decision.judgmentDecisionIds[0]!)?.lineage?.attempts).toHaveLength(2);
      expect(attempts).toBe(2); expect(authorityChecks).toBeGreaterThanOrEqual(4);
    } else {
      await expect(decideAutonomous(candidate)).rejects.toMatchObject({ kind: change === 'revoke' ? 'rejected' : 'aborted' });
      expect(attempts).toBe(1); expect(log.query()).toMatchObject([{ status: 'failed' }]);
    }
    expect(progress).toBe(1);
    expect(log.query()[0]?.context).toEqual({ battery: `engine.gate.autonomous-${kind}`, batteryVersion: 1, pattern: 'dispatch', site: 'test.native-operation' });
  }
});
