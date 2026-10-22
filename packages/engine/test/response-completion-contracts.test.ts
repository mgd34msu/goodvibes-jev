import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { completedContractEvidence } from '../sdk/src/platform/core/response-completion-contracts.js';
import type { ContractView, UnitCheck } from '../sdk/src/platform/contract/types.js';
import { CompletionEvidenceProjection } from '../sdk/src/platform/core/response-completion-evidence.js';
import { verificationSources } from '../sdk/src/platform/core/verification/source.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import { ResponseCompletionGuard } from '../sdk/src/platform/core/response-completion.js';
import { hashState } from '@goodvibes-jev/judgment';
import { goalObligationSource } from '../sdk/src/platform/contract/goal-obligation-proof.js';

const originalPort = installJudgmentPort(undefined);
afterEach(() => installJudgmentPort(originalPort));
const check: UnitCheck = { id: 'work.k1', at: 100, trigger: 'completion', result: 'pass',
  goal: { probabilityUnmet: .01, verdict: 'met', outcome: 'act' }, quality: {},
  evidenceDigest: 'original-work-evidence', decisionIds: ['real-reading'] };
const contract = (overrides: Record<string, unknown> = {}) => ({ id: 'work', sessionId: 'session', projectRoot: '/project',
  ask: 'Review all source and deliver review.md.', goal: 'Full review', status: 'passed', completedAt: 100,
  criteria: [{ id: 'c1', text: 'Review all source', disposition: 'judge', status: 'met', readings: [{ checkId: check.id, probabilityUnmet: .01, decisionId: 'real-reading' }] }],
  checks: [check], decisions: [], units: [{ id: 'work.u1', goal: 'Review source', status: 'passed', checks: [check] }],
  answer: 'Findings are in review.md.', commit: { status: 'applied', note: 'Applied review.md.' }, ...overrides }) as unknown as ContractView;

function approvedWork(projectRoot = '/project') {
  const view = contract({ criteria: [{ id: 'c1', text: 'Review all source and deliver review.md.', disposition: 'judged', status: 'met', readings: [] }] });
  const content = { schemaVersion: 2, passed: true, outputDigest: hashState(view.answer!),
    stateHash: hashState('actual-reviewed-state'), evidenceDigest: hashState('actual-reviewed-evidence'),
    policy: { fulfillment: { name: 'contract.deliverable-judge', version: 5 }, content: { name: 'contract.final-answer-review', version: 9 }, stakes: 'high' },
    readings: { unfinished: { probability: .01, verdict: 'no', outcome: 'act' }, unsupported: { probability: .01, verdict: 'no', outcome: 'act' } },
    decisionIds: ['actual-content-review'], fulfillmentDecisionIds: ['actual-original-scope-check'] };
  const scope = { schemaVersion: 1, passed: true, policy: { name: 'contract.goal-obligations', version: 1 },
    outputDigest: hashState(view.answer!), literalSourceDigest: hashState(goalObligationSource(view)), stateHash: hashState('actual-scope-state'),
    sourceJudgmentDecisionIds: ['actual-original-scope-check'], decisionIds: ['actual-scope-implication'],
    reading: { probability: .01, verdict: 'no', outcome: 'act' }, sourceGoal: { probability: .01, verdict: 'no', outcome: 'act' } };
  const accepted = { ...view, decisions: [
    { id: 'work.d1', at: 100, action: 'passed' as const, targetId: 'work.final-answer-review', reason: JSON.stringify(content), decisionIds: ['actual-content-review'] },
    { id: 'work.d2', at: 100, action: 'passed' as const, targetId: 'work.goal-obligations', reason: JSON.stringify(scope), decisionIds: ['actual-scope-implication'] },
  ] };
  return completedContractEvidence({ list: () => [accepted] }, 'session', projectRoot);
}

