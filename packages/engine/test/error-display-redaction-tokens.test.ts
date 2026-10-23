import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { normalizeError, readNormalizedError, summarizeError } from '../sdk/src/platform/utils/error-display.js';
import { registerAccountIdentityRedaction } from '../sdk/src/platform/utils/redaction.js';
import { authoredPrivacyAnswer, errorSpan, errorText } from './_helpers/authored-error-readings.ts';

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
  const privacy = authoredPrivacyAnswer({ fields: { ENOENT: 'content', code: 'other' }, parts: [
    [errorText('ENOENT: '), errorSpan('ENOENT'), errorText(", open '/home/[REDACTED]/hooks.json'")],
    [errorText('provider rejected {"code":'), errorSpan('code'), errorText('} [request-id 123] reading /home/[REDACTED]/x.json, retry later')],
  ] });
  return fakePort((name: string, question: Question, state: EntryType) => {
    const protectedAnswer = privacy(name, question, state);
    if (protectedAnswer !== undefined) return protectedAnswer;
    if (name.startsWith('payload_')) return noulAnswer(0.97);
    if (state !== "Message: ENOENT: [REDACTED_TEXT], open '/home/[REDACTED]/hooks.json'"
      && state !== "Message: ENOENT: no such file or directory, open '/home/[REDACTED]/hooks.json'"
      && state !== 'Message: provider rejected {"code":"bad_request"} [request-id 123] reading /home/[REDACTED]/x.json, retry later')
      throw new Error('Unspecified authored redaction-token failure state');
    if (name === 'category') return choiceAnswer(question, 'unknown', 0.95);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.95);
    if (['billing', 'rate_limited', 'context_exceeded', 'transient_network', 'provider_unusable', 'before_response'].includes(name)) return noulAnswer(0.03);
    throw new Error('Unexpected authored redaction-token question');
  });
}

describe('error-display redaction token preservation', () => {
  test('summarizeError preserves the local home path regardless of previous export readings', async () => {
    installJudgmentPort(everythingIsPayload().port);
    const err = new Error("ENOENT: no such file or directory, open '/home/somebody/hooks.json'");
    await readNormalizedError(err, { site: 'test.redaction-tokens' });
    const summary = summarizeError(err);
    expect(summary).toContain('/home/somebody/hooks.json');
    expect(summary).not.toContain('/home/ /');
  });

  test('normalizeError preserves a local path without a judgment port', () => {
    const err = new Error("cannot stat '/home/somebody/.goodvibes/settings.json'");
    const result = normalizeError(err);
    expect(result.message).toContain('/home/somebody/.goodvibes/settings.json');
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
