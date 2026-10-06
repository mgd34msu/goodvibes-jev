import { describe, expect, test } from 'bun:test';
import { knowledgeIsolationAnswer } from '../helpers/knowledge-isolation-readings.ts';

const query = 'where is the isolation light?';
const sample = 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.';

describe('exact synthetic knowledge isolation readings', () => {
  test('accepts only the authored readable sample', () => {
    expect(knowledgeIsolationAnswer('readable', { sample })).toEqual({ type: 'noul', noul: 0.99 });
    expect(() => knowledgeIsolationAnswer('readable', { sample: 'Other document' })).toThrow();
  });
  test('does not invent answer evidence from generic prose or empty excerpts', () => {
    expect(knowledgeIsolationAnswer('excerptUseful', { query, candidate: { text: sample } })).toEqual({ type: 'noul', noul: 0.01 });
    expect(knowledgeIsolationAnswer('match', { query, candidate: { title: 'Isolation Home', sourceType: 'dataset', excerpts: [], facts: [] } })).toEqual({ type: 'noul', noul: 0.01 });
  });
  test('rejects unknown query, object, question and provider routing', () => {
    expect(() => knowledgeIsolationAnswer('useful', { query: 'different question', candidate: { kind: 'node', nodeKind: 'ha_area', title: 'Lab' } })).toThrow();
    expect(() => knowledgeIsolationAnswer('useful', { query, candidate: { kind: 'node', nodeKind: 'ha_area', title: 'Other room' } })).toThrow();
    expect(() => knowledgeIsolationAnswer('made-up', { query })).toThrow();
    expect(() => knowledgeIsolationAnswer('route', { provider: 'openai', model_id: 'test' })).toThrow();
  });
  test('device readings require the exact fixture identity', () => {
    expect(knowledgeIsolationAnswer('batteryApplicable', { subject: { kind: 'ha_device', title: 'Isolation Light', homeAssistant: { objectId: 'device-light' } } })).toEqual({ type: 'noul', noul: 0.01 });
    expect(() => knowledgeIsolationAnswer('batteryApplicable', { subject: { kind: 'ha_device', title: 'Isolation Light', homeAssistant: { objectId: 'other-device' } } })).toThrow();
  });
  test('complete discovery reads only the exact authored documentation suggestion as irrelevant', () => {
    const candidate = {
      kind: 'source',
      sourceType: 'url',
      title: 'integration-light Home Assistant documentation',
      text: [
        'integration-light Home Assistant documentation',
        'Suggested documentation source for the integration-light Home Assistant integration.',
        'https://www.home-assistant.io/integrations/integration-light/',
        'homeassistant home-graph documentation suggested-source integration-light home-assistant-docs',
      ].join('\n\n'),
      facts: [],
    };
    expect(knowledgeIsolationAnswer('useful', { query, candidate })).toEqual({ type: 'noul', noul: 0.01 });
    for (const changed of [
      { ...candidate, kind: 'node' },
      { ...candidate, sourceType: 'dataset' },
      { ...candidate, title: 'Other integration documentation' },
      { ...candidate, text: `${candidate.text}\nThe light is in another room.` },
      { ...candidate, facts: ['The light is in another room.'] },
      { ...candidate, facts: undefined },
    ]) expect(() => knowledgeIsolationAnswer('useful', { query, candidate: changed })).toThrow();
    expect(() => knowledgeIsolationAnswer('useful', { query: 'different question', candidate })).toThrow();
    expect(() => knowledgeIsolationAnswer('excerptUseful', { query, candidate })).toThrow();
    expect(() => knowledgeIsolationAnswer('route', { query, candidate })).toThrow();
  });
});
