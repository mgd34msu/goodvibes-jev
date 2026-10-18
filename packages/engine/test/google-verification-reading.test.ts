import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { readVerificationArtifact } from '../sdk/src/platform/google/verification-reading.js';
import type { CandidateEmail, VerificationExpectation } from '../sdk/src/platform/google/verification-expectations.js';
import type { ProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/types.js';

/** Synthetic admission only; this does not establish the live privacy screen's accuracy. */
function sourceOwner(): ProtectedSourceOwner {
  const parts = new Map<object, readonly string[]>();
  return { capture(value: readonly string[]) { const source = {}; parts.set(source, value); return source; },
    async screen(source: object) { return { status: 'settled', receipt: source }; },
    project(receipt: object) { const value = parts.get(receipt); if (!value) throw new Error('released'); return value; },
    async release(source: object) { parts.delete(source); }, async close() {},
  } as unknown as ProtectedSourceOwner;
}
const expectation: VerificationExpectation = { id: 'test', kind: 'signup', serviceDomain: 'example.com', recipientAddress: 'test@example.com', purpose: 'signup', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), authority: 'evidence-only' };
function email(body: string): CandidateEmail { return { messageId: 'mail', from: 'sender@example.com', deliveredTo: null, toHeaderClaim: 'test@example.com', subject: 'Verification', body }; }
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function reading(chosen: string | undefined, probability = 0.99) {
  const port = fakePort((name, question) => name === 'pick' ? choiceAnswer(question, chosen ?? 'none', probability)
    : noulAnswer(name === `fits_${chosen?.split('_').at(-1)}` ? probability : 0.01));
  installJudgmentPort(port.port); return port;
}

test('a later verification link beats an unrelated same-domain help link without sending token URLs', async () => {
  const port = reading('artifact_1');
  const result = await readVerificationArtifact(email('Help: https://example.com/help. Bestätigen Sie Ihre Adresse: https://example.com/verify?t=private-token'), expectation, { sourceOwner: sourceOwner() });
  expect(result.artifact).toEqual({ kind: 'link', url: 'https://example.com/verify?t=private-token', linkHost: 'example.com' });
  expect(JSON.stringify(port.requests)).not.toContain('private-token'); expect(JSON.stringify(port.requests)).not.toContain('/verify');
  expect(JSON.stringify(port.requests)).toContain('Bestätigen');
});
test('a code reading distinguishes a verification token from an order number', async () => {
  const port = reading('artifact_1');
  const result = await readVerificationArtifact(email('Order: 123456. Your verification code: 987654.'), expectation, { sourceOwner: sourceOwner() });
  expect(result.artifact).toEqual({ kind: 'code', code: '987654' });
  expect(JSON.stringify(port.requests)).not.toContain('987654'); expect(JSON.stringify(port.requests)).not.toContain('123456');
});
test('mismatched domains are refused locally, and absent screening, weak or no-match readings extract nothing', async () => {
  const port = reading('artifact_0');
  expect((await readVerificationArtifact(email('Verify: https://evil.test/path'), expectation)).artifact.kind).toBe('refused');
  expect((await readVerificationArtifact(email('Verify: https://example.com/path'), expectation)).artifact.kind).toBe('none');
  expect(port.requests).toHaveLength(0);
  reading(undefined); expect((await readVerificationArtifact(email('Help: https://example.com/help'), expectation, { sourceOwner: sourceOwner() })).artifact.kind).toBe('none');
  reading('artifact_0', 0.5); expect((await readVerificationArtifact(email('Verify: https://example.com/path'), expectation, { sourceOwner: sourceOwner() })).artifact.kind).toBe('none');
});
test('message replacement during a held reading cannot return a token', async () => {
  const fixture = reading('artifact_0'); const source = email('Verify: https://example.com/path?t=secret');
  installJudgmentPort({ ...fixture.port, async ask(request) { Object.assign(source, { subject: 'replaced' }); return fixture.port.ask(request); } });
  await expect(readVerificationArtifact(source, expectation, { sourceOwner: sourceOwner() })).rejects.toThrow();
});
