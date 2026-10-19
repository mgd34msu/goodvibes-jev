/**
 * Owner escalations and replies (docs/design/contract-runner.md section 6.3),
 * on the contract runner with the fake judgment port: for each escalation
 * reason, what each reading of the owner's reply does. Approval can settle
 * readings that did not settle, a plan, a choice of attempt or whether files
 * may change; it never passes a criterion that reads unmet.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { hasContractPlanConsumer } from '../../sdk/src/platform/tools/agent/contract-binding.js';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { APPROVAL_REFUSED_LINE, ASK_AGAIN_LINE, NAME_AN_ATTEMPT_LINE, type EscalationReason, type OwnerReplyOutcome } from '../../sdk/src/platform/contract/index.js';
import { unsettledReadingsNote } from '../../sdk/src/platform/contract/escalation.js';
import { QUALITY_EVIDENCE_SENTENCES } from '../../sdk/src/platform/contract/nudge.js';
import { unitTitleOf, type AnswerContext } from './plan-support.js';
import { ASK, makeHarness, oneUnitPlan, startContract, waitFor, type AgentScript, type Harness, type HarnessOptions } from './runner-support.js';
import {
  MET,
  amendmentOutput,
  answers,
  contractOf,
  finishes,
  judgeOf,
  keepsFailing,
  replyAnswers,
  routeAnswer,
  stepPlanner,
  terminal,
  type StepPlanner,
} from './steps-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

type Reading = 'approve' | 'amend' | 'reject' | 'unclear';

/** A contract brought to one escalation, and how to reply to it. */
interface Scenario {
  readonly h: Harness;
  readonly contractId: string;
  readonly planner: StepPlanner;
  /** Set once an amendment was planned: every judge then reads met. */
  readonly amended: { value: boolean };
  reply(text: string): Promise<OwnerReplyOutcome>;
}

/** Everything reads met once the owner's amendment was planned. */
function metOnceAmended(amended: { value: boolean }) {
  return (context: AnswerContext): unknown => (amended.value && judgeOf(context) !== null ? noulAnswer(MET) : undefined);
}

async function reach(options: Omit<HarnessOptions, 'planner'> & { readonly planner: StepPlanner; readonly amended: { value: boolean } }, reason: EscalationReason): Promise<Scenario> {
  let h: Harness;
  const original = options.scripts.u1;
  h = makeHarness({ ...options, planner: options.planner.runner, ...(reason === 'fix-rounds-exhausted' && original ? {
    scripts: { ...options.scripts, u1: (record, run) => {
      h.store.get(record.contractId!)!.units[0]!.fixRounds = 1;
      return original(record, run);
    } },
  } : {}) });
  harness = h;
  const { contract } = startContract(h);
  await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner' || terminal(h, contract.id), `the ${reason} escalation`, 15_000);
  const escalation = contractOf(h, contract.id).escalations.at(-1)!;
  expect(escalation.reason).toBe(reason);
  return {
    h,
    contractId: contract.id,
    planner: options.planner,
    amended: options.amended,
    reply: (text) => h.runner.reply(contract.id, contractOf(h, contract.id).escalations.at(-1)!.id, text),
  };
}

/** A plan amendment's answer that keeps u1's one criterion reworded. */
function amendUnit(amended: { value: boolean }) {
  return (): string => {
    amended.value = true;
    return amendmentOutput([{ id: 'u1.c1', text: 'parser property 1, relaxed as the owner said' }]);
  };
}

type Setup = (reading: Reading) => Promise<Scenario>;

