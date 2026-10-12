/** Protected semantic style extraction and draft-only reply composition. */
import type { SecretLikeTextPredicate } from '../google/account-registry.js';
import type { EmailSummary } from './email-service.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { readStyleFrequency, readStyleSenderName, readStyleSentenceCount, readStyleTone, StyleReplyReadingError, withEmailStyleSource, type StyleReplyReadingOptions } from './style-reply-readings.js';
export { StyleReplyReadingError } from './style-reply-readings.js';
export type { StyleReplyReadingOptions } from './style-reply-readings.js';

// ---------------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------------

export type StyleReplyMessage = Pick<EmailSummary, 'from' | 'subject' | 'bodyPreview'>;
export type StyleSentMessage = Pick<EmailSummary, 'bodyPreview'>;

export interface StyleProfile {
  /** Most common greeting prefix found in sent messages, e.g. 'Hi', 'Hello', 'Hey'. */
  readonly greeting: string;
  /** Most common sign-off found in sent messages, e.g. 'Thanks', 'Best', 'Cheers'. */
  readonly signOff: string;
  /** Median sentence count across sent messages (whole number, ≥1). */
  readonly medianSentenceCount: number;
  /** Dominant tone established by the corpus reading: 'formal' | 'casual' | 'neutral'. */
  readonly tone: 'formal' | 'casual' | 'neutral';
  /** True when the corpus is empty, all values are defaults. */
  readonly isDefault: boolean;
}

/** Greeting tokens in priority order (most → least common in business email). */
const GREETING_TOKENS: readonly string[] = [
  'Hi', 'Hello', 'Hey', 'Dear', 'Greetings', 'Good morning', 'Good afternoon',
];

/**
 * Sign-off tokens in offered tie order. Semantic readings establish the actual closing phrase;
 * a substring in the body does not count as a sign-off.
 */
const SIGN_OFF_TOKENS: readonly string[] = [
  'Kind regards', 'Best regards', 'All the best', 'Thank you', 'Thanks',
  'Sincerely', 'Take care', 'Cheers', 'Regards', 'Best',
];

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireStrings(value: unknown): void {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new StyleReplyReadingError();
}
function requireSentMessages(value: unknown): void {
  if (!Array.isArray(value) || !value.every(item => record(item) && typeof item.bodyPreview === 'string')) throw new StyleReplyReadingError();
}
function requireDraftInput(inbound: unknown, profile: unknown, context: unknown): void {
  if (!record(inbound) || typeof inbound.from !== 'string' || typeof inbound.subject !== 'string' || typeof inbound.bodyPreview !== 'string'
    || !record(profile) || typeof profile.greeting !== 'string' || typeof profile.signOff !== 'string'
    || typeof profile.medianSentenceCount !== 'number' || !Number.isSafeInteger(profile.medianSentenceCount) || profile.medianSentenceCount < 1
    || (profile.tone !== 'formal' && profile.tone !== 'casual' && profile.tone !== 'neutral') || typeof profile.isDefault !== 'boolean'
    || typeof context !== 'string') throw new StyleReplyReadingError();
}

/** Code counts only settled, acting sentence-boundary readings. */
export async function countSentences(text: string, options: StyleReplyReadingOptions = {}): Promise<number> {
  return withEmailStyleSource({ text }, options, source => { if (typeof source.text !== 'string') throw new StyleReplyReadingError(); return Boolean(source.text.trim()); }, async (source, readings) => {
    if (!source.text.trim()) return 0;
    if (!readings) throw new StyleReplyReadingError();
    return readStyleSentenceCount(source.text, readings);
  });
}

/**
 * Compute the median of a sorted number array.
 * Returns `fallback` when the array is empty.
 */
export function median(sorted: readonly number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round(((sorted[mid - 1]!) + (sorted[mid]!)) / 2);
}

