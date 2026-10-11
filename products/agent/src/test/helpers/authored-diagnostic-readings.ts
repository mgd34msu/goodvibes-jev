import type { EntryType, Question } from '@goodvibes-jev/judgment/decisions';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { fieldKind, redactionCredential, residualCredential } from '@goodvibes-jev/engine/sdk/platform/utils';

type RedactionPart = { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'span'; readonly reference: string; readonly syntax: 'assignment-value'; readonly field: string };

const offeredQuestions: Readonly<Record<string, Question>> = {
  kind: fieldKind.items.kind.question,
  lineHasCredential: redactionCredential.items.lineHasCredential.question,
  spanIsCredential: redactionCredential.items.spanIsCredential.question,
  credentialRemains: residualCredential.items.credentialRemains.question,
};

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
    const offered = offeredQuestions[name];
    if (offered !== undefined && JSON.stringify(question) !== JSON.stringify(offered))
      throw new Error('Unexpected authored diagnostic question schema');
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