const SETUPS: Readonly<Record<Exclude<EscalationReason, 'owner-decision-needed' | 'unsettled' | 'writing-unclear'>, Setup>> = {
  stalled: async (reading) => {
    const amended = { value: false };
    return reach({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2 },
      planner: stepPlanner(oneUnitPlan(1), { amend: amendUnit(amended) }),
      amended,
      scripts: { u1: keepsFailing(3) },
      port: answers(metOnceAmended(amended), routeAnswer('owner'), replyAnswers([{ reading }])),
    }, 'stalled');
  },
  'fix-rounds-exhausted': async (reading) => {
    const amended = { value: false };
    return reach({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2, maxFixRounds: 1 },
      planner: stepPlanner(oneUnitPlan(1), { amend: amendUnit(amended) }),
      amended,
      scripts: { u1: keepsFailing(3) },
      port: answers(metOnceAmended(amended), replyAnswers([{ reading }])),
    }, 'fix-rounds-exhausted');
  },
  'plan-unresolved': async (reading) => {
    const amended = { value: false };
    let shapes = 0;
    // The first plan and its one allowed repair narrow the unit; the owner decides before a corrected plan.
    const narrowsOnce = (context: AnswerContext): unknown => {
      if (!context.name.startsWith('narrows_') || unitTitleOf(context.state) === undefined) return undefined;
      shapes += 1;
      return noulAnswer(shapes <= 2 ? 0.97 : 0.03);
    };
    const planner = stepPlanner(oneUnitPlan(1));
    return reach({
      plan: oneUnitPlan(1),
      contract: { planRepairLimit: 1 },
      planner,
      amended,
      scripts: { u1: finishes('parser written') },
      port: answers(narrowsOnce, replyAnswers([{ reading }])),
    }, 'plan-unresolved');
  },
  'attempts-undecided': async (reading) => {
    const amended = { value: false };
    // The selection proposes u1#a0 at confirm: the owner decides. The owner's pick reads the attempt a reply
    // asks for: u1#a1 for "u1#a1" or "the second one", none for anything else.
    const selection = (context: AnswerContext): unknown => {
      const candidates = context.state['candidates'] as { id: string }[] | undefined;
      if (candidates === undefined) return undefined;
      const reply = (context.state['context'] as { reply?: string }).reply;
      const wanted = reply === undefined ? 'u1#a0' : /u1#a1|second/.test(reply) ? 'u1#a1' : 'none';
      if (context.name === 'pick') return choiceAnswer(context.question, wanted, reply === undefined ? 0.75 : 0.97);
      const fit = /^fits_(\d+)$/.exec(context.name);
      return fit === null ? undefined : noulAnswer(candidates[Number(fit[1])]!.id === wanted ? 0.97 : 0.03);
    };
    return reach({
      plan: oneUnitPlan(1),
      contract: { isolation: 'auto', defaultAttempts: 2 },
      planner: stepPlanner(oneUnitPlan(1)),
      amended,
      scripts: { 'u1#a0': finishes('parser zero'), 'u1#a1': finishes('parser one') },
      port: answers(selection, replyAnswers([{ reading }])),
    }, 'attempts-undecided');
  },
};

/** What the reply text says, per reading. */
const TEXTS: Readonly<Record<Reading, string>> = {
  approve: 'Yes, approved.',
  amend: 'Relax that requirement; take u1#a1 instead; nothing may be changed.',
  reject: 'Stop the whole thing.',
  unclear: 'What does that mean?',
};

async function settle(s: Scenario): Promise<void> {
  await waitFor(() => terminal(s.h, s.contractId), 'the contract to end', 15_000);
}

