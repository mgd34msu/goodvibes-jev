/**
 * A fake judgment port for the security layer's readings, so tests of the
 * sites that ask them (content taint, card fields, card shapes, link
 * validation) run without a model.
 *
 * The default answers are stand-ins for what the model would say on the plain
 * cases tests use; they are not the rule the product follows, which is the
 * model's reading. A test that is about a specific answer overrides it.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { EntryType, JudgmentPort, JudgmentRequest, Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

/** A yes, a no, or a reading too unsure to act on. */
export type FakeVerdict = boolean | 'unsure';

export interface DerivationState {
  readonly field: string;
  readonly text: string;
  readonly source: { readonly surface: string; readonly origin: string; readonly text: string };
}

export interface CardFieldState {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
}

export interface LinkHostState {
  readonly host: string;
  readonly rendered: string;
  readonly registrableDomain: string;
  readonly authorizedDomain: string;
}

export interface SecurityAnswers {
  /** `reply` is true for the reply question, which leaves the quoted copy out. */
  readonly derives?: (state: DerivationState, reply: boolean) => FakeVerdict;
  readonly boilerplate?: (state: DerivationState) => FakeVerdict;
  readonly cardField?: (state: CardFieldState) => FakeVerdict;
  /** Sees the message with its digits masked as `#`. */
  readonly securityCode?: (masked: string) => FakeVerdict;
  readonly expiry?: (masked: string) => FakeVerdict;
  readonly lookalike?: (state: LinkHostState) => FakeVerdict;
  readonly shortener?: (state: LinkHostState) => FakeVerdict;
}

const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** The reply text a sender wrote: quoted lines and everything after an attribution line left out. */
function ownText(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*(original|forwarded)/i.test(line.trim())) break;
    kept.push(line);
  }
  return kept.join('\n');
}