function handoff(previousObservation?: string, compactHistory = false) {
  const conversation = new ConversationManager();
  conversation.addUserMessage('Review all source and deliver review.md.');
  conversation.addToolResults([{ callId: 'old-progress', success: true, output: 'Earlier partial-review observation. '.repeat(10_000) }]);
  if (previousObservation) conversation.addToolResults([{ callId: 'previous-change', success: true, output: previousObservation }]);
  if (compactHistory) conversation.replaceMessagesForLLM([{ role: 'assistant', content: 'Earlier observations remain in the native archive.' }]);
  conversation.addUserMessage('Review all source and deliver review.md.');
  conversation.addUserMessage('Deliver the accepted review. Preserve files.');
  const request = 'Deliver the accepted review. Preserve files.';
  const guard = new ResponseCompletionGuard({ request, conversation, verificationWriter: async () => { throw new Error('FULL-ORIGINAL-RETRIEVAL'); } });
  conversation.addToolResults([{ callId: 'current-delivery', success: true, output: 'CURRENT-DELIVERY: review.md exists and contains the approved findings.' }]);
  return { guard, input: { request, response: 'The completed review is in review.md.', conversation, tools: ['read'], completedWork: approvedWork() } };
}

test('a native scoped work checkpoint still requires fresh final gates, preserves repeated instructions and the exact current observations', async () => {
  const { guard, input } = handoff(), fake = fakePort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  expect(await guard.check(input)).toBeNull();
  const current = fake.requests.find(request => request.context?.battery === 'engine.core.response-completion')!.state as unknown as {
    nativeWorkCheckpoint: unknown; originalInstructions: unknown; transcript: { role: string; content: unknown }[]; completedWork: unknown };
  expect(current.nativeWorkCheckpoint).toBeDefined();
  expect(current.transcript.filter(message => message.role === 'user' && message.content === 'Review all source and deliver review.md.')).toHaveLength(2);
  expect(JSON.stringify(current.originalInstructions)).toContain('Preserve files');
  expect(JSON.stringify(current.transcript)).toContain('CURRENT-DELIVERY');
  expect(JSON.stringify(current.transcript)).not.toContain('Earlier partial-review observation');
  expect(JSON.stringify(current.completedWork)).toContain('actual-scope-implication');
  expect(fake.requests.some(request => request.context?.battery === 'engine.core.execution-assurance')).toBe(true);
  expect(fake.requests.some(request => request.context?.battery === 'engine.verification.checkpoint-history')).toBe(true);
});

