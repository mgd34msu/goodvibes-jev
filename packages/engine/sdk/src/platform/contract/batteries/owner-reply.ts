/**
 * `contract.owner-reply` (docs/design/contract-runner.md section 6.3): what
 * the owner's free-text reply to an escalation says. The reply pattern with
 * its default readings (approve, reject, amend, unclear), read against the
 * proposal `{ reason, question }`: the escalation's reason code and the
 * question it put, which states what approval does for that reason.
 *
 * Code decides what each reading does (escalation.ts). Approval can settle
 * unshown readings, a plan or a choice, never an unmet criterion.
 *
 * Band: approve triggers effects (work is accepted, a plan runs), so it is
 * read at high stakes; the other readings at medium.
 */
import { defineReplyReader, STAKES_BANDS, type ReplyReader, type ReplyReadingName } from '@goodvibes-jev/judgment';
import type { EscalationReason } from '../types.js';

/** An escalation as a reading sees it: its reason code and the question it put. */
type SampleEscalation = { readonly reason: EscalationReason; readonly question: string };

const UNSETTLED: SampleEscalation = {
  reason: 'unsettled',
  question: [
    'Contract ctr-1a2b3c4d needs your decision on unit "CSV parser".',
    'The checks could not confirm some criteria from the evidence, and the agent could not show more.',
    'Not shown:',
    '- [u1.c2] parseCsv handles quoted fields that contain commas',
    'Reply to approve accepting the unshown criteria as met, to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const STALLED: SampleEscalation = {
  reason: 'stalled',
  question: [
    'Contract ctr-5e6f7a8b needs your decision on unit "Refunds".',
    'The work stopped making progress and the remaining problems need you.',
    'Still not met:',
    '- [u4.c2] The refund integration test passes against the provider sandbox (major)',
    'Reply to approve (approval cannot pass unmet criteria: say what to change instead), to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const PLAN: SampleEscalation = {
  reason: 'plan-unresolved',
  question: [
    'Contract ctr-9c0d1e2f needs your decision on plan "Export the monthly report in three formats".',
    'The planner could not resolve these problems within its repair limit.',
    'Problems:',
    '- [narrows u2] Unit u2 ("XML writer") does less than the criteria it serves require.',
    'Reply to approve accepting the plan as it stands, to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const WRITING: SampleEscalation = {
  reason: 'writing-unclear',
  question: [
    'Contract ctr-3a4b5c6d needs your decision on the request "Look into why the nightly import is slow".',
    'Your request does not make clear whether the work may change files.',
    'Reply to approve changing files, to change what is required (say how, for example that nothing may be changed), or to stop the contract.',
  ].join('\n'),
};

const ATTEMPTS: SampleEscalation = {
  reason: 'attempts-undecided',
  question: [
    'Contract ctr-2b3c4d5e needs your decision on unit "formatBytes helper".',
    'The attempts could not be chosen between with confidence.',
    'Selection: chosen u1#a1 with confidence 0.78 (confirm); fits: u1#a0 no 0.35, u1#a1 yes 0.81',
    'Candidates:',
    '- u1#a0: Added formatBytes in src/bytes.ts.',
    '- u1#a1 (proposed): Added formatBytes in src/bytes.ts; 0 returns "0 B" and values past GB stay in GB.',
    'Reply to approve taking u1#a1, to name another attempt, or to stop the contract.',
  ].join('\n'),
};

const DECISION: SampleEscalation = {
  reason: 'owner-decision-needed',
  question: [
    'Contract ctr-6d7e8f9a needs your decision on unit "Invoice archiving".',
    'This needs a decision only you can make.',
    'Still not met:',
    '- [u2.c2] The retention period follows the company policy (major)',
    'Reply to approve (approval cannot pass unmet criteria: say what to change instead), to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const DELIVERABLE: SampleEscalation = {
  reason: 'fix-rounds-exhausted',
  question: [
    'Contract ctr-7e8f9a0b needs your decision on the deliverable "A convert command that reads CSV and writes JSON".',
    'The fix rounds allowed for this work are used up.',
    'Still not met:',
    '- [c2] convert exits with status 1 and an error message when the input file does not exist (major)',
    'Reply to approve (approval cannot pass unmet criteria: say what to change instead), to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

/** One sample escalation per reason, as escalation.ts words them: fixtures for the batteries that read replies and turns. */
export const SAMPLE_ESCALATIONS: Readonly<Record<EscalationReason, SampleEscalation>> = {
  unsettled: UNSETTLED,
  stalled: STALLED,
  'plan-unresolved': PLAN,
  'writing-unclear': WRITING,
  'attempts-undecided': ATTEMPTS,
  'owner-decision-needed': DECISION,
  'fix-rounds-exhausted': DELIVERABLE,
};

export const ownerReply: ReplyReader<ReplyReadingName> = defineReplyReader({
  name: 'contract.owner-reply',
  version: 1,
  description: "What the owner's reply to a contract escalation says: approve, change what is required, stop, or unclear.",
  accuracyFloor: 0.9,
  band: { ...STAKES_BANDS.medium.confidence, perOption: { approve: STAKES_BANDS.high.confidence } },
  fixtures: [
    { name: 'plain yes to unshown criteria', proposal: UNSETTLED, reply: "Yes, that's fine, accept it.", expect: 'approve' },
    { name: 'approve the plan as it stands', proposal: PLAN, reply: 'Approved. Go ahead with the plan as it is.', expect: 'approve' },
    { name: 'files may change', proposal: WRITING, reply: 'Go ahead, you can change whatever files you need to.', expect: 'approve' },
    { name: 'stop the contract', proposal: STALLED, reply: 'Stop. Cancel the whole thing, I will do it myself.', expect: 'reject' },
    { name: 'drop the plan', proposal: PLAN, reply: "No, don't run this at all. Abandon it.", expect: 'reject' },
    { name: 'no to the deliverable', proposal: DELIVERABLE, reply: 'Forget it, stop working on this.', expect: 'reject' },
    { name: 'relax a criterion', proposal: STALLED, reply: 'Skip the sandbox test; checking that refund() calls the endpoint is enough.', expect: 'amend' },
    { name: 'nothing may change', proposal: WRITING, reply: "Don't change anything, just write up what you find.", expect: 'amend' },
    { name: 'reword the requirement', proposal: DELIVERABLE, reply: 'Exit code 2 is fine for a missing file too, change that requirement to any non-zero exit.', expect: 'amend' },
    { name: 'a question back', proposal: UNSETTLED, reply: 'What does "not shown" mean here? Did the tests run?', expect: 'unclear' },
    { name: 'unrelated message', proposal: PLAN, reply: 'Also, can you remind me what time the standup is?', expect: 'unclear' },
    { name: 'noncommittal', proposal: STALLED, reply: 'Hmm, let me think about it.', expect: 'unclear' },
    { name: 'take the proposed attempt', proposal: ATTEMPTS, reply: 'Yes, take the proposed one.', expect: 'approve' },
    { name: 'name the other attempt', proposal: ATTEMPTS, reply: 'No, take u1#a0 instead.', expect: 'amend' },
    { name: 'take the first attempt by position', proposal: ATTEMPTS, reply: 'I prefer the first attempt, use that one.', expect: 'amend' },
    { name: 'stop instead of picking', proposal: ATTEMPTS, reply: 'Neither. Cancel the contract.', expect: 'reject' },
    { name: 'a question about the attempts', proposal: ATTEMPTS, reply: 'Which of the two is faster?', expect: 'unclear' },
    { name: 'approve on a decision', proposal: DECISION, reply: 'Approved, go ahead.', expect: 'approve' },
    { name: 'settle the policy question', proposal: DECISION, reply: 'The policy is 7 years; change the criterion to say invoices older than 7 years are archived.', expect: 'amend' },
    { name: 'drop the policy requirement', proposal: DECISION, reply: 'Remove the policy requirement, a 7 year period is fine as it is.', expect: 'amend' },
    { name: 'stop on a decision', proposal: DECISION, reply: "Stop the contract, we're not archiving invoices after all.", expect: 'reject' },
    { name: 'undecided on a decision', proposal: DECISION, reply: 'Let me check with finance and get back to you.', expect: 'unclear' },
  ],
});
