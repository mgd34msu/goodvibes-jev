import { describe, expect, test } from 'bun:test';
import { JEV_DECISION_SCHEMA } from '@goodvibes-jev/judgment/decisions';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.ts';

const receipt = {
  schemaVersion: 1, decisionId: 'recorded-decision', outcome: 'act', summary: 'Recorded candidate; not execution authority.',
  binding: { sourceId: 'source', inputRevision: '1', actionId: 'action', actionRevision: '1', authorityId: 'owner', authorityRevision: '1', scopeId: 'scope', scopeRevision: '1' },
  judgmentDecisionIds: ['recorded-call'], evidence: [{ id: 'recorded-evidence', revision: '1' }],
};

describe('canonical JSON schema container constraints', () => {
  test('schema-valued additionalProperties validates every undeclared dictionary value', () => {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: { type: 'number' } };
    expect(firstJsonSchemaFailure(schema, { title: 'Known field', first: 1, second: 2 })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { title: 'Known field', first: 1, second: 'bad' })?.path).toBe('$.second');
    expect(firstJsonSchemaFailure({ type: 'object', additionalProperties: { type: 'number' } }, { counter: 'bad' })?.path).toBe('$.counter');
  });

  test('nested dictionary members retain their own required and closed shape checks', () => {
    const schema = { type: 'object', additionalProperties: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } }, additionalProperties: false } };
    expect(firstJsonSchemaFailure(schema, { pending: { decision: 'recorded' } })).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, { pending: {} })?.path).toBe('$.pending.decision');
    expect(firstJsonSchemaFailure(schema, { pending: { decision: 'recorded', extra: true } })?.path).toBe('$.pending.extra');
  });

  test('not rejects exactly the matching excluded schema', () => {
    const schema = { type: 'string', not: { pattern: '[^!-~]' } };
    expect(firstJsonSchemaFailure(schema, 'opaque-ref:1')).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, 'opaque ref')).toBeDefined();
    expect(firstJsonSchemaFailure(schema, 'opaque-λ')).toBeDefined();
    expect(firstJsonSchemaFailure({ not: { enum: ['blocked'] } }, 'allowed')).toBeUndefined();
    expect(firstJsonSchemaFailure({ not: { enum: ['blocked'] } }, 'blocked')).toBeDefined();
  });

  test('uniqueItems uses JSON value equality including unordered object keys and ordered arrays', () => {
    const schema = { type: 'array', uniqueItems: true };
    expect(firstJsonSchemaFailure(schema, ['a', 'b', 1, '1', true])).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, ['a', 'a'])).toBeDefined();
    expect(firstJsonSchemaFailure(schema, [0, -0])).toBeDefined();
    expect(firstJsonSchemaFailure(schema, [{ id: 'a', ref: { x: 1, y: 2 } }, { ref: { y: 2, x: 1 }, id: 'a' }])).toBeDefined();
    expect(firstJsonSchemaFailure(schema, [{ 'é': 1, 'é': 2 }, { 'é': 2, 'é': 1 }])).toBeDefined();
    expect(firstJsonSchemaFailure(schema, [[1, 2], [2, 1]])).toBeUndefined();
    expect(firstJsonSchemaFailure({ type: 'array', uniqueItems: false }, ['a', 'a'])).toBeUndefined();
  });

  test('Unicode string limits count code points consistently with canonical Jev summaries', () => {
    expect(firstJsonSchemaFailure({ type: 'string', minLength: 2 }, '🙂')).toBeDefined();
    expect(firstJsonSchemaFailure({ type: 'string', maxLength: 1 }, '🙂')).toBeUndefined();
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, { ...receipt, summary: '🙂'.repeat(2000) })).toBeUndefined();
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, { ...receipt, summary: '🙂'.repeat(2001) })).toBeDefined();
  });

  test('nonblank native text has no regex input ceiling while arbitrary patterns remain guarded', () => {
    const schema = { type: 'string', pattern: '\\S' };
    expect(firstJsonSchemaFailure(schema, ' '.repeat(60_000))).toBeDefined();
    expect(firstJsonSchemaFailure(schema, '\n\t\u00a0')).toBeDefined();
    expect(firstJsonSchemaFailure(schema, ' '.repeat(60_000) + '🙂')).toBeUndefined();
    expect(firstJsonSchemaFailure(schema, 'long goal '.repeat(10_000))).toBeUndefined();
    expect(() => firstJsonSchemaFailure({ type: 'string', pattern: '^a+$' }, 'a'.repeat(60_000))).toThrow('pattern input exceeds');
    expect(() => firstJsonSchemaFailure({ type: 'string', pattern: '(a+)+$' }, 'aaa')).toThrow('too expensive');
  });

  test('canonical Jev receipt constraints reject duplicate lineage/evidence and non-reference bindings', () => {
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, receipt)).toBeUndefined();
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, { ...receipt, judgmentDecisionIds: ['same', 'same'] })).toBeDefined();
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, { ...receipt, evidence: [{ id: 'same', revision: '1' }, { revision: '1', id: 'same' }] })).toBeDefined();
    expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, { ...receipt, binding: { ...receipt.binding, scopeId: 'not an opaque ref' } })).toBeDefined();
  });
});
