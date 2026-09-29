/**
 * A fake judgment port for the failure-reading battery
 * (`@goodvibes-jev/engine/errors` failure-reading.ts), so tests of the error
 * predicates and error formatting never call the live Jev API.
 *
 * Each entry pairs a piece of error wording with what Jev is expected to read
 * in it. A request is answered by the first entry whose wording appears in the
 * request's `Message:` line; wording no entry names reads as category
 * `unknown`, connection failure `none`, with every yes/no question answered no. The readings are strong
 * (well past the low-stakes bands), so the battery acts on every one.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort, type ConnectionFailure, type FailureCategory } from '@goodvibes-jev/engine/errors';

export interface FailureWordingReading {
  readonly category?: FailureCategory;
  readonly billing?: boolean;
  readonly rateLimited?: boolean;
  readonly contextExceeded?: boolean;
  readonly transientNetwork?: boolean;
  readonly providerUnusable?: boolean;
  readonly beforeResponse?: boolean;
  readonly connection?: ConnectionFailure;
}

export type FailureWordingTable = ReadonlyArray<readonly [wording: string, reading: FailureWordingReading]>;

const YES_NO: Readonly<Record<string, keyof FailureWordingReading>> = {
  billing: 'billing',
  rate_limited: 'rateLimited',
  context_exceeded: 'contextExceeded',
  transient_network: 'transientNetwork',
  provider_unusable: 'providerUnusable',
  before_response: 'beforeResponse',
};

function messageOf(state: unknown): string {
  const text = typeof state === 'string' ? state : JSON.stringify(state);
  const at = text.indexOf('Message: ');
  return at === -1 ? text : text.slice(at + 'Message: '.length);
}

/** A port answering the failure battery from `table`, recording every request. */
export function failureReadingsPort(table: FailureWordingTable) {
  return fakePort((name: string, question: Question, state: unknown) => {
    const message = messageOf(state);
    const reading = table.find(([wording]) => message.includes(wording))?.[1] ?? {};
    if (name === 'category') return choiceAnswer(question, reading.category ?? 'unknown', 0.95);
    if (name === 'connection_failure') return choiceAnswer(question, reading.connection ?? 'none', 0.95);
    const key = YES_NO[name];
    return noulAnswer(key !== undefined && reading[key] === true ? 0.97 : 0.03);
  });
}

/**
 * Installs a {@link failureReadingsPort} around every test in the calling
 * file (or describe block) and restores the previous port afterwards. The
 * returned object's `requests` is the current test's request log.
 */
export function useFailureReadings(table: FailureWordingTable): { readonly requests: ReadonlyArray<{ readonly state: unknown }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    forgetFailureReadings();
    const { port, requests } = failureReadingsPort(table);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
    forgetFailureReadings();
  });
  return log;
}
