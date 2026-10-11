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
  test('repair subject readings accept only the exact observed gap and complete fixture candidates', () => {
    const fixture = (reference: string) => ({ reference, candidate: reference,
      candidates: [
        { title: 'Isolation Light', kind: 'ha_entity', aliases: ['Isolation Light'], identity: {}, summary: 'area area-lab - device device-light', reference: 'subject-1' },
        { title: 'Isolation Light', kind: 'ha_device', aliases: ['Isolation Light'], identity: {}, summary: 'area area-lab', reference: 'subject-2' },
      ], query: `${query} Matching sources have no extracted evidence available for verification.`,
      objectProfiles: [{ subjectKinds: ['service', 'provider', 'capability'] }, { subjectKinds: ['ha_device'] },
        { subjectKinds: ['ha_entity'] }, { subjectKinds: ['ha_integration'] }],
    });
    for (const reference of ['subject-1', 'subject-2']) expect(knowledgeIsolationAnswer('repairSubjectSelected', fixture(reference))).toEqual({ type: 'noul', noul: 0.99 });
    const original = fixture('subject-1');
    for (const unknown of [
      { ...original, query: 'Where is another light?' },
      { ...original, candidate: 'subject-2' },
      fixture('subject-3'),
      { ...original, candidates: original.candidates.slice(0, 1) },
      { ...original, candidates: original.candidates.map(candidate => ({ ...candidate, title: 'Other light' })) },
      { ...original, candidates: original.candidates.map(candidate => ({ ...candidate, summary: 'Different evidence' })) },
      { ...original, objectProfiles: [] },
      { ...original, additionalAuthority: true },
    ]) expect(() => knowledgeIsolationAnswer('repairSubjectSelected', unknown)).toThrow();
    expect(() => knowledgeIsolationAnswer('route', original)).toThrow();
  });
  test('device readings require the exact fixture identity', () => {
    expect(knowledgeIsolationAnswer('batteryApplicable', { subject: { kind: 'ha_device', title: 'Isolation Light', homeAssistant: { objectId: 'device-light' } } })).toEqual({ type: 'noul', noul: 0.01 });
    expect(() => knowledgeIsolationAnswer('batteryApplicable', { subject: { kind: 'ha_device', title: 'Isolation Light', homeAssistant: { objectId: 'other-device' } } })).toThrow();
  });
});
