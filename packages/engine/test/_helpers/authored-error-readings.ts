import type { EntryType, Question } from '@goodvibes-jev/judgment/decisions';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { failureState } from '@goodvibes-jev/engine/errors';
import type { RedactionPart } from '../../sdk/src/platform/utils/batteries/redaction.ts';
import type { FailureWordingReading } from './failure-readings.ts';
import { MAX_RETRY_WAIT_MESSAGE_CHARS, numberSpans } from '../../sdk/src/platform/types/batteries/retry-wait.ts';

export const errorText = (text: string): RedactionPart => ({ kind: 'text', text });
export const errorSpan = (field: string, number = 1): RedactionPart =>
  ({ kind: 'span', reference: `span-${number}`, syntax: 'assignment-value', field });

export interface AuthoredPrivacy {
  readonly parts: readonly (readonly RedactionPart[])[];
  readonly fields?: Readonly<Record<string, 'secret' | 'owner_profile' | 'content' | 'other'>>;
}

/** Only these complete, authored projections may release an ordinary fixture. */
export function authoredPrivacyAnswer(spec: AuthoredPrivacy) {
  const sources = new Set(spec.parts.flatMap((parts) => {
    const spans = parts.filter((part) => part.kind === 'span');
    return (spans.length > 0 ? spans.map((part) => part.reference) : ['whole-line'])
      .map((target) => JSON.stringify({ phase: 'source', parts, target }));
  }));
  const residuals = new Set(spec.parts.map((parts) => JSON.stringify({ parts: parts.map((part) =>
    part.kind === 'span' ? { kind: 'withheld', reference: part.reference } : part) })));
  return (name: string, question: Question, state: EntryType): unknown | undefined => {
    if (name === 'kind') {
      const entry = Object.entries(spec.fields ?? {}).find(([field]) => JSON.stringify(state) === JSON.stringify({ field }));
      if (!entry) throw new Error('Unspecified authored error field role');
      return choiceAnswer(question, entry[1], 0.99);
    }
    if (name === 'lineHasCredential' || name === 'spanIsCredential') {
      if (!sources.has(JSON.stringify(state))) throw new Error('Unspecified authored error source projection');
      return noulAnswer(0.01);
    }
    if (name === 'credentialRemains') {
      if (!residuals.has(JSON.stringify(state))) throw new Error('Unspecified authored error residual projection');
      return noulAnswer(0.01);
    }
    return undefined;
  };
}

export interface AuthoredFailure {
  readonly message: string;
  readonly status?: number;
  readonly errorName?: string;
  readonly code?: string;
  readonly reading: FailureWordingReading;
  readonly retryWait?: 'none';
}
const conclusions = {
  billing: 'billing', rate_limited: 'rateLimited', context_exceeded: 'contextExceeded',
  transient_network: 'transientNetwork', provider_unusable: 'providerUnusable', before_response: 'beforeResponse',
} satisfies Readonly<Record<string, keyof FailureWordingReading>>;

/** No default failure classification and no arbitrary negative privacy answers. */
export function authoredErrorReadingsPort(privacy: AuthoredPrivacy, fixtures: readonly AuthoredFailure[]) {
  const readPrivacy = authoredPrivacyAnswer(privacy);
  const states = new Map(fixtures.map((fixture) => [failureState(fixture), fixture.reading]));
  const retries = new Map(fixtures.filter((fixture) => fixture.retryWait === 'none').map((fixture) => {
    const message = fixture.message.slice(0, MAX_RETRY_WAIT_MESSAGE_CHARS), spans = numberSpans(message);
    return [JSON.stringify({ ...(fixture.status === undefined ? {} : { status: fixture.status }), message,
      numbers: Object.fromEntries(spans.map((span) => [span.id, { number: span.text, before: span.before, after: span.after }])) }),
    new Set(spans.map((span) => `fits_${span.id}`))] as const;
  }));
  return fakePort((name, question, state) => {
    const protectedAnswer = readPrivacy(name, question, state);
    if (protectedAnswer !== undefined) return protectedAnswer;
    const retry = retries.get(JSON.stringify(state));
    if (retry) {
      if (name === 'pick') return choiceAnswer(question, 'none', 0.99);
      if (name === 'unit') return choiceAnswer(question, 's', 0.99);
      if (retry.has(name)) return noulAnswer(0.01);
      throw new Error('Unexpected authored error retry question');
    }
    if (typeof state !== 'string' || !states.has(state)) throw new Error('Unspecified authored error failure state');
    const reading = states.get(state)!;
    if (name === 'category') return choiceAnswer(question, reading.category ?? 'unknown', 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, reading.connection ?? 'none', 0.99);
    const entry = Object.entries(conclusions).find(([key]) => key === name);
    if (!entry) throw new Error('Unexpected authored error failure question');
    return noulAnswer(reading[entry[1]] === true ? 0.99 : 0.01);
  });
}
