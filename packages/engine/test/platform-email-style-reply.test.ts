/**
 * Tests for the writing-style-matched draft reply composer and lane descriptor.
 *
 * Recorded semantic answers run against the real protected loopback source owner. No external mail or provider service is contacted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { taskRouteSourceFixture } from './_helpers/task-route-source.ts';
import {
  testContainsSecretLikeText,
  testDescribeSenderClaim,
} from './_helpers/platform-email-fixtures.ts';
import type { EmailSummary } from '../sdk/src/platform/email/email-service.ts';
import {
  classifyTone as nativeClassifyTone,
  composeDraftReply as nativeComposeDraftReply,
  countSentences as nativeCountSentences,
  extractSenderName as nativeExtractSenderName,
  extractStyleProfile as nativeExtractStyleProfile,
  median,
  mostFrequent as nativeMostFrequent,
  replySubject,
  StyleReplyReadingError,
  type StyleProfile,
} from '../sdk/src/platform/email/style-reply.ts';
import {
  buildStyleReplyLaneAdditions,
  styleReplyLiveRecord,
  styleReplyWorkflow,
  styleReplyWorkflowStatus,
} from '../sdk/src/platform/email/style-reply-lane.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<EmailSummary> = {}): EmailSummary {
  return {
    uid: 1,
    messageId: '<test-message-1@example.com>',
    from: 'sender@example.com',
    subject: 'Test subject',
    date: '2024-01-01T10:00:00Z',
    unread: true,
    bodyPreview: '',
    mailbox: 'INBOX',
    deliveredTo: [],
    unverifiedToHeaderClaim: '',
    senderClaim: testDescribeSenderClaim('sender@example.com'),
    ...overrides,
  };
}


let source: ReturnType<typeof taskRouteSourceFixture>;
let prior: ReturnType<typeof installJudgmentPort>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected style fixture shape');
  return Object.fromEntries(Object.entries(value));
}
interface MessageFact { readonly body: string; readonly phrases: readonly string[]; readonly greeting: string; readonly signOff: string; readonly sentences: readonly string[]; readonly tone: StyleProfile['tone']; }
const facts: readonly MessageFact[] = [
  { body: 'Hello there', phrases: [], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'no punctuation here', phrases: [], greeting: '', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'First sentence. Second sentence. Third sentence.', phrases: [], greeting: '', signOff: '', sentences: ['First sentence.', 'Second sentence.', 'Third sentence.'], tone: 'neutral' },
  { body: 'Great! Sounds good! Talk soon.', phrases: [], greeting: '', signOff: '', sentences: ['Great!', 'Sounds good!', 'Talk soon.'], tone: 'casual' },
  { body: 'How are you? Are you free? Let me know.', phrases: [], greeting: '', signOff: '', sentences: ['How are you?', 'Are you free?', 'Let me know.'], tone: 'neutral' },
  { body: 'Hi there, hope you are well', phrases: ['Hi'], greeting: 'Hi', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Hi Alice,', phrases: ['Hi'], greeting: 'Hi', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Hello Bob,', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Good morning team', phrases: [], greeting: 'Good morning', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'HELLO everyone', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'hello again', phrases: ['Hello'], greeting: 'Hello', signOff: '', sentences: [], tone: 'neutral' },
  { body: 'Please kindly review the attached document.', phrases: [], greeting: '', signOff: '', sentences: ['Please kindly review the attached document.'], tone: 'formal' },
  { body: 'I am writing pursuant to our previous discussion.', phrases: [], greeting: '', signOff: '', sentences: ['I am writing pursuant to our previous discussion.'], tone: 'formal' },
  { body: 'Regards, sincerely yours.', phrases: [], greeting: '', signOff: 'Regards', sentences: [], tone: 'formal' },
  { body: 'Hey, sounds good! No worries about the delay.', phrases: [], greeting: 'Hey', signOff: '', sentences: ['Hey, sounds good!', 'No worries about the delay.'], tone: 'casual' },
  { body: 'Yeah, cheers! Chat soon.', phrases: [], greeting: '', signOff: '', sentences: ['Yeah, cheers!', 'Chat soon.'], tone: 'casual' },
  { body: 'Thank you for your time', phrases: [], greeting: '', signOff: '', sentences: ['Thank you for your time'], tone: 'neutral' },
  { body: 'Hey Bob,\nJust checking in.\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Just checking in.'], tone: 'casual' },
  { body: 'Hey Carol,\nSounds good!\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Sounds good!'], tone: 'casual' },
  { body: 'Hey Dave,\nLet me know.\nCheers', phrases: [], greeting: 'Hey', signOff: 'Cheers', sentences: ['Let me know.'], tone: 'casual' },
  { body: 'Dear Alice,\nPlease see the attached.\nKind regards', phrases: [], greeting: 'Dear', signOff: 'Kind regards', sentences: ['Please see the attached.'], tone: 'formal' },
  { body: 'Dear Bob,\nKindly review the document.\nKind regards', phrases: [], greeting: 'Dear', signOff: 'Kind regards', sentences: ['Kindly review the document.'], tone: 'formal' },
  { body: 'Hi,\nOne sentence.\nThanks', phrases: [], greeting: 'Hi', signOff: 'Thanks', sentences: ['One sentence.'], tone: 'neutral' },
  { body: 'Dear Ms Smith,\nPlease kindly review the enclosed document pursuant to our agreement.\nSincerely', phrases: [], greeting: 'Dear', signOff: 'Sincerely', sentences: ['Please kindly review the enclosed document pursuant to our agreement.'], tone: 'formal' },
];
const names = new Map<string, string>([
  ['Alice Smith <alice@example.com>', 'Alice'], ['"Carol Jones" <carol@example.com>', 'Carol'],
  ['bob@example.com', ''], ['dave@example.com', ''], ['noreply@example.com', ''],
]);
const offeredPhrases = new Set(['Hi', 'Hello', 'Hey', 'Dear', 'Greetings', 'Good morning', 'Good afternoon', 'Kind regards', 'Best regards', 'All the best', 'Thank you', 'Thanks', 'Sincerely', 'Take care', 'Cheers', 'Regards', 'Best', 'Yo']);
function messageFact(body: unknown): MessageFact {
  const fact = facts.find(fact => fact.body === body);
  if (!fact) throw new Error('Unmapped complete style fixture body');
  return fact;
}
function recordedStyles() {
  return fakePort((name, question, value) => {
    const state = object(value);
    if (Object.keys(state).join() === 'items' && Array.isArray(state.items) && /^item_\d+$/.test(name) && question.type === 'noul') {
      const item = object(state.items[Number(name.slice(5))]);
      if (typeof item.body === 'string') {
        const fact = messageFact(item.body);
        if (typeof item.candidate !== 'string' || !offeredPhrases.has(item.candidate)) throw new Error('Unmapped offered style phrase');
        const yes = item.purpose === 'phrase' ? fact.phrases.includes(item.candidate)
          : item.purpose === 'greeting' ? fact.greeting === item.candidate
          : item.purpose === 'signOff' ? fact.signOff === item.candidate : undefined;
        if (yes === undefined) throw new Error('Unmapped style phrase role');
        return noulAnswer(yes ? 0.999 : 0.001);
      }
      const document = object(state.items[0]).document, fact = messageFact(document);
      if (typeof document !== 'string' || typeof item.position !== 'number') throw new Error('Malformed sentence candidate');
      const ends = fact.sentences.map(sentence => document.indexOf(sentence) + sentence.length);
      return noulAnswer(ends.includes(item.position) ? 0.999 : 0.001);
    }
    if (Object.keys(state).join() === 'bodies' && Array.isArray(state.bodies) && name === 'tone' && question.type === 'choice') {
      const tones = state.bodies.map(body => messageFact(body).tone);
      const tone = tones[0];
      if (!tone || !tones.every(value => value === tone)) throw new Error('Unmapped exact corpus tone');
      return choiceAnswer(question, tone, 0.999);
    }
    if (Object.keys(state).join() === 'context,candidates' && Array.isArray(state.candidates)) {
      const from = object(state.context).from;
      if (typeof from !== 'string' || !names.has(from)) throw new Error('Unmapped complete From header');
      const expected = names.get(from);
      const candidates = state.candidates.map(object), selected = candidates.find(candidate => object(candidate.content).text === expected);
      const chosen = selected?.id ?? 'none';
      if (name === 'pick' && question.type === 'choice' && typeof chosen === 'string') return choiceAnswer(question, chosen, 0.999);
      if (/^fits_\d+$/.test(name) && question.type === 'noul') return noulAnswer(object(candidates[Number(name.slice(5))]).id === chosen ? 0.999 : 0.001);
    }
    throw new Error('Unknown complete style fixture request');
  });
}
beforeEach(() => { source = taskRouteSourceFixture(); prior = installJudgmentPort(recordedStyles().port); });
afterEach(async () => { installJudgmentPort(prior); await source.close(); });
const options = () => ({ sourceOwner: source.owner });
const countSentences = (text: string) => nativeCountSentences(text, options());
const mostFrequent = (corpus: readonly string[], candidates: readonly string[], fallback: string) => nativeMostFrequent(corpus, candidates, fallback, options());
const classifyTone = (bodies: readonly string[]) => nativeClassifyTone(bodies, options());
const extractSenderName = (from: string) => nativeExtractSenderName(from, options());
const extractStyleProfile = (messages: readonly EmailSummary[]) => nativeExtractStyleProfile(messages, options());
const composeDraftReply = (inbound: EmailSummary, profile: StyleProfile, context: string, predicate: Parameters<typeof nativeComposeDraftReply>[3]) => nativeComposeDraftReply(inbound, profile, context, predicate, options());

// ---------------------------------------------------------------------------
// countSentences
// ---------------------------------------------------------------------------

describe('countSentences', () => {
  it('returns 0 for empty string', async () => {
    expect(await countSentences('')).toBe(0);
  });

  it('does not count a greeting fragment as a full sentence', async () => {
    expect(await countSentences('Hello there')).toBe(0);
  });

  it('counts multiple sentences separated by period-space', async () => {
    expect(await countSentences('First sentence. Second sentence. Third sentence.')).toBe(3);
  });

  it('counts sentences ending with exclamation marks', async () => {
    expect(await countSentences('Great! Sounds good! Talk soon.')).toBe(3);
  });

  it('counts sentences ending with question marks', async () => {
    expect(await countSentences('How are you? Are you free? Let me know.')).toBe(3);
  });

  it('does not invent a sentence from a nonempty fragment', async () => {
    expect(await countSentences('no punctuation here')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe('median', () => {
  it('returns fallback for empty array',  () => {
    expect(median([], 5)).toBe(5);
  });

  it('returns the single element for a one-element array',  () => {
    expect(median([7], 0)).toBe(7);
  });

  it('returns the middle element for odd-length array',  () => {
    expect(median([1, 3, 5], 0)).toBe(3);
  });

  it('returns rounded average of two midpoints for even-length array',  () => {
    expect(median([2, 4], 0)).toBe(3);
  });

  it('handles larger sorted arrays',  () => {
    expect(median([1, 2, 3, 4, 5, 6], 0)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// mostFrequent
// ---------------------------------------------------------------------------

describe('mostFrequent', () => {
  it('returns fallback when corpus is empty', async () => {
    expect(await mostFrequent([], ['Hi', 'Hello'], 'Hey')).toBe('Hey');
  });

  it('returns the candidate that appears most in the corpus', async () => {
    const corpus = [
      'Hi there, hope you are well',
      'Hi Alice,',
      'Hello Bob,',
    ];
    expect(await mostFrequent(corpus, ['Hi', 'Hello', 'Hey'], 'Hey')).toBe('Hi');
  });

  it('returns fallback when no candidates appear in corpus', async () => {
    const corpus = ['Good morning team'];
    expect(await mostFrequent(corpus, ['Hey', 'Yo'], 'Hi')).toBe('Hi');
  });

  it('is case-insensitive', async () => {
    const corpus = ['HELLO everyone', 'hello again'];
    expect(await mostFrequent(corpus, ['Hello', 'Hi'], 'Hi')).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// classifyTone
// ---------------------------------------------------------------------------

describe('classifyTone', () => {
  it('returns neutral for empty corpus', async () => {
    expect(await classifyTone([])).toBe('neutral');
  });

  it('returns formal when formal tokens dominate', async () => {
    const bodies = [
      'Please kindly review the attached document.',
      'I am writing pursuant to our previous discussion.',
      'Regards, sincerely yours.',
    ];
    expect(await classifyTone(bodies)).toBe('formal');
  });

  it('returns casual when casual tokens dominate', async () => {
    const bodies = [
      'Hey, sounds good! No worries about the delay.',
      'Yeah, cheers! Chat soon.',
    ];
    expect(await classifyTone(bodies)).toBe('casual');
  });

  it('returns neutral when balanced', async () => {
    // Deliberately crafted to have equal formal and casual hits (0 each)
    expect(await classifyTone(['Thank you for your time'])).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// extractSenderName
// ---------------------------------------------------------------------------

describe('extractSenderName', () => {
  it('extracts display name from "Name <email>" form', async () => {
    expect(await extractSenderName('Alice Smith <alice@example.com>')).toBe('Alice');
  });

  it('does not invent a personal name from a bare email address', async () => {
    expect(await extractSenderName('bob@example.com')).toBe('');
  });

  it('returns empty string when from is empty', async () => {
    expect(await extractSenderName('')).toBe('');
  });

  it('handles quoted display name', async () => {
    expect(await extractSenderName('"Carol Jones" <carol@example.com>')).toBe('Carol');
  });

  it('requires an explicit displayed personal name', async () => {
    expect(await extractSenderName('dave@example.com')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// replySubject
// ---------------------------------------------------------------------------

describe('replySubject', () => {
  it('prepends Re: when subject does not have it',  () => {
    expect(replySubject('Project update')).toBe('Re: Project update');
  });

  it('does not double-prefix when subject already starts with Re:',  () => {
    expect(replySubject('Re: Project update')).toBe('Re: Project update');
  });

  it('is case-insensitive for Re: prefix detection',  () => {
    expect(replySubject('RE: Important')).toBe('RE: Important');
  });

  it('trims leading/trailing whitespace before checking prefix',  () => {
    const result = replySubject('  Hello  ');
    expect(result).toBe('Re: Hello');
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile, empty corpus
// ---------------------------------------------------------------------------

describe('extractStyleProfile: empty corpus', () => {
  it('returns default profile when corpus is empty', async () => {
    const profile = await extractStyleProfile([]);
    expect(profile.isDefault).toBe(true);
    expect(profile.greeting).toBe('Hi');
    expect(profile.signOff).toBe('Thanks');
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
    expect(['formal', 'casual', 'neutral']).toContain(profile.tone);
  });
});

// ---------------------------------------------------------------------------
// extractStyleProfile, corpus with bodies
// ---------------------------------------------------------------------------

describe('extractStyleProfile: corpus with bodies', () => {
  it('detects casual greeting from corpus', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hey Bob,\nJust checking in.\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Carol,\nSounds good!\nCheers' }),
      makeSummary({ bodyPreview: 'Hey Dave,\nLet me know.\nCheers' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.greeting).toBe('Hey');
    expect(profile.isDefault).toBe(false);
  });

  it('detects formal sign-off from corpus', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Dear Alice,\nPlease see the attached.\nKind regards' }),
      makeSummary({ bodyPreview: 'Dear Bob,\nKindly review the document.\nKind regards' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.signOff).toBe('Kind regards');
  });

  it('sets medianSentenceCount >= 1', async () => {
    const sent = [
      makeSummary({ bodyPreview: 'Hi,\nOne sentence.\nThanks' }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.medianSentenceCount).toBeGreaterThanOrEqual(1);
  });

  it('classifies formal tone correctly', async () => {
    const sent = [
      makeSummary({
        bodyPreview:
          'Dear Ms Smith,\nPlease kindly review the enclosed document pursuant to our agreement.\nSincerely',
      }),
    ];
    const profile = await extractStyleProfile(sent);
    expect(profile.tone).toBe('formal');
  });

  it('ignores messages with empty bodyPreview', async () => {
    const sent = [
      makeSummary({ bodyPreview: '' }),
      makeSummary({ bodyPreview: '' }),
    ];
    // Falls back to defaults since no usable bodies
    const profile = await extractStyleProfile(sent);
    // Should not throw; greeting and signOff are still valid strings
    expect(typeof profile.greeting).toBe('string');
    expect(typeof profile.signOff).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// composeDraftReply
// ---------------------------------------------------------------------------

describe('composeDraftReply', () => {
  const inbound = makeSummary({
    from: 'Alice Smith <alice@example.com>',
    subject: 'Project update',
    bodyPreview: 'Hi, just checking in on the project status...',
  });
  const defaultProfile: StyleProfile = { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true };

  it('returns a draft with requiresBeforeSendReview = true', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.requiresBeforeSendReview).toBe(true);
  });

  it('subject is prefixed with Re:', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.subject).toMatch(/^Re:/i);
  });

  it('body includes greeting and sign-off', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain(defaultProfile.greeting);
    expect(result.body).toContain(defaultProfile.signOff);
  });

  it('body includes extracted sender first name', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toContain('Alice');
  });

  it('weaves context into the draft body', async () => {
    const result = await composeDraftReply(
      inbound,
      defaultProfile,
      'The milestone is on track and details follow Friday.',
      testContainsSecretLikeText,
    );
    expect(result.body).toContain('The milestone is on track');
  });

  it('reviewBoundary mentions confirm:true', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.reviewBoundary).toContain('confirm:true');
  });

  it('returns the profile used', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    expect(result.profile).toEqual(defaultProfile);
    expect(result.profile).not.toBe(defaultProfile);
  });

  it('throws when context contains secret-like text', async () => {
    await expect(composeDraftReply(inbound, defaultProfile, 'token: abc123secretpassword', testContainsSecretLikeText)).rejects.toBeInstanceOf(StyleReplyReadingError);
  });

  it('is deterministic: same inputs produce identical output', async () => {
    const a = await composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    const b = await composeDraftReply(inbound, defaultProfile, 'some context', testContainsSecretLikeText);
    expect(a.body).toBe(b.body);
    expect(a.subject).toBe(b.subject);
  });

  it('body does not contain secret-like text for normal inputs', async () => {
    const result = await composeDraftReply(inbound, defaultProfile, '', testContainsSecretLikeText);
    // Verify the body passes the assertNoSecretLikeText check indirectly
    // (no throw means it passed during composition)
    expect(result.body).toBeTruthy();
  });

  it('handles inbound with no sender name gracefully', async () => {
    const noName = makeSummary({ from: 'noreply@example.com', subject: 'Alert' });
    const result = await composeDraftReply(noName, defaultProfile, '', testContainsSecretLikeText);
    expect(result.body).toBeTruthy();
    expect(result.requiresBeforeSendReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// styleReplyWorkflowStatus
// ---------------------------------------------------------------------------

describe('styleReplyWorkflowStatus', () => {
  it('returns ready when protected reading capability is available',  () => {
    expect(styleReplyWorkflowStatus(true)).toBe('ready');
  });

  it('returns needs-setup when protected reading capability is absent',  () => {
    expect(styleReplyWorkflowStatus(false)).toBe('needs-setup');
  });
});

// ---------------------------------------------------------------------------
// styleReplyWorkflow
// ---------------------------------------------------------------------------

describe('styleReplyWorkflow', () => {
  it('has correct id',  () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.id).toBe('inbox-style-matched-draft-reply');
  });

  it('is ready when capability is available',  () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.status).toBe('ready');
  });

  it('is needs-setup when capability is absent',  () => {
    const wf = styleReplyWorkflow(false);
    expect(wf.status).toBe('needs-setup');
  });

  it('runBoundary names protected readings without a send',  () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.runBoundary.toLowerCase()).toContain('protected');
  });

  it('runBoundary mentions confirmed send',  () => {
    const wf = styleReplyWorkflow(true);
    expect(wf.runBoundary.toLowerCase()).toContain('confirmed');
  });

  it('is deterministic: same capability produces identical descriptor',  () => {
    const a = styleReplyWorkflow(true);
    const b = styleReplyWorkflow(true);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// styleReplyLiveRecord
// ---------------------------------------------------------------------------

describe('styleReplyLiveRecord', () => {
  it('has id inbox-style-reply-draft',  () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.id).toBe('inbox-style-reply-draft');
  });

  it('effect is read-only (local composition, no provider write)',  () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.effect).toBe('read-only');
  });

  it('confirmationRequired is false for local composition',  () => {
    const rec = styleReplyLiveRecord(true);
    expect(rec.confirmationRequired).toBe(false);
  });

  it('follow-up send route has confirmationRequired = true',  () => {
    const rec = styleReplyLiveRecord(true);
    const sendRoute = rec.followUpRoutes?.find((r) => r.id === 'send-after-review');
    expect(sendRoute).toBeDefined();
    expect(sendRoute!.requiresConfirmation).toBe(true);
  });

  it('follow-up send route effect is confirmed-effect',  () => {
    const rec = styleReplyLiveRecord(true);
    const sendRoute = rec.followUpRoutes?.find((r) => r.id === 'send-after-review');
    expect(sendRoute!.effect).toBe('confirmed-effect');
  });

  it('is needs-setup when capability absent',  () => {
    const rec = styleReplyLiveRecord(false);
    expect(rec.status).toBe('needs-setup');
  });
});

// ---------------------------------------------------------------------------
// buildStyleReplyLaneAdditions
// ---------------------------------------------------------------------------

describe('buildStyleReplyLaneAdditions', () => {
  it('returns both workflow and liveRecord',  () => {
    const additions = buildStyleReplyLaneAdditions(true);
    expect(additions.workflow).toBeDefined();
    expect(additions.liveRecord).toBeDefined();
  });

  it('workflow and liveRecord have consistent status',  () => {
    const additions = buildStyleReplyLaneAdditions(true);
    expect(additions.liveRecord.status).toBe(additions.workflow.status);
  });

  it('is deterministic: two calls with same arg produce equal results',  () => {
    const a = buildStyleReplyLaneAdditions(false);
    const b = buildStyleReplyLaneAdditions(false);
    expect(a).toEqual(b);
  });
});
