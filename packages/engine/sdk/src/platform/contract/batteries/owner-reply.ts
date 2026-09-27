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
import { defineReplyReader, STAKES_BANDS } from '@goodvibes-jev/judgment';

const UNSETTLED = {
  reason: 'unsettled',
  question: [
    'Contract ctr-1a2b3c4d needs your decision on unit "CSV parser".',
    'The checks could not confirm some criteria from the evidence, and the agent could not show more.',
    'Not shown:',
    '- [u1.c2] parseCsv handles quoted fields that contain commas',
    'Reply to approve accepting the unshown criteria as met, to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const STALLED = {
  reason: 'stalled',
  question: [
    'Contract ctr-5e6f7a8b needs your decision on unit "Refunds".',
    'The work stopped making progress and the remaining problems need you.',
    'Still not met:',
    '- [u4.c2] The refund integration test passes against the provider sandbox (major)',
    'Reply to approve (approval cannot pass unmet criteria: say what to change instead), to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const PLAN = {
  reason: 'plan-unresolved',
  question: [
    'Contract ctr-9c0d1e2f needs your decision on plan "Export the monthly report in three formats".',
    'The planner could not resolve these problems within its repair limit.',
    'Problems:',
    '- [narrows u2] Unit u2 ("XML writer") does less than the criteria it serves require.',
    'Reply to approve accepting the plan as it stands, to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

const WRITING = {
  reason: 'writing-unclear',
  question: [
    'Contract ctr-3a4b5c6d needs your decision on the request "Look into why the nightly import is slow".',
    'Your request does not make clear whether the work may change files.',
    'Reply to approve changing files, to change what is required (say how, for example that nothing may be changed), or to stop the contract.',
  ].join('\n'),
};

const DELIVERABLE = {
  reason: 'fix-rounds-exhausted',
  question: [
    'Contract ctr-7e8f9a0b needs your decision on the deliverable "A convert command that reads CSV and writes JSON".',
    'The fix rounds allowed for this work are used up.',
    'Still not met:',
    '- [c2] convert exits with status 1 and an error message when the input file does not exist (major)',
    'Reply to approve (approval cannot pass unmet criteria: say what to change instead), to change what is required (say how), or to stop the contract.',
  ].join('\n'),
};

export const ownerReply = defineReplyReader({
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
  ],
});