describe('owner replies (6.3)', () => {
  for (const [reason, setup] of Object.entries(SETUPS) as [Exclude<EscalationReason, 'owner-decision-needed'>, Setup][]) {
    describe(reason, () => {
      test('reject stops the contract as cancelled by the owner', async () => {
        const s = await setup('reject');
        const outcome = await s.reply(TEXTS.reject);
        expect(outcome).toMatchObject({ reading: 'reject', outcome: 'act', action: 'stopped' });
        const done = contractOf(s.h, s.contractId);
        expect(done.status).toBe('cancelled');
        expect(done.failureKind).toBe('owner-rejected');
        expect(done.error).toBe('stopped by the owner');
        expect(done.escalations[0]!.reply?.reading).toBe('reject');
      }, 25_000);

      test('an unclear reply puts the question again with one fixed line', async () => {
        const s = await setup('unclear');
        const outcome = await s.reply(TEXTS.unclear);
        expect(outcome).toMatchObject({ reading: 'unclear', action: 'asked-again' });
        const contract = contractOf(s.h, s.contractId);
        expect(contract.status).toBe('awaiting-owner');
        expect(contract.escalations).toHaveLength(2);
        expect(contract.escalations[0]!.resolvedAt).toBeDefined();
        const again = contract.escalations[1]!;
        expect(again.id).toBe(outcome.nextEscalationId!);
        expect(again.reason).toBe(reason);
        expect(again.question.endsWith(`\n${ASK_AGAIN_LINE}`)).toBe(true);
        expect(again.question.startsWith(contract.escalations[0]!.question.split('\n')[0]!)).toBe(true);
      }, 25_000);

      test('approve does what approval means for this reason, and never passes an unmet criterion', async () => {
        const s = await setup('approve');
        const outcome = await s.reply(TEXTS.approve);
        if (reason === 'stalled' || reason === 'fix-rounds-exhausted' || reason === 'unsettled') {
          expect(outcome.action).toBe('refused');
          const contract = contractOf(s.h, s.contractId);
          expect(contract.status).toBe('awaiting-owner');
          expect(contract.units[0]!.status).toBe('awaiting-owner');
          expect(contract.units[0]!.criteria[0]!.status).toBe(reason === 'unsettled' ? 'unshown' : 'unmet');
          expect(contract.escalations.at(-1)!.question.endsWith(`\n${APPROVAL_REFUSED_LINE}`)).toBe(true);
          return;
        }
        expect(outcome.action).toBe('approved');
        await settle(s);
        const done = contractOf(s.h, s.contractId);
        expect(done.status).toBe('passed');
        if (reason === 'writing-unclear') expect(done.shape?.forbids_writing).toMatchObject({ verdict: 'no', outcome: 'act' });
        if (reason === 'attempts-undecided') expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a0');
      }, 25_000);

      test('amend changes what is required and the work goes on', async () => {
        const s = await setup('amend');
        const outcome = await s.reply(TEXTS.amend);
        expect(outcome.action).toBe('amended');
        for (const request of s.planner.of('amend')) expect(hasContractPlanConsumer(request)).toBe(true);
        await settle(s);
        const done = contractOf(s.h, s.contractId);
        expect(done.status).toBe('passed');
        if (reason === 'stalled' || reason === 'fix-rounds-exhausted' || reason === 'unsettled') {
          // The planner reworded the criterion as the owner said; the unit was checked again and passed.
          expect(s.planner.of('amend')).toHaveLength(1);
          expect(s.planner.of('amend')[0]!.userPrompt).toContain(TEXTS.amend);
          const unit = done.units[0]!;
          expect(unit.criteria.map((criterion) => [criterion.id, criterion.origin, criterion.status])).toEqual([['u1.o1', 'owner', 'met']]);
          expect(unit.checks.at(-1)).toMatchObject({ trigger: 'owner-amend', result: 'pass' });
          expect(unit.fixRounds + unit.freshAgents).toBe(0);
        }
        if (reason === 'plan-unresolved') {
          const replans = s.planner.of('plan');
          expect(replans).toHaveLength(3);
          expect(replans[2]!.userPrompt).toContain("## The owner's instruction");
          expect(replans[2]!.userPrompt).toContain(TEXTS.amend);
        }
        if (reason === 'writing-unclear') expect(done.shape?.forbids_writing).toMatchObject({ verdict: 'yes', outcome: 'act' });
        if (reason === 'attempts-undecided') expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a1');
      }, 25_000);
    });
  }

  test('a reading below act is asked again, whatever it leans to', async () => {
    const amended = { value: false };
    await reach({
      plan: oneUnitPlan(1),
      contract: { stallLimit: 2 },
      planner: stepPlanner(oneUnitPlan(1)),
      amended,
      scripts: { u1: keepsFailing(3) },
      port: answers(routeAnswer('owner'), replyAnswers([{ reading: 'approve', confidence: 0.8 }])),
    }, 'stalled');
    const contractId = harness!.store.list()[0]!.id;
    const outcome = await harness!.runner.reply(contractId, contractOf(harness!, contractId).escalations[0]!.id, 'sure, I guess');
    expect(outcome).toMatchObject({ reading: 'approve', outcome: 'confirm', action: 'asked-again' });
  }, 25_000);

  test('an attempt asked for by position is read and taken', async () => {
    const s = await SETUPS['attempts-undecided']('amend');
    const outcome = await s.reply('Take the second one.');
    if (outcome.action !== 'amended') {
      const contract = contractOf(s.h, s.contractId);
      console.error('owner reply refusal diagnostics', JSON.stringify({
        outcome,
        question: contract.escalations.at(-1)?.question,
        selection: contract.units[0]?.attemptSelection,
        attempts: contract.units[0]?.attemptUnits?.map(({ id, status, failureReason, checks }) => ({ id, status, failureReason, lastCheck: checks.at(-1) })),
        agents: s.h.manager.list().filter(({ contractUnitId }) => contractUnitId === 'u1#a1')
          .map(({ id, status, error, failureReason, fullOutput }) => ({ id, status, error, failureReason, fullOutput })),
        decisions: contract.decisions.filter(({ targetId }) => targetId === 'u1#a1'),
        events: s.h.events.filter((event) => 'unitId' in event && (event.unitId === 'u1' || event.unitId === 'u1#a1')),
      }, null, 2));
    }
    expect(outcome.action).toBe('amended');
    await waitFor(() => terminal(s.h, s.contractId), 'the contract to end', 15_000);
    const done = contractOf(s.h, s.contractId);
    expect(done.units[0]!.attemptSelection?.pickedId).toBe('u1#a1');
    expect(done.decisions.find((decision) => decision.action === 'attempts-selected')?.reason).toContain('u1#a1 taken: the owner asked for this attempt');
  }, 25_000);

  test('a reply that asks for none of the attempts is asked which one to take', async () => {
    const s = await SETUPS['attempts-undecided']('amend');
    const outcome = await s.reply('Something else entirely.');
    expect(outcome.action).toBe('refused');
    const question = contractOf(s.h, s.contractId).escalations.at(-1)!.question;
    expect(question.endsWith(`\n${NAME_AN_ATTEMPT_LINE(['u1#a0', 'u1#a1'])}`)).toBe(true);
  }, 25_000);

  test('an uncertain writing observation proceeds without asking for approval', async () => {
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes('parser written') },
      port: context => context.name === 'forbids_writing' ? noulAnswer(0.5) : undefined });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'automatic planning to complete');
    expect(contractOf(h, contract.id).status).toBe('passed');
    expect(contractOf(h, contract.id).escalations).toEqual([]);
  });

  test.each([0.2, 0.5])('a criterion reading of %s does not manufacture an unshown approval question', async probability => {
    const h = makeHarness({ plan: oneUnitPlan(1), scripts: { u1: finishes(`[p=${probability}] parser written`) } });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'automatic evidence check to complete');
    expect(contractOf(h, contract.id).status).toBe('passed');
    expect(contractOf(h, contract.id).units[0]!.criteria[0]!.status).toBe('met');
    expect(contractOf(h, contract.id).escalations).toEqual([]);
  });

  test('a reply to an escalation that is not open is refused', async () => {
    const s = await SETUPS.stalled('unclear');
    await s.reply(TEXTS.unclear);
    const first = contractOf(s.h, s.contractId).escalations[0]!.id;
    await expect(s.h.runner.reply(s.contractId, first, 'again')).rejects.toThrow(`has no open escalation ${first}`);
  }, 25_000);
});

