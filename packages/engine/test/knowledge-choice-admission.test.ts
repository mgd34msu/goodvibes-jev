import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { prepareHomeGraphTriageReadings } from '../sdk/src/platform/knowledge/home-graph/triage/reader.js';
import { createHomeGraphAutoLinkReader } from '../sdk/src/platform/knowledge/home-graph/auto-link/reader.js';
import { createRepairSourceAuthorityReader } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/reader.js';
import { verifyKnowledgeAnswer } from '../sdk/src/platform/knowledge/semantic/answer-verification/reader.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const readers = [
  { name: 'triage', async read() {
    const [plan] = await prepareHomeGraphTriageReadings([{ reference: 'issue-1', issue: { code: 'custom', message: 'Fixture', severity: 'warning' } }]);
    expect(plan?.action).toBe('reject'); expect(plan?.probability).toBe(0.97);
  } },
  { name: 'auto-link', async read() {
    const result = await createHomeGraphAutoLinkReader().read({ source: { title: 'Fixture' },
      candidates: [{ reference: 'candidate-1', subject: { title: 'Fixture' }, entities: [] }] }, { assertCurrent() {} });
    expect(result).toEqual({ reference: 'candidate-1', relation: 'source_for' });
  } },
  { name: 'source authority', async read() {
    const result = await createRepairSourceAuthorityReader().read([{ reference: 'source-1', query: 'Fixture', subjects: [],
      source: { sourceType: 'document' }, extraction: { format: 'text', links: [] }, text: 'Fixture', claimedProvenance: {} }]);
    expect(result).toEqual([{ reference: 'source-1', authority: 'official-vendor', probability: 0.97 }]);
  } },
  { name: 'answer verification', async read() {
    const result = await verifyKnowledgeAnswer({ query: 'Fixture', evidence: [{ reference: 'evidence-1', text: 'Fixture' }],
      candidates: [{ id: 'generated', text: 'Fixture [ref:evidence-1]' }] });
    expect(result.confidence).toBe(97); expect(result.quality.status).toBe('verified');
  } },
];

for (const reader of readers) for (const scenario of ['approximate', 'missing mass', 'nonmaximal'] as const) {
  test(`${reader.name} shares canonical Choice admission: ${scenario}`, async () => {
    const fake = fakePort((name, question) => {
      if (question.type !== 'choice') return noulAnswer(['manual', 'integrationDocumentation'].includes(name) ? 0.01 : 0.99);
      const choice = ['reject', 'source_for', 'official-vendor', 'supported'].find(key => Object.hasOwn(question.criteria, key));
      if (!choice) throw new Error('Unexpected choice fixture');
      const other = Object.keys(question.criteria).find(key => key !== choice);
      const probabilities = Object.fromEntries(Object.keys(question.criteria).map(key => [key,
        key === choice ? (scenario === 'nonmaximal' ? 0.1 : scenario === 'missing mass' ? 0.9 : 0.99)
          : scenario === 'nonmaximal' && key === other ? 0.89 : 0]));
      return { type: 'choice', choice, confidence: 0.97, probabilities };
    });
    installJudgmentPort(fake.port);
    if (scenario === 'approximate') await reader.read();
    else await expect(reader.read()).rejects.toMatchObject({ reason: 'malformed' });
  });
}