/** Count actual phrase use per message. Offered order breaks settled ties. */
export async function mostFrequent(
  corpus: readonly string[], candidates: readonly string[], fallback: string,
  options: StyleReplyReadingOptions = {},
): Promise<string> {
  return withEmailStyleSource({ corpus, candidates, fallback }, options, source => { requireStrings(source.corpus); requireStrings(source.candidates); if (typeof source.fallback !== 'string') throw new StyleReplyReadingError(); return source.corpus.length > 0 || source.candidates.length > 0 || source.fallback.length > 0; }, async (source, readings) => {
    if (!source.corpus.length || !source.candidates.length) return source.fallback;
    if (!readings) throw new StyleReplyReadingError();
    return readStyleFrequency(source.corpus, source.candidates, source.fallback, 'phrase', readings);
  });
}

/** Read overall author voice, retaining the complete supplied corpus. */
export async function classifyTone(bodies: readonly string[], options: StyleReplyReadingOptions = {}): Promise<StyleProfile['tone']> {
  return withEmailStyleSource({ bodies }, options, source => { requireStrings(source.bodies); return source.bodies.length > 0; }, async (source, readings) => {
    if (!source.bodies.length) return 'neutral';
    if (!readings) throw new StyleReplyReadingError();
    return readStyleTone(source.bodies, readings);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read supplied sent messages; an actually empty corpus has explicit defaults. */
export async function extractStyleProfile(sentMessages: readonly StyleSentMessage[], options: StyleReplyReadingOptions = {}): Promise<StyleProfile> {
  return withEmailStyleSource({ sentMessages }, options, source => { requireSentMessages(source.sentMessages); return source.sentMessages.length > 0; }, async (source, readings) => {
    const bodies = source.sentMessages.map(message => message.bodyPreview).filter(body => body.length > 0);
    if (!bodies.length) return { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: source.sentMessages.length === 0 };
    if (!readings) throw new StyleReplyReadingError();
    const greeting = await readStyleFrequency(bodies, GREETING_TOKENS, 'Hi', 'greeting', readings);
    const signOff = await readStyleFrequency(bodies, SIGN_OFF_TOKENS, 'Thanks', 'signOff', readings);
    const sentenceCounts: number[] = [];
    for (const body of bodies) {
      const count = await readStyleSentenceCount(body, readings);
      if (count > 0) sentenceCounts.push(count);
    }
    sentenceCounts.sort((a, b) => a - b);
    const tone = await readStyleTone(bodies, readings);
    readings.assertCurrent();
    return { greeting, signOff, medianSentenceCount: Math.max(1, median(sentenceCounts, 3)), tone, isDefault: false };
  });
}

export interface DraftReplyResult {
  /** Fully composed draft body. Never includes credentials or secret-looking text. */
  readonly body: string;
  /** The style profile used to compose this draft. */
  readonly profile: StyleProfile;
  /** Subject line for the reply, prefixed with 'Re: ' if not already. */
  readonly subject: string;
  /** BEFORE-SEND REVIEW BOUNDARY: always true, this is a draft, never auto-sent. */
  readonly requiresBeforeSendReview: true;
  /** Human-readable reminder of the review boundary. */
  readonly reviewBoundary: string;
}

/** Compose a draft after protected name reading. This function has no delivery port. */
export async function composeDraftReply(
  inbound: StyleReplyMessage,
  profile: StyleProfile,
  context: string,
  containsSecretLikeText: SecretLikeTextPredicate,
  options: StyleReplyReadingOptions = {},
): Promise<DraftReplyResult> {
  return withEmailStyleSource({ inbound, profile, context }, options, source => { requireDraftInput(source.inbound, source.profile, source.context); return true; }, async (source, readings) => {
    const senderName = source.inbound.from.trim()
      ? await (readings ? readStyleSenderName(source.inbound.from, readings) : Promise.reject(new StyleReplyReadingError())) : '';
    const subjectLine = replySubject(source.inbound.subject);
    const usedInbound = source.inbound;
    const usedContext = source.context;
    const usedProfile = source.profile;

    // Build body paragraphs scaled to the user's median sentence count.
    // The settled corpus median controls only the fixed placeholder length.
    const lines: string[] = [];

    // Greeting
    lines.push(`${usedProfile.greeting}${senderName ? ` ${senderName}` : ''},`);
    lines.push('');

    // Acknowledgement sentence
    const acknowledgement = buildAcknowledgement(usedInbound, usedProfile.tone);
    lines.push(acknowledgement);

    // User-supplied context woven in as a separate paragraph
    if (usedContext.trim()) {
      lines.push('');
      lines.push(usedContext.trim());
    }

    // Filler sentences to approximate median length (when no context provided
    // and the profile expects more sentences than the acknowledgement alone)
    if (!usedContext.trim() && usedProfile.medianSentenceCount > 2) {
      lines.push('');
      lines.push(buildPlaceholderBody(usedProfile.medianSentenceCount - 1, usedProfile.tone));
    }

    // Sign-off
    lines.push('');
    lines.push(`${usedProfile.signOff},`);

    const body = lines.join('\n');

    assertJudgmentInput({ body, subject: subjectLine, profile: usedProfile });
    // Assert no secret-like text in the composed output
    if (containsSecretLikeText(body)) {
      throw new StyleReplyReadingError();
    }

    readings?.assertCurrent();
    return {
      body,
      profile: usedProfile,
      subject: subjectLine,
      requiresBeforeSendReview: true,
      reviewBoundary:
        'This is a DRAFT only. Review the content before sending. ' +
        'Sending requires confirm:true on the email send path (SMTP or connector) ' +
        'with explicit user confirmation of recipients and body.',
    };
  }, source => {
    const visit = (value: unknown): void => {
      if (typeof value === 'string' && containsSecretLikeText(value)) throw new StyleReplyReadingError();
      if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
    };
    visit(source);
  });
}

// ---------------------------------------------------------------------------
// Internal composition helpers
// ---------------------------------------------------------------------------

/** Select an exact supported personal-name span; bare local parts do not establish names. */
export async function extractSenderName(from: string, options: StyleReplyReadingOptions = {}): Promise<string> {
  return withEmailStyleSource({ from }, options, source => { if (typeof source.from !== 'string') throw new StyleReplyReadingError(); return Boolean(source.from.trim()); }, async (source, readings) => {
    if (!source.from.trim()) return '';
    if (!readings) throw new StyleReplyReadingError();
    return readStyleSenderName(source.from, readings);
  });
}

/** Ensure subject is prefixed with 'Re: ' exactly once. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re:\s*/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/** Build a natural acknowledgement sentence adapted to tone. */
function buildAcknowledgement(inbound: StyleReplyMessage, tone: StyleProfile['tone']): string {
  const subject = inbound.subject.trim();
  switch (tone) {
    case 'formal':
      return subject
        ? `Thank you for your message regarding "${subject}".`
        : 'Thank you for reaching out.';
    case 'casual':
      return subject
        ? `Thanks for your message about "${subject}"!`
        : 'Thanks for reaching out!';
    default:
      return subject
        ? `Thanks for your message about "${subject}".`
        : 'Thanks for reaching out.';
  }
}

/**
 * Build placeholder body sentences to approximate target sentence count.
 * Returns one paragraph with `targetCount` filler sentences.
 * Deterministic, no randomness.
 */
function buildPlaceholderBody(targetCount: number, tone: StyleProfile['tone']): string {
  const formalSentences = [
    'I have reviewed the relevant details and will follow up accordingly.',
    'Please let me know if you require any further information.',
    'I will ensure this is addressed in a timely manner.',
    'Kindly advise if you would like to discuss this further.',
  ];
  const casualSentences = [
    'Let me know if you have any questions.',
    'Happy to chat more about this if helpful.',
    'Feel free to reach out if anything else comes up.',
    'Let me know what works best for you.',
  ];
  const neutralSentences = [
    'Let me know if you need anything else.',
    'Happy to discuss further if useful.',
    'Please let me know if you have any questions.',
    'Looking forward to hearing from you.',
  ];

  const pool = tone === 'formal' ? formalSentences : tone === 'casual' ? casualSentences : neutralSentences;
  // Take up to targetCount sentences from the pool (cycle if needed)
  const sentences: string[] = [];
  for (let i = 0; i < Math.min(targetCount, 4); i++) {
    sentences.push(pool[i % pool.length]!);
  }
  return sentences.join(' ');
}
