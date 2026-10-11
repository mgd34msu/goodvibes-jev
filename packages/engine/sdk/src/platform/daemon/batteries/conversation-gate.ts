/** Canonical work-start readings. Authority, routing and expiry remain host-owned. */
import { defineReplyReader } from '@goodvibes-jev/judgment';

export const inboundIntent = defineReplyReader({
  name: 'engine.daemon.inbound-intent', version: 1,
  description: 'Whether the complete authorized inbound message requests work or a conversational response.',
  accuracyFloor: 0.95,
  readings: {
    work: 'Asks the assistant to carry out work, including indirect requests. Read the complete message, negation, quotation, and corrections. Mere mentions of work or code are not requests.',
    conversation: 'Conversation, greeting, informational question, status inquiry, or discussion of work without asking the assistant to carry it out.',
  },
  band: { actAt: 0.95, confirmAt: 0.95 },
  fixtures: [
    { name: 'bare testing', proposal: null, reply: 'Testing', expect: 'conversation' },
    { name: 'imperative', proposal: null, reply: 'Fix the login bug', expect: 'work' },
    { name: 'negated work', proposal: null, reply: 'Do not fix src/login.ts; just explain it.', expect: 'conversation' },
    { name: 'indirect request', proposal: null, reply: 'The login bug needs your attention. Please take care of it.', expect: 'work' },
    { name: 'quoted instruction', proposal: null, reply: 'What does "deploy production" mean?', expect: 'conversation' },
  ],
});

const proposal = { task: 'Fix the login bug', summary: 'Fix the login bug' };
export const workProposalReply = defineReplyReader({
  name: 'engine.daemon.work-proposal-reply', version: 1,
  description: 'Read the complete owner reply against the exact delivered pending work proposal.',
  accuracyFloor: 0.95,
  readings: {
    approve: 'Unconditionally asks to start this exact proposed work. Read final meaning including corrections and negation, not the first word.',
    steer: 'Asks to start this same work now with narrower scope or implementation guidance. Does not replace the task, add unrelated work, defer its start, or remove safety or permission boundaries. The complete reply will accompany the work as direction.',
    reject: 'Refuses, cancels, retracts permission for, or asks not to start this work.',
    message: 'Unrelated conversation, a new or replacement request, a question, a conditional future authorization, or an ambiguous/conflicting answer. Does not authorize this proposal.',
  },
  band: { actAt: 0.95, confirmAt: 0.95 },
  fixtures: [
    { name: 'assent', proposal, reply: 'Yes, start it.', expect: 'approve' },
    { name: 'contrary negative opener', proposal, reply: 'No problem, go ahead with the login fix.', expect: 'approve' },
    { name: 'retracted assent', proposal, reply: 'Yes, actually no. Do not start.', expect: 'reject' },
    { name: 'scope narrowing', proposal, reply: 'Yes, but only change the login adapter.', expect: 'steer' },
    { name: 'different job', proposal, reply: 'Please refactor the database instead.', expect: 'message' },
    { name: 'extra job', proposal, reply: 'Yes and also rewrite the payment system.', expect: 'message' },
    { name: 'future condition', proposal, reply: 'Yes, but only after I confirm tomorrow.', expect: 'message' },
    { name: 'refusal', proposal, reply: 'Leave this alone.', expect: 'reject' },
  ],
});
