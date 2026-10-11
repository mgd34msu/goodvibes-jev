import { expect, spyOn, test } from 'bun:test';
import { assertJudgmentInput } from '../sdk/src/platform/gate/judgment-input.js';
import { knowledgeRawRepresentation } from '../sdk/src/platform/knowledge/store-record-representation.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useKnowledgeAnswerReadings();
useHomeGraphFixtures();

test('owned Home Graph stamps remain readable at a clock whose digits satisfy Luhn', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1791684509006);
  try {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({ installationId: 'owned-clock', devices: [{ id: 'vela', name: 'Vela' }], pageAutomation: { enabled: false } });
    const snapshot = store.listSources().find(source => source.metadata.homeGraphSourceKind === 'snapshot')!;
    expect(typeof snapshot.metadata.capturedAt).toBe('number');
    expect(knowledgeRawRepresentation(snapshot).metadata.capturedAt).toBe('2026-10-11T02:08:29.006Z');
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(snapshot))).not.toThrow();
    const page = await service.refreshDevicePassport({ installationId: 'owned-clock', deviceId: 'vela' });
    if (!page.source) throw new Error('Expected the published device passport source.');
    expect(typeof page.source.metadata.generatedAt).toBe('number');
    expect(typeof page.passport.metadata.refreshedAt).toBe('number');
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(page.source))).not.toThrow();
    expect(() => assertJudgmentInput(knowledgeRawRepresentation(page.passport))).not.toThrow();
  } finally { clock.mockRestore(); }
});

test('a caller supplied snapshot clock retains complete privacy admission', async () => {
  const { service, store } = createHomeGraphService();
  await service.syncSnapshot({ installationId: 'caller-clock', capturedAt: 4111111111111111, pageAutomation: { enabled: false } });
  const snapshot = store.listSources().find(source => source.metadata.homeGraphSourceKind === 'snapshot')!;
  expect(knowledgeRawRepresentation(snapshot).metadata.capturedAt).toBe(4111111111111111);
  expect(() => assertJudgmentInput(knowledgeRawRepresentation(snapshot))).toThrow();
});
