import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { ErrorClass } from '@goodvibes-jev/engine/sdk/platform/routing';
import { redactSensitiveDataAsync } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { isDeepStrictEqual } from 'node:util';

export interface PublicErrorTextReadings {
  readonly ordinaryFields?: readonly string[];
  readonly credentialProjections?: readonly EntryType[];
  readonly residualProjections?: readonly EntryType[];
}

/** Answers only the complete, authored public diagnostic projection. */
export function publicErrorTextAnswer(lines: readonly string[], name: string, question: Question, state: EntryType, readings: PublicErrorTextReadings = {}) {
  if (name === 'kind' && question.type === 'choice' && readings.ordinaryFields?.some(field => isDeepStrictEqual(state, { field }))) {
    return choiceAnswer(question, 'other', 0.99);
  }
  if (name === 'credentialRemains' && question.type === 'noul' && readings.residualProjections?.some(projection => isDeepStrictEqual(state, projection))) {
    return noulAnswer(0.01);
  }
  if (name !== 'lineHasCredential' && name !== 'spanIsCredential') return undefined;
  if (question.type === 'noul' && readings.credentialProjections?.some(projection => isDeepStrictEqual(state, projection))) return noulAnswer(0.01);
  if (question.type !== 'noul' || state === null || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).sort().join(',') !== 'parts,phase,target'
    || state.phase !== 'source' || state.target !== 'whole-line' || !Array.isArray(state.parts) || state.parts.length !== 1) {
    throw new Error('Unexpected public diagnostic credential projection');
  }
  const part = state.parts[0];
  if (part === null || typeof part !== 'object' || Array.isArray(part)
    || Object.keys(part).sort().join(',') !== 'kind,text' || part.kind !== 'text'
    || typeof part.text !== 'string' || !lines.includes(part.text)) {
    throw new Error('Unexpected public diagnostic source');
  }
  return noulAnswer(0.01);
}

/** The installed port and public redaction owner must prove each actual line. */
export async function preparePublicErrorText(lines: readonly string[]): Promise<void> {
  for (const line of lines) {
    if (await redactSensitiveDataAsync(line) !== line) throw new Error('Public diagnostic reading did not settle');
  }
}

export async function withPublicErrorText<T>(lines: readonly string[], run: () => T | Promise<T>, readings: PublicErrorTextReadings = {}): Promise<T> {
  const fake = fakePort((name, question, state) => {
    const answer = publicErrorTextAnswer(lines, name, question, state, readings);
    if (answer === undefined) throw new Error(`Unexpected public diagnostic question: ${name}`);
    return answer;
  });
  const previous = installJudgmentPort(fake.port);
  try {
    await preparePublicErrorText(lines);
    return await run();
  } finally {
    installJudgmentPort(previous);
  }
}

export function installUserErrorReading(kind: ErrorClass = 'generic', sessionEnded = false) {
  const { port } = fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question,
      name === 'failure__category' ? kind === 'auth' ? 'authentication' : kind === 'network' ? 'network' : 'unknown' : 'none', 0.99);
    const yes = (name === 'failure__rate_limited' && kind === 'rate-limit')
      || (name === 'failure__context_exceeded' && kind === 'context-overflow')
      || (name === 'failure__transient_network' && kind === 'network')
      || (name === 'user__session_ended' && sessionEnded);
    return noulAnswer(yes ? 0.99 : 0.01);
  });
  const previous = installJudgmentPort(port);
  return () => { installJudgmentPort(previous); };
}
export const flushErrorNotices = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
