/**
 * Finishing a contract (docs/design/contract-runner.md section 6.5), on the
 * contract runner with the fake judgment port and a temporary repository:
 * the commit or apply in worktree mode, the scoped commit in shared mode, a
 * commit failure as a warning, the note outside git, and the answer on the
 * owner record with the status line on the operator audience only.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { hashState, JudgmentError, SqliteDecisionLog, type JsonValue } from '@goodvibes-jev/judgment';
import { CONTRACT_PASSED_WITHOUT_OUTPUT, describeCommitOutcome, describeContractOutcome, renderContractAnswer } from '../../sdk/src/platform/contract/index.js';
import { makeHarness, oneUnitPlan, startContract, twoUnitPlan, waitFor, type AgentScript, type Harness } from './runner-support.js';
import { contractOf, finishes, git, judgeOf, terminal } from './steps-support.js';
import { plannerOutput } from './plan-support.js';
import { ReadTool } from '../../sdk/src/platform/tools/read/index.js';
import { ProjectIndex } from '../../sdk/src/platform/state/project-index.js';
import { contractWorkReceipts } from '../../sdk/src/platform/contract/work-receipts.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function use(h: Harness): Harness {
  harness = h;
  return h;
}

async function run(h: Harness): Promise<string> {
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
  return contract.id;
}

test('original owner observations reach worker admission, unit checking and original fulfillment', async () => {
  const owner = { kind: 'original-owner-read-observations', ownerSessionId: 'session-1',
    sourceReads: [{ path: 'original.ts', returnedRanges: ['1-10'], returnedLines: 10 }],
    hostValidation: { operation: 'verify-recorded-owner-reads', success: true } };
  const seen = new Set<string>(); let task = ''; let plannerTask = '';
  const h = use(makeHarness({ plan: oneUnitPlan(1), readOwnerEvidence: () => owner,
    planner: { run: async input => {
      plannerTask = input.userPrompt;
      return { status: 'completed', output: plannerOutput(oneUnitPlan(1)), elapsedMs: 1, agentId: 'planner-1' };
    } },
    scripts: { u1: (record, context) => { task = record.task; return finishes('The parser is ready.')(record, context); } },
    port: ({ name, state }) => {
      const evidence = state['evidence'] as { orchestration?: { ownerPriorReads?: unknown } } | undefined;
      if (evidence?.orchestration?.ownerPriorReads) {
        expect(evidence.orchestration.ownerPriorReads).toEqual(owner);
        if (name === 'unfinished') seen.add('content');
        if (name === 'goal') seen.add(state['goal'] === 'A CSV parser' ? 'original-fulfillment' : 'unit');
      }
      return undefined;
    },
  }));
  const id = await run(h);
  expect(contractOf(h, id).status).toBe('passed');
  expect(task).toContain('original-owner-read-observations');
  expect(plannerTask).toContain(JSON.stringify(owner));
  expect(seen).toEqual(new Set(['unit', 'content', 'original-fulfillment']));
});

test('original fulfillment receives native arithmetic over complete unchanged reference inputs', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const plan = oneUnitPlan(1);
  plan.groups[0]!.units[0]!.role = 'research';
  plan.groups[0]!.units[0]!.files = ['scope.json'];
  let rootScope: unknown;
  const h = use(makeHarness({ plan, decisionLog: log, scripts: { u1: record => [{
    before: async () => {
      const index = new ProjectIndex(record.workingDirectory ?? h.root);
      const args = { files: [{ path: 'scope.json', extract: 'lines', range: { start: 1, end: 1 } },
        { path: 'source.ts', extract: 'lines', range: { start: 1, end: 3 } }] };
      try {
        const result = await new ReadTool(index).execute(args);
        expect(result.success).toBe(true);
        h.runner.hooks().onTurnEnd(record, { turn: 1, assistantText: 'Reviewed the assigned source.',
          toolCalls: [{ name: 'read', arguments: args }], results: [{ callId: 'real-source-return', ...result }] });
      } finally { await index.dispose(); }
    }, text: 'Reviewed source.ts:1-3 and its complete assignment input. No file edits or test execution claimed.',
  }] }, port: context => {
    if (context.name === 'role') return choiceAnswer(context.question, 'research', 0.99);
    if (judgeOf(context) === 'deliverable' && context.name === 'goal') {
      const evidence = context.state['evidence'] as { orchestration: { sourceJsonReferenceComparisons: unknown } };
      rootScope = evidence.orchestration.sourceJsonReferenceComparisons;
    }
    return undefined;
  } }));
  writeFileSync(join(h.root, 'scope.json'), '{"files":[{"path":"source.ts","ranges":[[1,3]]}]}\n');
  writeFileSync(join(h.root, 'source.ts'), 'export function parse(value) {\n  return value;\n}\n');
  const id = await run(h);
  expect(contractOf(h, id).status).toBe('passed');
  expect(rootScope).toMatchObject([{ source: 'native-host-interval-comparison', referencePath: 'scope.json',
    groups: [{ referencedLines: 3, coveredReferencedLines: 3, missingReferencedLines: 0, missing: [] }] }]);
  const done = contractOf(h, id);
  const recovery = contractWorkReceipts(done, { readObservations: true });
  expect(rootScope).toEqual(recovery.sourceScope?.sourceJsonReferenceComparisons);
  expect(recovery.sourceScope?.referenceOperations).toMatchObject([{ path: 'scope.json', success: true }]);
  expect(recovery.units[0]!.acceptedAnswer).toBe(done.units[0]!.answer);
  expect(recovery.units[0]!.acceptedAnswerDigest).toBe(hashState(done.units[0]!.answer!));
});

test('group and final checks receive actual plan-validation and unit-acceptance receipts', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const observed: Record<string, unknown>[] = [];
  const checkedOutputs = new Map<Record<string, unknown>, string>();
  let integrationTask = '';
  let integrationCheckHost: { plannedUnits: { id: string; readObservations?: unknown[]; acceptedAnswer?: string }[] } | undefined;
  let contentCriteria: unknown;
  let contentEvidence: Record<string, unknown> | undefined;
  const plan = twoUnitPlan();
  plan.groups[0]!.units[0]!.role = 'research';
  plan.groups[0]!.units[0]!.files.push('input.txt');
  plan.groups[0]!.criteria = [{ id: 'g1.c1', text: 'The parser implementation is coherent', serves: ['c1'] }];
  plan.groups[1]!.criteria = [{ id: 'g2.c1', text: 'Integration retains the accepted parser read receipts', serves: ['c2'] }];
  const h = use(makeHarness({ plan, decisionLog: log,
    scripts: { u1: record => {
      h.runner.hooks().onTurnEnd(record, { turn: 1, assistantText: 'Read the parser input.',
        toolCalls: [{ name: 'read', arguments: { files: [{ path: 'input.txt' }] } }],
        results: [{ callId: 'read', success: true, output: JSON.stringify({ success: true,
          files: [{ path: 'input.txt', extract: 'lines', content: '1 | first\n2 | second' }] }) }],
      });
      h.runner.hooks().onTurnEnd(record, { turn: 2, assistantText: 'Checked the parser.',
        toolCalls: [{ name: 'exec', arguments: { commands: [{ cmd: 'node --check src/csv.ts' }] } }],
        results: [{ callId: 'parser-check', success: true, output: 'Parser syntax valid.' }],
      });
      return [{ text: 'The existing parser handles CSV.' }];
    }, u2: (record, run) => {
      integrationTask = record.task;
      return finishes('Convert uses the parser.', 'src/convert.ts')(record, run);
    } },
    port: ({ name, question, state }) => {
      if (name === 'goal' && state['goal'] === 'Use the parser in convert') integrationCheckHost = (state['evidence'] as { orchestration?: typeof integrationCheckHost } | undefined)?.orchestration;
      if (name === 'role' && (state['unit'] as { title?: string })?.title === 'CSV parser') return choiceAnswer(question, 'research', 0.98);
      const evidence = state['evidence'] as Record<string, unknown> | undefined;
      if (name === 'unfinished') { contentCriteria = evidence?.['criteria']; contentEvidence = evidence; }
      if (evidence && ('units' in evidence || 'criteria' in evidence) && (name === 'goal' || name.startsWith('criterion_'))) {
        const output = state['output'];
        if (typeof output !== 'string') throw new Error('The contract must check its exact string answer.');
        observed.push(evidence); checkedOutputs.set(evidence, output);
      }
      return undefined;
    },
  }));
  mkdirSync(join(h.root, 'src'), { recursive: true });
  writeFileSync(join(h.root, 'src/csv.ts'), 'export const parse = (text: string) => text.split(",");\n');
  writeFileSync(join(h.root, 'input.txt'), 'first\nsecond\n');
  const id = await run(h);
  const done = contractOf(h, id);
  const accepted = done.decisions.find(decision => decision.action === 'plan-accepted' && decision.targetId === id)!;
  const integrationHost = JSON.parse(integrationTask.split('Actual host orchestration records (evidence, not approval of this unit):\n')[1]!);
  expect(integrationHost.contractId).toBe(id);
  expect(integrationHost.planChecks).toContainEqual({ at: new Date(accepted.at).toISOString(), reason: accepted.reason, decisionIds: accepted.decisionIds });
  expect(integrationHost.units).toMatchObject([{ id: 'u1', status: 'passed', latestCheck: { result: 'pass' } }]);
  expect(observed.some(evidence => 'units' in evidence)).toBe(true);
  expect(observed.some(evidence => 'criteria' in evidence)).toBe(true);
  for (const evidence of observed) {
    const protocol = (evidence['orchestration'] as { currentValidation: { scope: string; targetId: string; outputDigest: string; status: string; publicationRule: string } }).currentValidation;
    expect(protocol.scope).toBe('criteria' in evidence ? 'deliverable' : 'group');
    expect(protocol.targetId).toBe('criteria' in evidence ? id : (evidence['units'] as { id: string }[])[0]!.id === 'u1' ? 'g1' : 'g2');
    expect(protocol.outputDigest).toBe(hashState(checkedOutputs.get(evidence)!));
    expect(protocol.status).toBe('in-progress');
    if (protocol.scope === 'deliverable') {
      expect(protocol.publicationRule).toContain('only commits and delivers this checked answer after this judgment passes');
      expect(evidence).not.toHaveProperty('finalAnswerReview');
      const assessment = contentEvidence!['fulfillmentAssessment'] as { outputDigest: string; evidenceDigest: string; decisionIds: string[];
        goal: { verdict: string }; criteria: { id: string; verdict: string }[] };
      expect(assessment.outputDigest).toBe(protocol.outputDigest);
      expect(assessment.evidenceDigest).toBe(hashState(evidence as Record<string, JsonValue>));
      expect(assessment.goal.verdict).toBe('met');
      expect(assessment.criteria.map(criterion => [criterion.id, criterion.verdict])).toEqual(done.criteria.map(criterion => [criterion.id, 'met']));
      expect(assessment.decisionIds).toHaveLength(1);
      expect(log.get(assessment.decisionIds[0]!)).toMatchObject({ status: 'answered', context: { site: 'contract.check.deliverable-judge' } });
      const recorded = done.decisions.find(decision => decision.targetId === `${id}.final-answer-review`)!;
      const review = JSON.parse(recorded.reason);
      expect(review.passed).toBe(true);
      expect(review.outputDigest).toBe(protocol.outputDigest);
      expect(recorded.decisionIds).toEqual(review.decisionIds);
      expect(done.checks.at(-1)!.decisionIds).toEqual(expect.arrayContaining([...assessment.decisionIds, ...review.decisionIds]));
    }
  }
  const integrationEvidence = observed.find(evidence => Array.isArray(evidence['units']) &&
    (evidence['units'] as { id: string }[]).some(unit => unit.id === 'u2'))!;
  const integrationReceipts = integrationEvidence['orchestration'] as {
    groups: { id: string; status: string; criteria: { id: string; text: string; verdict: string }[]; latestCheck: { result: string } | null }[];
    units: { id: string; readObservations: unknown[] }[];
  };
  expect(integrationReceipts.groups).toMatchObject([{ id: 'g1', status: 'passed', latestCheck: { result: 'pass' } }]);
  expect(integrationReceipts.groups[0]!.criteria).toEqual([{ id: 'g1.c1', text: 'The parser implementation is coherent', verdict: 'met' }]);
  expect(integrationReceipts.groups.some(group => group.id === 'g2')).toBe(false);
  expect(integrationCheckHost?.plannedUnits.find(unit => unit.id === 'u1')?.readObservations).toEqual([
    { path: 'input.txt', returnedRanges: ['1-2'], returnedLines: 2 },
  ]);
  expect(integrationCheckHost?.plannedUnits.find(unit => unit.id === 'u1')?.acceptedAnswer).toBe(done.units[0]!.answer);
  expect(integrationEvidence['commands']).toEqual([{ agentId: done.units[0]!.agentIds[0], turn: 2, callIndex: 0, callId: 'parser-check',
    command: 'node --check src/csv.ts', success: true, head: 'Parser syntax valid.' }]);
  expect(integrationReceipts.units.find(unit => unit.id === 'u1')!.readObservations).toEqual([
    { path: 'input.txt', returnedRanges: ['1-2'], returnedLines: 2, contentKind: 'declared-reference', returnedContent: '1 | first\n2 | second' },
  ]);
  const acceptedPeer = (integrationEvidence['orchestration'] as { units: { id: string; acceptedAnswer: string; acceptedAnswerDigest: string; latestCheck: unknown }[] }).units.find(unit => unit.id === 'u1')!;
  expect(acceptedPeer.acceptedAnswer).toBe(done.units[0]!.answer!);
  expect(acceptedPeer.acceptedAnswerDigest).toBe(hashState(done.units[0]!.answer!));
  expect(acceptedPeer.latestCheck).toEqual(done.units[0]!.checks.at(-1)!);
  const finalReceipts = observed.find(evidence => 'criteria' in evidence)!['orchestration'] as { units: { id: string; acceptedAnswerDigest: string; acceptedAnswerSource: unknown; latestCheck: unknown; readObservations: unknown[] }[] };
  expect(Array.isArray(contentCriteria)).toBe(true);
  expect(observed.find(evidence => 'criteria' in evidence)!['criteria']).toEqual(contentCriteria);
  const finalPeer = finalReceipts.units.find(unit => unit.id === 'u1')!;
  const check = done.units[0]!.checks.at(-1)!;
  expect(check.decisionIds.length).toBeGreaterThan(0);
  expect(finalPeer.acceptedAnswerDigest).toBe(hashState(done.units[0]!.answer!));
  expect(finalPeer.acceptedAnswerSource).toEqual({ storage: 'native-contract-store', contractId: id, unitId: 'u1', field: 'answer' });
  expect(finalPeer.latestCheck).toEqual(check);
  expect(finalPeer.readObservations).toEqual([{ path: 'input.txt', returnedRanges: ['1-2'], returnedLines: 2,
    contentKind: 'declared-reference', returnedContentDigest: hashState('1 | first\n2 | second'),
    returnedContentBytes: Buffer.byteLength('1 | first\n2 | second'), nativeCheckRef: 'latestCheck',
  }]);
  expect(done.units[0]!.readEvidence![0]!.returnedContent).toBe('1 | first\n2 | second');
  for (const evidence of observed) {
    const host = evidence['orchestration'] as { contractId: string; planChecks: unknown[]; firstUnitStartedAt: number; units: { id: string; status: string; latestCheck: { id: string; result: string; decisionIds: string[] } }[] };
    expect(host.contractId).toBe(id);
    expect(host.planChecks).toContainEqual({ at: accepted.at, reason: accepted.reason, decisionIds: accepted.decisionIds });
    expect(host.firstUnitStartedAt).toBeGreaterThanOrEqual(accepted.at);
    expect(host.units.length).toBeGreaterThan(0);
    for (const receipt of host.units) {
      const actual = done.units.find(unit => unit.id === receipt.id)!;
      expect(receipt.status).toBe('passed');
      expect(receipt.latestCheck).toMatchObject({ id: actual.checks.at(-1)!.id, result: 'pass', decisionIds: actual.checks.at(-1)!.decisionIds });
    }
  }
  await h.runner.join(id);
});

test.each(['group', 'final-answer', 'fulfillment'])('a %s verifier request failure retries its check without rerunning accepted work', async stage => {
  const plan = oneUnitPlan(1);
  plan.groups[0]!.criteria = [{ id: 'g1.c1', text: 'The parser is coherent', serves: ['c1'] }];
  let failures = 0;
  let workers = 0;
  const h = use(makeHarness({ plan, scripts: { u1: (record, runtime) => { workers++; return finishes('The exact parser answer.')(record, runtime); } },
    port: context => {
      const target = stage === 'final-answer' ? context.name === 'unfinished'
        : context.name === 'goal' && judgeOf(context) === (stage === 'group' ? 'group' : 'deliverable');
      if (target && failures === 0) { failures++; throw new JudgmentError('rejected', 'fixture request rejection', { status: 400 }); }
      return undefined;
    },
  }));
  const { contract } = startContract(h);
  await waitFor(() => contractOf(h, contract.id).decisions.some(decision => decision.reason.includes('verification pending:')), 'a retained verification candidate');
  const waiting = contractOf(h, contract.id);
  expect(waiting.status).not.toBe('failed');
  expect(waiting.status).not.toBe('passed');
  expect(waiting.units[0]!.status).toBe('passed');
  expect(waiting.commit).toBeUndefined();
  await waitFor(() => terminal(h, contract.id), 'the fresh verifier check');
  const done = contractOf(h, contract.id);
  expect(done.status).toBe('passed');
  expect(done.answer).toBe('The exact parser answer.');
  expect(done.units).toHaveLength(1);
  expect(workers).toBe(1);
  expect(failures).toBe(1);
  expect(h.events.filter(event => event.type === 'CONTRACT_FAILED')).toEqual([]);
});

test('stopping a contract cancels its owned verifier retry without a verdict', async () => {
  let failures = 0;
  const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('A retained parser answer.') },
    port: context => { if (context.name === 'unfinished') { failures++; throw new JudgmentError('unavailable', 'fixture outage'); } return undefined; },
  }));
  const { contract } = startContract(h);
  await waitFor(() => contractOf(h, contract.id).decisions.some(decision => decision.reason.includes('verification pending:')), 'the retry wait');
  h.runner.cancel(contract.id, 'operator stopped the check');
  await h.runner.join(contract.id);
  expect(contractOf(h, contract.id).status).toBe('cancelled');
  expect(contractOf(h, contract.id).checks).toEqual([]);
  expect(failures).toBe(1);
});

test('a fulfillment request failure retries before content review and a later content rejection still blocks publication', async () => {
  let answerReviews = 0, fulfillmentRequests = 0, workers = 0;
  const h = use(makeHarness({ plan: oneUnitPlan(1),
    scripts: { u1: (record, context) => { workers++; return finishes('The retained parser answer.')(record, context); } },
    port: context => {
      if (context.name === 'unfinished') { answerReviews++; return noulAnswer(0.98); }
      if (context.name === 'goal' && judgeOf(context) === 'deliverable' && fulfillmentRequests++ === 0) {
        expect(answerReviews).toBe(0);
        throw new JudgmentError('rejected', 'fixture fulfillment request rejection', { status: 400 });
      }
      return undefined;
    },
  }));
  const { contract } = startContract(h);
  await waitFor(() => (h.runner.get(contract.id)?.checks.length ?? 0) > 0, 'fulfillment to retain the rejected answer verdict');
  const current = contractOf(h, contract.id);
  expect(fulfillmentRequests).toBe(2);
  expect(answerReviews).toBe(1);
  expect(workers).toBe(1);
  expect(current.checks[0]!.goal.verdict).toBe('met');
  expect(current.checks[0]!.result).toBe('stall');
  expect(current.commit).toBeUndefined();
  expect(current.status).not.toBe('passed');
  const review = JSON.parse(current.decisions.find(decision => decision.targetId === `${contract.id}.final-answer-review`)!.reason);
  expect(review.passed).toBe(false);
  expect(review.readings.unfinished.probability).toBe(0.98);
  h.runner.cancel(contract.id, 'test completed');
  await h.runner.join(contract.id);
});

test('a rejected native answer review holds publication even when fulfillment readings pass', async () => {
  const order: string[] = [];
  const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('The parser is ready.') },
    port: context => {
      if (context.name === 'goal' && judgeOf(context) === 'deliverable') {
        expect(context.state['evidence']).not.toHaveProperty('finalAnswerReview');
        order.push('original-requirements');
      }
      if (context.name === 'unfinished') {
        order.push('final-answer-content');
        const evidence = context.state['evidence'] as { fulfillmentAssessment: { goal: { verdict: string }; outputDigest: string } };
        expect(evidence.fulfillmentAssessment.goal.verdict).toBe('met');
        const output = context.state['output'];
        if (typeof output !== 'string') throw new Error('Content review must receive the exact final answer.');
        expect(evidence.fulfillmentAssessment.outputDigest).toBe(hashState(output));
        return noulAnswer(0.98);
      }
      return undefined;
    },
  }));
  const { contract } = startContract(h);
  await waitFor(() => (h.runner.get(contract.id)?.checks.length ?? 0) > 0, 'the answer review to reach fulfillment');
  const current = contractOf(h, contract.id);
  expect(current.status).not.toBe('passed');
  expect(current.checks[0]!.goal.verdict).toBe('met');
  expect(current.criteria[0]!.status).toBe('met');
  expect(current.checks[0]!.result).toBe('stall');
  expect(order).toEqual(['original-requirements', 'final-answer-content']);
  const review = JSON.parse(current.decisions.find(decision => decision.targetId === `${contract.id}.final-answer-review`)!.reason);
  expect(review.passed).toBe(false);
  expect(review.readings.unfinished.probability).toBe(0.98);
});

test('a final-content receipt resolves its own pending requirement through a genuine original-requirements recheck', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const order: string[] = [];
  let workers = 0;
  const plan = oneUnitPlan(1);
  plan.criteria[0]!.text = 'Have native Jev validate the completed final answer before publishing it.';
  const h = use(makeHarness({ plan, decisionLog: log,
    scripts: { u1: (record, context) => { workers++; return finishes('The parser is ready.')(record, context); } },
    port: context => {
      if (judgeOf(context) === 'deliverable') {
        const evidence = context.state['evidence'] as { finalAnswerReview?: { passed: boolean; outputDigest: string; decisionIds: string[] } };
        if (context.name === 'goal') order.push(evidence.finalAnswerReview ? 'requirements-with-review' : 'original-requirements');
        if (context.name === 'goal' || context.name.startsWith('criterion_')) {
          if (!evidence.finalAnswerReview) return noulAnswer(0.98);
          expect(evidence.finalAnswerReview.passed).toBe(true);
          const output = context.state['output'];
          if (typeof output !== 'string') throw new Error('Expected the exact final answer');
          expect(evidence.finalAnswerReview.outputDigest).toBe(hashState(output));
          expect(log.get(evidence.finalAnswerReview.decisionIds[0]!)?.context.site).toBe('contract.check.final-answer-review');
          return noulAnswer(0.01);
        }
      }
      if (context.name === 'unfinished') {
        order.push('final-answer-content');
        const evidence = context.state['evidence'] as { fulfillmentAssessment: { goal: { verdict: string } } };
        expect(evidence.fulfillmentAssessment.goal.verdict).toBe('unmet');
      }
      return undefined;
    },
  }));
  const id = await run(h);
  const done = contractOf(h, id);
  expect(done.status).toBe('passed');
  expect(done.criteria[0]!.text).toBe(plan.criteria[0]!.text);
  expect(workers).toBe(1);
  expect(order).toEqual(['original-requirements', 'final-answer-content', 'requirements-with-review']);
  const check = done.checks.at(-1)!;
  expect(check.result).toBe('pass');
  expect(check.decisionIds).toHaveLength(3);
  const records = check.decisionIds.map(id => log.get(id)!);
  expect(records.map(record => record.context.site)).toEqual(['contract.check.deliverable-judge', 'contract.check.final-answer-review', 'contract.check.deliverable-judge']);
  expect(done.criteria[0]!.readings.at(-1)!.decisionId).toBe(check.decisionIds[2]);
});

test('current primary evidence never bypasses an unmet original root after answer content passes', async () => {
  let composed = false, assessments = 0;
  const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('The parser is ready.') },
    port: ({ name, state }) => {
      if (state['goal'] === 'A CSV parser' && (name === 'goal' || name.startsWith('criterion_'))) {
        if (name === 'goal') assessments++;
        const evidence = state['evidence'] as { fullSourceEvidence?: unknown };
        composed = evidence.fullSourceEvidence !== undefined;
        return noulAnswer(0.98);
      }
      return undefined;
    },
  }));
  const { contract } = startContract(h);
  await waitFor(() => (h.runner.get(contract.id)?.checks.length ?? 0) > 0, 'the original fulfillment check');
  const current = contractOf(h, contract.id);
  expect(composed).toBe(true);
  expect(assessments).toBe(2);
  expect(current.status).not.toBe('passed');
  expect(current.criteria[0]!.status).toBe('unmet');
  expect(current.checks[0]!.result).not.toBe('pass');
  const review = JSON.parse(current.decisions.find(decision => decision.targetId === `${contract.id}.final-answer-review`)!.reason);
  expect(review.passed).toBe(true);
});

describe('the commit (6.5)', () => {
  test('worktree mode: the contract branch is merged into the base branch with a no-fast-forward commit naming the criteria', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto' }, scripts: { u1: finishes('export const parse = 1;') } }));
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('committed');
    expect(done.commit?.note).toBe(`committed ${done.commit!.hash!.slice(0, 8)}`);
    expect(git(h.root, 'rev-parse', 'HEAD').trim()).toBe(done.commit!.hash!);
    // A merge commit: two parents, the base and the contract branch.
    expect(git(h.root, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    const message = git(h.root, 'log', '-1', '--format=%B');
    expect(message).toContain('A CSV parser');
    expect(message).toContain(`Contract ${id}`);
    expect(message).toContain('Criteria met:\n- [c1] A CSV parser module exists');
    expect(message).toContain('Units:\n- u1 CSV parser');
    expect(git(h.root, 'show', 'HEAD:src/csv.ts')).toBe('export const parse = 1;\n');
    // The contract worktree is gone; its branch stays as the record of the work.
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(git(h.root, 'branch', '--list', done.branch!).trim()).toBe(done.branch!);
  }, 20_000);

  test('worktree mode with auto-commit off: the work is applied to the base tree as uncommitted changes', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto', autoCommit: false }, scripts: { u1: finishes('export const parse = 2;') } }));
    const head = git(h.root, 'rev-parse', 'HEAD').trim();
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit).toEqual({ status: 'applied', note: 'applied 1 file as uncommitted changes' });
    expect(git(h.root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf-8')).toBe('export const parse = 2;\n');
    expect(git(h.root, 'status', '--porcelain')).toContain('?? src/');
    expect(git(h.root, 'diff', '--cached', '--name-only').trim()).toBe('');
  }, 20_000);

  test('failed owner publication retains checked work and retries without delivering or rerunning the unit', async () => {
    let publicationAllowed = false, denied = 0, deliverableChecks = 0;
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'auto', autoCommit: false },
      scripts: { u1: finishes('export const parse = 9;') },
      port: context => { if (judgeOf(context) === 'deliverable' && context.name === 'goal') deliverableChecks++; return undefined; },
      readAccessFilter: async () => {
        if (!publicationAllowed && h.runner.list({ includeTerminal: true }).some(contract => contract.status === 'committing')) {
          denied++; return false;
        }
        return true;
      },
    }));
    writeFileSync(join(h.root, 'README.md'), '# Owner changes must survive\n');
    const head = git(h.root, 'rev-parse', 'HEAD').trim();
    const { contract, owner } = startContract(h);
    await waitFor(() => denied > 0 && contractOf(h, contract.id).commit?.status === 'failed', 'the failed publication to be recorded');
    expect(contractOf(h, contract.id).status).toBe('committing');
    expect(h.manager.getStatus(owner.id)?.status).not.toBe('completed');
    expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(false);
    expect(contractOf(h, contract.id).units[0]?.status).toBe('passed');
    const agents = h.agentsOf('u1');
    const previousChecks = deliverableChecks;
    publicationAllowed = true;
    await waitFor(() => terminal(h, contract.id), 'the retained result to be published automatically', 10_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('applied');
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf8')).toBe('export const parse = 9;\n');
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('# Owner changes must survive\n');
    expect(git(h.root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(h.agentsOf('u1')).toEqual(agents);
    expect(deliverableChecks).toBeGreaterThan(previousChecks);
    expect(h.manager.getStatus(owner.id)?.fullOutput).toBe('export const parse = 9;');
  }, 20_000);

  test('shared mode: exactly the touched paths are committed; a file already dirty at launch and untouched stays out', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('export const parse = 3;') } }));
    writeFileSync(join(h.root, 'README.md'), '# demo, edited by hand\n');
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('committed');
    expect(git(h.root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/csv.ts');
    expect(git(h.root, 'status', '--porcelain').trim()).toBe('M README.md');
  }, 20_000);

  test('a commit that fails is a warning: the contract passes, and the commit and status line say so', async () => {
    const h = use(makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('export const parse = 4;') } }));
    const hook = join(h.root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "refused by the test hook" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit?.status).toBe('failed');
    expect(done.commit?.note).toStartWith('commit failed: ');
    expect(done.commit?.note).toEndWith('the changes are left in the working tree');
    expect(done.statusLine).toContain('; commit failed: ');
    expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(true);
  }, 20_000);

  test('outside git the commit is skipped with a note', async () => {
    const script: AgentScript = () => [{ files: { 'src/csv.ts': 'export const parse = 5;\n' }, text: 'writing the parser', tool: true }, { text: 'parser written' }];
    const h = use(makeHarness({ plan: oneUnitPlan(1), contract: { midRunChecks: false }, scripts: { u1: script } }));
    rmSync(join(h.root, '.git'), { recursive: true, force: true });
    const id = await run(h);
    const done = contractOf(h, id);
    expect(done.status).toBe('passed');
    expect(done.commit).toEqual({ status: 'skipped', note: 'commit skipped: not a git repository' });
    expect(done.statusLine).toEndWith('; commit skipped: not a git repository');
  }, 20_000);
});

describe('answer and status (6.5)', () => {
  test("the integration unit's answer reaches the owner record; the status line only the operator audience", async () => {
    const h = use(makeHarness({
      scripts: {
        u1: finishes('parseCsv reads quoted fields'),
        u2: finishes('The convert command now reads CSV through parseCsv.', 'src/convert.ts'),
      },
    }));
    const { contract, owner } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'the contract to end', 15_000);
    const done = contractOf(h, contract.id);
    expect(done.status).toBe('passed');
    const record = h.manager.getStatus(owner.id)!;
    expect(record.status).toBe('completed');
    expect(record.fullOutput).toBe('The convert command now reads CSV through parseCsv.');
    expect(done.answer).toBe(record.fullOutput);
    expect(record.progressAudience).toBe('operator');
    expect(record.progress).toBe(done.statusLine);
    expect(done.statusLine).toBe(`Contract ${contract.id} passed (2 of 2 criteria met, 0 corrections); ${done.commit!.note}`);
    expect(record.fullOutput).not.toContain('Contract ');
  }, 20_000);

  test('the deliverable judge reads the exact delivered answer, with the full unit report retained as evidence', async () => {
    const report = 'Wired parseCsv into convert.\n\n```json\n{"version":1,"archetype":"integrator","summary":"Wired the parser into convert.","filesCreated":[],"filesModified":["src/convert.ts"]}\n```';
    const finalAnswer = 'The convert command now reads CSV through parseCsv. The implementation is in src/convert.ts.';
    const explicit = 'Supporting integration notes.\n\n```json\n' + JSON.stringify({ version: 1, archetype: 'integrator',
      summary: 'Wired the parser.', result: 'Supporting wiring details.', filesCreated: [], filesModified: ['src/convert.ts'], finalAnswer }) + '\n```';
    for (const [integrationText, expected] of [[report, 'Wired parseCsv into convert.'], [explicit, finalAnswer], ['', '']] as const) {
      const outputs: unknown[] = [];
      const reports: unknown[] = [];
      const h = use(makeHarness({
        scripts: { u1: finishes('parseCsv reads quoted fields'), u2: finishes(integrationText, 'src/convert.ts') },
        port: ({ name, state }) => {
          // The deliverable judge's evidence carries the per-criterion summaries; a group judge's carries its units.
          const evidence = state['evidence'] as Record<string, unknown> | undefined;
          if (evidence !== undefined && 'criteria' in evidence && 'output' in state && (name === 'goal' || name.startsWith('criterion_'))) {
            outputs.push(state['output']);
            const units = (evidence['orchestration'] as { units: { id: string; acceptedAnswerDigest: string;
              acceptedAnswerSource: { storage: string; contractId: string; unitId: string; field: string } }[] }).units;
            const reference = units.find(value => value.id === 'u2')!;
            const source = reference.acceptedAnswerSource;
            const full = h.store.get(source.contractId)!.units.find(unit => unit.id === source.unitId)!.answer!;
            expect(reference.acceptedAnswerDigest).toBe(hashState(full));
            expect(source).toEqual({ storage: 'native-contract-store', contractId: source.contractId, unitId: 'u2', field: 'answer' });
            reports.push(full);
          }
          return undefined;
        },
      }));
      const id = await run(h);
      expect(contractOf(h, id).status).toBe('passed');
      expect(outputs.length).toBeGreaterThan(0);
      for (const output of outputs) {
        expect(output).toBe(expected);
        expect(output).not.toContain(CONTRACT_PASSED_WITHOUT_OUTPUT);
      }
      expect(reports.every(value => value === integrationText)).toBe(true);
      if (expected) expect(contractOf(h, id).answer).toBe(expected);
      h.dispose();
      harness = undefined;
    }
  }, 40_000);

  test('a structured completion report preserves its result, falls back to its summary, and handles no answer', () => {
    const report = '```json\n{"version":1,"archetype":"integrator","summary":"Wired the parser into convert.","filesCreated":[],"filesModified":["src/convert.ts"]}\n```';
    const plan = twoUnitPlan();
    const units = plan.groups.flatMap((group) => group.units.map((unit) => ({ id: unit.id, groupId: group.id, role: unit.role, answer: unit.role === 'integration' ? report : 'parser done' })));
    const groups = plan.groups.map((group) => ({ id: group.id, kind: group.kind }));
    expect(renderContractAnswer({ units, groups } as unknown as Parameters<typeof renderContractAnswer>[0])).toBe('Wired the parser into convert.');
    const findings = 'registry-models.ts:86 permits duplicate registry keys when native and discovered models share a key.';
    const review = '```json\n' + JSON.stringify({ version: 1, archetype: 'researcher', summary: 'Found one bug.', result: findings }) + '\n```';
    const reviewed = units.map(unit => unit.role === 'integration' ? { ...unit, answer: review } : unit);
    expect(renderContractAnswer({ units: reviewed, groups } as unknown as Parameters<typeof renderContractAnswer>[0])).toBe(findings);
    const fullReview = '# Codebase review\n\nparser.ts:12 drops the final row.\n\nsettings.ts:20 dereferences null.\n\n```json\n'
      + JSON.stringify({ version: 1, archetype: 'engineer', summary: 'Integrated the review.', filesCreated: [], filesModified: [] }) + '\n```';
    const proseReview = units.map(unit => unit.role === 'integration' ? { ...unit, answer: fullReview } : unit);
    expect(renderContractAnswer({ units: proseReview, groups } as unknown as Parameters<typeof renderContractAnswer>[0]))
      .toBe('# Codebase review\n\nparser.ts:12 drops the final row.\n\nsettings.ts:20 dereferences null.');
    expect(renderContractAnswer({ units: [], groups: [] })).toBe('');
    expect(describeCommitOutcome(null, ['.goodvibes/x'], false)).toBe('commit skipped: 1 ignored path skipped');
    expect(describeCommitOutcome(null, [], true)).toBe('commit skipped: the contract changed no files');
    expect(describeContractOutcome({
      id: 'ctr-00000000',
      criteria: [
        { id: 'c1', text: 'a', origin: 'stated', serves: [], disposition: 'judged', status: 'met', readings: [] },
        { id: 'c2', text: 'b', origin: 'stated', serves: [], disposition: 'excluded', status: 'unread', readings: [] },
      ],
      units: [],
      commit: { status: 'skipped', note: 'commit skipped: not a git repository' },
    })).toBe('Contract ctr-00000000 passed (1 of 1 criterion met, 0 corrections, 1 excluded: requires an agent arrangement); commit skipped: not a git repository');
  });
});