test.each([false, true])('an invalidating observation from a previous turn blocks the checkpoint, including compacted history (%s)', async compactHistory => {
  const { guard, input } = handoff('POST-ACCEPTANCE-DELETION: a successful write emptied review.md after native acceptance; no restoration exists.', compactHistory);
  const fake = fakePort((name, _question, raw) => noulAnswer(name === 'missed'
    && JSON.stringify((raw as unknown as { sources?: unknown }).sources).includes('POST-ACCEPTANCE-DELETION') ? .99 : .01));
  installJudgmentPort(fake.port);
  await expect(guard.check(input)).rejects.toThrow();
  expect(fake.requests.some(request => request.context?.battery === 'engine.verification.checkpoint-history'
    && JSON.stringify(request.state).includes('POST-ACCEPTANCE-DELETION'))).toBe(true);
  expect(fake.requests.some(request => request.context?.battery === 'engine.core.response-completion')).toBe(false);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('unchanged history is audited once across final wording edits while both proposed answers get fresh final checks', async () => {
  const { guard, input } = handoff(), fake = fakePort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  expect(await guard.check(input)).toBeNull();
  const audited = fake.requests.filter(request => request.context?.battery === 'engine.verification.checkpoint-history').length;
  expect(audited).toBeGreaterThan(0);
  input.response = 'Read the completed findings in review.md.';
  expect(await guard.check(input)).toBeNull();
  expect(fake.requests.filter(request => request.context?.battery === 'engine.verification.checkpoint-history')).toHaveLength(audited);
  expect(fake.requests.filter(request => request.context?.battery === 'engine.core.response-completion')).toHaveLength(2);
});

test.each(['copied', 'mutated'] as const)('a %s completed-work record cannot substitute for a native checkpoint', async mode => {
  const { guard, input } = handoff();
  if (mode === 'copied') input.completedWork = JSON.parse(JSON.stringify(input.completedWork));
  else input.completedWork[0]!.answer = 'Changed after native acceptance.';
  const fake = fakePort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  await expect(guard.check(input)).rejects.toThrow();
  expect(fake.requests.some(request => (request.state as unknown as { nativeWorkCheckpoint?: unknown }).nativeWorkCheckpoint)).toBe(false);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('a current invalidating observation holds the checkpoint and retrieves originals before asking for a model rewrite', async () => {
  const { guard, input } = handoff();
  input.conversation.addToolResults([{ callId: 'later-change', success: true, output: 'INVALIDATED-DELIVERY: the report was subsequently removed.' }]);
  const fake = fakePort((name, _question, raw) => noulAnswer(name === 'unfinished' && JSON.stringify(raw).includes('INVALIDATED-DELIVERY') ? .99 : .01));
  installJudgmentPort(fake.port);
  await expect(guard.check(input)).rejects.toThrow();
  expect(fake.requests.some(request => (request.state as unknown as { nativeWorkCheckpoint?: unknown }).nativeWorkCheckpoint)).toBe(true);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('completed work in another project cannot qualify a checkpoint', async () => {
  const { guard, input } = handoff();
  input.completedWork = approvedWork('/another-project');
  const fake = fakePort(() => noulAnswer(.01)); installJudgmentPort(fake.port);
  await expect(guard.check(input)).rejects.toThrow();
  expect(fake.requests.some(request => (request.state as unknown as { nativeWorkCheckpoint?: unknown }).nativeWorkCheckpoint)).toBe(false);
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('an uncovered original obligation remains in the checkpoint and a fresh check retrieves full sources before repair', async () => {
  const { guard, input } = handoff();
  input.conversation.addUserMessage('Also deliver the UNFINISHED-SECOND-ARTIFACT.');
  const fake = fakePort((name, _question, raw) => noulAnswer(name === 'unfinished' && JSON.stringify(raw).includes('UNFINISHED-SECOND-ARTIFACT') ? .99 : .01));
  installJudgmentPort(fake.port);
  await expect(guard.check(input)).rejects.toThrow();
  const current = fake.requests.find(request => (request.state as unknown as { nativeWorkCheckpoint?: unknown }).nativeWorkCheckpoint);
  expect(JSON.stringify(current?.state)).toContain('UNFINISHED-SECOND-ARTIFACT');
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});

test('completed evidence includes terminal work from only this session without loading repository manifests', () => {
  let requested: unknown;
  const evidence = completedContractEvidence({ list(filter) { requested = filter; return [contract(),
    contract({ id: 'other', sessionId: 'other-session', answer: 'UNRELATED-PRIVATE-WORK' }),
    contract({ id: 'active', status: 'running' }),
    contract({ id: 'failed', status: 'failed', error: 'Review incomplete', commit: { status: 'failed', note: 'Publication rejected' } }),
  ]; } }, 'session');
  expect(requested).toEqual({ sessionId: 'session', includeTerminal: true, includeInputSnapshot: false });
  expect(evidence.map(work => work.id)).toEqual(['work', 'failed']);
  expect(evidence[0]!.finalCheck).toEqual(check);
  expect(evidence[0]!.criteria[0]!.reading!.decisionId).toBe('real-reading');
  expect(evidence[1]!.publication!.status).toBe('failed');
  expect(evidence[1]!.error).toBe('Review incomplete');
  expect(JSON.stringify(evidence)).not.toContain('UNRELATED-PRIVATE-WORK');
});

test('completed records stay observations through projection and retrieval, never user instructions', () => {
  const completedWork = completedContractEvidence({ list: () => [contract()] }, 'session');
  const projected = new CompletionEvidenceProjection().prepareFull({ request: 'Deliver the saved review.', response: 'See review.md.',
    transcript: [], tools: [], delegated: [], requirements: null, initial: null, completedWork });
  const sources = verificationSources(projected);
  expect(sources.filter(source => source.kind === 'instruction').map(source => source.text)).toEqual(['Deliver the saved review.']);
  const observations = sources.filter(source => source.kind === 'observation' && source.reference.includes('scoped checks and publication'));
  expect(observations.map(source => source.text).join('')).toBe(JSON.stringify(completedWork[0]));
  expect(observations[0]!.reference).toContain('host completed contract work');
  const acceptance = sources.filter(source => source.reference.includes('; acceptance and publication;'));
  expect(acceptance).toHaveLength(1);
  const receipt = JSON.parse(acceptance[0]!.text);
  expect(receipt.finalCheck).toEqual(check);
  expect(receipt.publication.status).toBe('applied');
  expect(receipt).not.toHaveProperty('answer');
  expect(receipt).not.toHaveProperty('units');
  const privateWork = new CompletionEvidenceProjection().prepareFull({ request: 'Deliver the saved review.', response: 'See review.md.',
    transcript: [], tools: [], delegated: [], requirements: null, initial: null,
    completedWork: [{ id: 'secret', answer: 'password=synthetic-private-value' }] });
  expect(JSON.stringify(privateWork)).not.toContain('synthetic-private-value');
  expect(privateWork.completedWork![0]).toHaveProperty('unavailableObservation');
});

test('the exact recorded Jev content review is bound to the saved answer and an older matching pass cannot hide a stale latest receipt', () => {
  const answer = 'Findings are in review.md.';
  const review = { schemaVersion: 2, passed: true, outputDigest: hashState(answer),
    stateHash: hashState('actual-reviewed-state'), evidenceDigest: hashState('actual-reviewed-evidence'),
    policy: { fulfillment: { name: 'contract.deliverable-judge', version: 5 }, content: { name: 'contract.final-answer-review', version: 9 }, stakes: 'high' },
    readings: { unfinished: { probability: .01, verdict: 'no', outcome: 'act' }, unsupported: { probability: .01, verdict: 'no', outcome: 'act' } },
    decisionIds: ['actual-content-review'], fulfillmentDecisionIds: ['actual-original-scope-check'] };
  const decision = { id: 'work.d1', targetId: 'work.final-answer-review', reason: JSON.stringify(review) };
  const completed = contract({ decisions: [decision] });
  const admitted = completedContractEvidence({ list: () => [completed] }, 'session')[0]!;
  expect(admitted.contentReview!.matchesSavedAnswer).toBe(true);
  expect(admitted.contentReview!.record).toEqual(review);
  expect(admitted.contentReview!.recordedDecisionId).toBe('work.d1');
  const stale = contract({ decisions: [decision, { ...decision, id: 'work.d2', reason: JSON.stringify({ ...review, outputDigest: hashState('A different answer.') }) }] });
  const held = completedContractEvidence({ list: () => [stale] }, 'session')[0]!;
  expect(held.contentReview!.matchesSavedAnswer).toBe(false);
  expect(held.contentReview!.recordedDecisionId).toBe('work.d2');
  const malformed = contract({ decisions: [{ ...decision, reason: JSON.stringify({ ...review, decisionIds: [] }) }] });
  expect(completedContractEvidence({ list: () => [malformed] }, 'session')[0]!.contentReview!.matchesSavedAnswer).toBe(false);
  expect(completedContractEvidence({ list: () => [contract({ decisions: [{ ...decision, reason: 'invalid JSON' }] })] }, 'session')[0]!.contentReview).toBeNull();
});

test('completion checks receive scoped records but a rejection still holds publication and changed records invalidate acceptance', async () => {
  const completedWork = completedContractEvidence({ list: () => [contract()] }, 'session');
  const conversation = new ConversationManager(); conversation.addUserMessage('Deliver the saved review.');
  const input = { request: 'Deliver the saved review.', response: 'See review.md.', conversation, tools: [], completedWork };
  const held = fakePort(name => noulAnswer(name === 'unsupported' ? .99 : .01)); installJudgmentPort(held.port);
  const guard = new ResponseCompletionGuard();
  expect(await guard.check(input)).not.toBeNull();
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
  expect((held.requests[0]!.state as unknown as { completedWork: unknown }).completedWork).toEqual(completedWork);
  installJudgmentPort(fakePort(() => noulAnswer(.01)).port);
  expect(await guard.check(input)).toBeNull();
  completedWork[0]!.answer = 'Changed after the response check.';
  expect(() => guard.beginFinalization({ content: input.response })).toThrow();
});