describe('an unsettled question names every reading approval would accept', () => {
  const clean = { verdict: 'no', outcome: 'act' } as const;
  test('an unshown goal and quality items that did not read clean are named; settled ones are not', () => {
    const note = unsettledReadingsNote({ goal: 'Parse CSV with quoted fields' }, {
      goal: { probabilityUnmet: 0.3, verdict: 'unshown', outcome: 'escalate' },
      quality: { placeholder: clean, tests_weakened: { verdict: 'no', outcome: 'confirm' }, hidden_failure: { verdict: 'uncertain', outcome: 'escalate' } },
    });
    expect(note).toBe([
      'Not shown for the unit as a whole: that it does what it is for (Parse CSV with quoted fields).',
      'Not shown about the quality of the work:',
      `- ${QUALITY_EVIDENCE_SENTENCES.tests_weakened}`,
      `- ${QUALITY_EVIDENCE_SENTENCES.hidden_failure}`,
    ].join('\n'));
  });

  test('nothing is added when only criteria were unshown', () => {
    expect(unsettledReadingsNote({ goal: 'g' }, { goal: { probabilityUnmet: 0.05, verdict: 'met', outcome: 'act' }, quality: { placeholder: clean } })).toBeUndefined();
  });
});

describe('what an owner-approved plan names', () => {
  test('the plan-accepted decision names the plan readings the owner settled and the reply', async () => {
    const log = new SqliteDecisionLog(':memory:');
    let shapes = 0;
    const narrowsOnce = (context: AnswerContext): unknown => {
      if (!context.name.startsWith('narrows_') || unitTitleOf(context.state) === undefined) return undefined;
      shapes += 1;
      return noulAnswer(shapes <= 2 ? 0.97 : 0.03);
    };
    const h = makeHarness({
      plan: oneUnitPlan(1),
      contract: { planRepairLimit: 1 },
      planner: stepPlanner(oneUnitPlan(1)).runner,
      scripts: { u1: finishes('parser written') },
      port: answers(narrowsOnce, replyAnswers([{ reading: 'approve' }])),
      decisionLog: log,
    });
    harness = h;
    const { contract } = startContract(h);
    await waitFor(() => contractOf(h, contract.id).status === 'awaiting-owner', 'the plan escalation', 15_000);
    const escalation = contractOf(h, contract.id).escalations.at(-1)!;
    expect(escalation.decisionIds?.length).toBeGreaterThan(0);
    await h.runner.reply(contract.id, escalation.id, 'Yes, go ahead with that plan.');
    const accepted = contractOf(h, contract.id).decisions.find((decision) => decision.action === 'plan-accepted')!;
    const reply = contractOf(h, contract.id).escalations.at(-1)!.reply!;
    expect(accepted.decisionIds).toEqual(expect.arrayContaining([...escalation.decisionIds!, reply.decisionId!]));
    for (const id of accepted.decisionIds) expect(log.get(id)).toBeDefined();
    log[Symbol.dispose]();
  }, 20_000);
});
