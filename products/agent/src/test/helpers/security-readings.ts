// Agent-local synthetic test fixture, retained from current public engine test fixture.
// Uses only public workspace APIs; this is not production judgment behavior.
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
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
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
  return fakePort((name: string, _question: unknown, state: EntryType) => {
    switch (name) {
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
