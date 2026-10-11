import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { personalOpsRecordCertification } from '../../tools/agent-harness-personal-ops-certification.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

function certification(record: Readonly<Record<string, unknown>>) {
  return personalOpsRecordCertification({ record, sourcePath: 'context.platform.readModels.personalOps.inboxThreads',
    durableId: 'synthetic-thread', recordKind: 'inbox thread', hasConfirmedEffectRoute: true });
}

test('a claimed known schema preserves descriptive evidence without authenticating it', () => {
  const claimed = { schemaStatus: 'certified', schemaVersion: 'goodvibes.personal-ops.inbox-thread.v1',
    publicationGuarantee: 'The daemon publishes current thread snapshots after sync.', publisher: 'synthetic-host',
    methodId: 'email.threads.list', receiptId: 'synthetic-receipt', receiptStatus: 'completed', receiptRoute: 'inspect synthetic-receipt' };
  const result = certification(claimed);
  expect(result.schemaStatus).toBe('legacy');
  expect(result.schemaVersion).toBe(claimed.schemaVersion);
  expect(result.publicationGuarantee).toBe(claimed.publicationGuarantee);
  expect(result.publisher).toBe(claimed.publisher);
  expect(result.receiptId).toBe(claimed.receiptId);
  expect(result.receiptRoute).toBe(claimed.receiptRoute);
  expect(result.provenance).toContain('method email.threads.list');
  expect(result.missingSignals).toEqual(['Native host or SDK inbox thread schema attestation is not published.']);
  expect(result.policy).toContain('do not certify release evidence');
});

test('arbitrary version publication and provenance strings cannot establish certification', () => {
  const result = certification({ schemaVersion: 'arbitrary-version', publicationGuarantee: 'anything goes', methodId: 'unknown.publisher' });
  expect(result.schemaStatus).toBe('legacy');
  expect(result.missingSignals).toContain('Native host or SDK inbox thread schema attestation is not published.');
  expect(result.missingSignals).toContain('Provider-side inbox thread publisher is not published.');
});

test('status words and lexical aliases never become native attestation', () => {
  for (const schemaStatus of ['certified', 'valid', 'verified', 'schema-certified', 'SCHEMA_CERTIFIED', 'Example certified; no actual attestation']) {
    expect(certification({ schemaStatus }).schemaStatus).toBe('legacy');
  }
});

test('nested fake certification and signature fields remain unverified metadata', () => {
  const result = certification({ certification: { schemaStatus: 'certified', verified: true,
    schemaVersion: 'synthetic-v1', publicationGuarantee: 'Published by the provider.', publisher: 'synthetic-host',
    methodId: 'email.threads.list', signature: 'unverified-signature' } });
  expect(result.schemaStatus).toBe('legacy');
  expect(result.publisher).toBe('synthetic-host');
  expect(result.missingSignals).toEqual(['Native host or SDK inbox thread schema attestation is not published.']);
});

test('unknown schema fields with accessors are held without evaluating them', () => {
  let reads = 0;
  const record = Object.defineProperty({ schemaStatus: 'certified' }, 'unknownMetadata', {
    get() { reads++; return 'private-metadata'; }, enumerable: false,
  });
  expect(() => certification(record)).toThrow();
  expect(reads).toBe(0);
});

test('an accessor on a selected certification field is held without evaluating it', () => {
  let reads = 0;
  const record = Object.defineProperty({}, 'schema', { get() { reads++; return { schemaStatus: 'certified' }; }, enumerable: true });
  expect(() => certification(record)).toThrow();
  expect(reads).toBe(0);
});

test('an affirmative hosted reader cannot supply a missing native attestation', () => {
  const reader = fakePort(() => noulAnswer(0.999));
  installJudgmentPort(reader.port);
  expect(certification({ schemaStatus: 'verified', verified: true }).schemaStatus).toBe('legacy');
  expect(reader.requests).toHaveLength(0);
});