/** Stand-in: the field repeats a 30 character run or a 12+ character token of the source. */
function sharesContent(field: string, source: string): boolean {
  const a = squash(field);
  const b = squash(source);
  for (const token of a.split(/[\s,;:"'()<>]+/)) {
    if (token.length >= 12 && b.includes(token)) return true;
  }
  for (let i = 0; i + 30 <= a.length; i += 1) {
    if (b.includes(a.slice(i, i + 30))) return true;
  }
  return false;
}

export const DEFAULT_SECURITY_ANSWERS: Required<SecurityAnswers> = {
  derives: (state, reply) => sharesContent(reply ? ownText(state.text) : state.text, state.source.text),
  boilerplate: () => false,
  cardField: (state) =>
    /card|cvv|cvc|csc|expir|holder|kreditkart|pruef|prüf/i.test([state.name, state.id, state.placeholder, state.ariaLabel, state.label].join(' ')),
  securityCode: (masked) => /cvv|cvc|csc|security code|card/i.test(masked),
  expiry: (masked) => /exp|card|valid/i.test(masked),
  lookalike: (state) => state.rendered.split('.').some((label) => /[a-z]/i.test(label) && /[^\x00-\x7f]/.test(label)),
  shortener: (state) => ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl'].includes(state.registrableDomain),
};

const probability = (verdict: FakeVerdict): number => (verdict === 'unsure' ? 0.5 : verdict ? 0.97 : 0.03);

/** A port answering the security batteries' questions; any other question is an error. */
export function securityPort(overrides: SecurityAnswers = {}): { port: JudgmentPort; requests: JudgmentRequest<Questions>[] } {
  const answers = { ...DEFAULT_SECURITY_ANSWERS, ...overrides };
  return fakePort((name, question, state) => {
    switch (name) {
      case 'kind': {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        if (typeof field !== 'string' || !Object.hasOwn(REDACTION_FIELD_FIXTURES, field)) throw new Error('securityPort: unknown redaction field fixture');
        return choiceAnswer(question, REDACTION_FIELD_FIXTURES[field]!, 0.99);
      }
      case 'identifying': {
        const field = state !== null && typeof state === 'object' && 'field' in state ? state.field : undefined;
        if (typeof field !== 'string' || !Object.hasOwn(PROFILE_ROLE_FIXTURES, field)) throw new Error('securityPort: unknown profile role fixture');
        return noulAnswer(PROFILE_ROLE_FIXTURES[field] ? 0.99 : 0.01);
      }
      case 'lineHasCredential':
      case 'spanIsCredential': return recordedCredentialProjection(state, name === 'spanIsCredential');
      case 'credentialRemains': return recordedCredentialProjection(state !== null && typeof state === 'object'
        ? { ...state, target: 'whole-line' } : state, false);
      case 'personLine': return noulAnswer(recordedProfilePerson(state) ? 0.99 : 0.01);
      case 'derives': return noulAnswer(probability(answers.derives(state as unknown as DerivationState, false)));
      case 'reply_derives': return noulAnswer(probability(answers.derives(state as unknown as DerivationState, true)));
      case 'boilerplate_only': return noulAnswer(probability(answers.boilerplate(state as unknown as DerivationState)));
      case 'card_field': return noulAnswer(probability(answers.cardField(state as unknown as CardFieldState)));
      case 'security_code': return noulAnswer(probability(answers.securityCode(state as string)));
      case 'expiry': return noulAnswer(probability(answers.expiry(state as string)));
      case 'lookalike': return noulAnswer(probability(answers.lookalike(state as unknown as LinkHostState)));
      case 'shortener': return noulAnswer(probability(answers.shortener(state as unknown as LinkHostState)));
      default: throw new Error(`securityPort: no fake answer for question "${name}"`);
    }
  });
}

const REDACTION_FIELD_FIXTURES: Readonly<Record<string, 'secret' | 'owner_profile' | 'content' | 'other'>> = {
  key: 'secret', KEY: 'secret', token: 'secret', password: 'secret', Authorization: 'secret', header: 'secret',
  shippingAddress: 'owner_profile', billing_address: 'owner_profile', quietHours: 'owner_profile',
  'identity.name': 'owner_profile',
  note: 'other', cmd: 'other', env: 'other', argv: 'other', answer: 'other', path: 'other',
  localhost: 'other', tokenCount: 'other', file: 'other', log: 'other', cwd: 'other', exists: 'other',
  lines: 'other', fields: 'other', proseLines: 'other', invalidFields: 'other', changes: 'other', error: 'content', agent: 'other',
};
const PROFILE_ROLE_FIXTURES: Readonly<Record<string, boolean>> = {
  'identity.name': true, 'contact.email': true, 'contact.phone': true, 'contact.agentAlias': true,
  'location.homeAddress': true, 'commerce.shippingAddress': true, 'commerce.billingAddress': true,
  'contactMe.quietHours': true, 'closed private profile prose': true,
  'commerce.currency': false, 'commerce.shippingTier': false, 'contactMe.channel': false,
  'preferences.units': false, 'preferences.dateFormat': false, 'defaults.approvalWindow': false,
};

/** Exact declared roles/context fixtures; opaque local values are absent. */
function recordedCredentialProjection(state: EntryType, targetOnly: boolean) {
  if (state === null || typeof state !== 'object' || !('parts' in state) || !Array.isArray(state.parts)
    || !('target' in state) || typeof state.target !== 'string') throw new Error('securityPort: unknown credential projection fixture');
  const live = state.parts.filter((part: unknown) => part !== null && typeof part === 'object' && 'kind' in part && part.kind === 'span');
  const selected = targetOnly && state.target !== 'whole-line' ? live.filter((part: unknown) => part !== null
    && typeof part === 'object' && 'reference' in part && part.reference === state.target) : live;
  for (const part of selected) {
    if (part !== null && typeof part === 'object' && 'field' in part && typeof part.field === 'string') {
      if (REDACTION_FIELD_FIXTURES[part.field] === 'secret') return noulAnswer(0.99);
      continue;
    }
    const text = state.parts.filter((part: unknown) => part !== null && typeof part === 'object' && 'kind' in part && part.kind === 'text')
      .map((part: unknown) => part !== null && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('');
    if (['token ', 'using key ', 'Bearer ', 'Authorization: Bearer '].includes(text)) return noulAnswer(0.99);
    return noulAnswer(0.5);
  }
  return noulAnswer(0.01);
}

/**
 * Installs a security port around every test in the calling file and puts
 * the previous port back afterwards. Returns the live request list.
 */
export function useSecurityReadings(overrides: SecurityAnswers = {}): { readonly requests: JudgmentRequest<Questions>[] } {
  const holder: { requests: JudgmentRequest<Questions>[] } = { requests: [] };
  let previous: JudgmentPort | undefined;
  beforeEach(() => {
    const fake = securityPort(overrides);
    holder.requests = fake.requests;
    previous = installJudgmentPort(fake.port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return {
    get requests() {
      return holder.requests;
    },
  };
}

/** Runs `body` with a security port installed, for a test that needs its own answers. */
export async function withSecurityReadings<T>(overrides: SecurityAnswers, body: (requests: JudgmentRequest<Questions>[]) => Promise<T>): Promise<T> {
  const fake = securityPort(overrides);
  const previous = installJudgmentPort(fake.port);
  try {
    return await body(fake.requests);
  } finally {
    installJudgmentPort(previous);
  }
}

/** Exact recorded People fixtures only, not a test-side semantic heuristic. */
function recordedProfilePerson(state: EntryType): boolean {
  const input = state as { name?: string; line?: string };
  const recorded: Readonly<Record<string, readonly string[]>> = {
    Sarah: [
      '- Sarah, sister, sarah@example.com', '- Sarah, sister',
      '- Sarah Whitfield, sister, sarah@example.com',
      '- Sarah, sister. She loves pottery.',
      '- Sarah is my sister. She has been doing pottery all year and loves it.',
    ],
    Dave: ['- Dave from work', '- Dave from work, handles the Pellux contracts'],
    Tom: ['- Tom, dentist'],
    'Natalie Sons': ['- Natalie Sons, my wife.'],
  };
  return (recorded[input.name ?? ''] ?? []).includes(input.line ?? '');
}
