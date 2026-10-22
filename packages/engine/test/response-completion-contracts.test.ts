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
