import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { normalizeError, readNormalizedError, summarizeError } from '../sdk/src/platform/utils/error-display.js';
import { registerAccountIdentityRedaction } from '../sdk/src/platform/utils/redaction.js';

/**
 * Redaction tokens vs. the payload reading: redaction rewrites the account's
 * home path to /home/[REDACTED]/... before the message is cleaned. The
 * bracketed-payload removal (which drops inline JSON blobs from provider
 * error messages) must not eat those placeholders: removing them turned
 * /home/[REDACTED]/hooks.json into '/home/ /hooks.json', which reads as a
 * real (and wrong) filesystem path in logs. Placeholders are not asked
 * about at all.
 */
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  registerAccountIdentityRedaction(() => ({ homeDirectory: '/home/somebody', userName: 'somebody' }));
  forgetFailureReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  registerAccountIdentityRedaction(null);
  installJudgmentPort(previous);
  forgetFailureReadings();
});

/** Every bracketed part reads as payload; every failure question as nothing in particular. */
function everythingIsPayload() {
  return fakePort((name: string, question: Question, _state: EntryType) => {
    if (name.startsWith('payload_')) return noulAnswer(0.97);
    if (question.type === 'choice') return choiceAnswer(question, name === 'category' ? 'unknown' : 'none', 0.95);
    return noulAnswer(0.03);
  });
}

describe('error-display redaction token preservation', () => {
  test('summarizeError keeps [REDACTED] inside a redacted home path', () => {
    const err = new Error("ENOENT: no such file or directory, open '/home/somebody/hooks.json'");
    const summary = summarizeError(err);
    expect(summary).toContain('/home/[REDACTED]/hooks.json');
    expect(summary).not.toContain('/home/ /');
  });

  test('normalizeError message keeps [REDACTED] tokens', () => {
    const err = new Error("cannot stat '/home/somebody/.goodvibes/settings.json'");
    const result = normalizeError(err);
    expect(result.message).toContain('[REDACTED]');
    expect(result.message).not.toContain('/home/ /');
  });

  test('the payload reading removes inline JSON and payload brackets but never asks about a placeholder', async () => {
    const { port, requests } = everythingIsPayload();
    installJudgmentPort(port);
    const err = new Error('provider rejected {"code":"bad_request"} [request-id 123] reading /home/somebody/x.json, retry later');
    const result = await readNormalizedError(err, { site: 'test.redaction-tokens' });
    expect(result.message).toBe('provider rejected reading /home/[REDACTED]/x.json, retry later');
    const spans = requests.flatMap((request) => Object.values((request.state as { spans?: Record<string, string> }).spans ?? {}));
    expect(spans).toEqual(['{"code":"bad_request"}', '[request-id 123]']);
  });
});
