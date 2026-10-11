import { expect, test } from 'bun:test';
import { toJSONSchema } from 'zod/v4';
import { JEV_DECISION_SCHEMA } from '@goodvibes-jev/judgment/decisions';
import { renderType } from '../scripts/foundation-io-render.js';
import { sampleFromSchema } from '../contracts/src/testing/mock-daemon.js';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';
import { CONTRACT_VIEW_SCHEMA } from '../sdk/src/platform/control-plane/operator-contract-schemas-contracts.js';
import { nativeSelectedDiffContextSchema } from '../sdk/src/platform/workflow/work-ledger/native-diff-context.js';
import { CONTRACT_DURABLE_ADMISSION_SCHEMA } from '../sdk/src/platform/control-plane/operator-contract-schemas-contract-inspection.js';

test('literal JSON Schema const values retain their exact generated TypeScript type', () => {
  for (const [value, expected] of [[1, '1'], ['act', '"act"'], [true, 'true'], [false, 'false'], [null, 'null'], ['a"b', '"a\\"b"']] as const) {
    expect(renderType({ const: value })).toBe(expected);
    expect(sampleFromSchema({ const: value })).toEqual(value);
  }
  expect(renderType({ type: 'array', items: { const: 'act' } })).toBe('readonly ("act")[]');
  expect(renderType({ enum: ['revise-action', 'reconsider', 'reconsider'] })).toBe('"reconsider" | "revise-action"');
  expect(() => renderType({ const: { unsafe: true } })).toThrow('Unsupported const shape');
  expect(() => renderType({ const: Infinity })).toThrow('Unsupported const shape');
  expect(() => renderType({ oneOf: [] })).toThrow('Unsupported oneOf shape');
});

test('canonical Jev decisions generate all four discriminated variants and valid sample provenance', () => {
  const rendered = renderType(JEV_DECISION_SCHEMA);
  for (const outcome of ['act', 'revise', 'defer', 'reject']) expect(rendered).toContain(`outcome: "${outcome}";`);
  expect(rendered).toContain('schemaVersion: 1;');
  expect(rendered).toContain('next: { id: string; revision: string; kind: "gather-evidence" | "reconsider" | "revise-action"; };');
  expect(rendered).toContain('until: { id: string; revision: string; };');
  expect(rendered).toContain('judgmentDecisionIds: readonly string[];');
  expect(rendered).not.toContain('unknown');
  const sample = sampleFromSchema(JEV_DECISION_SCHEMA);
  expect(sample).toMatchObject({ schemaVersion: 1, outcome: 'act', judgmentDecisionIds: ['sample'], evidence: [{ id: 'sample', revision: 'sample' }] });
  expect(firstJsonSchemaFailure(JEV_DECISION_SCHEMA, sample)).toBeUndefined();
});

test('versioned durable admissions retain pinned-placement alternatives in generated types', () => {
  const rendered = renderType(CONTRACT_DURABLE_ADMISSION_SCHEMA);
  expect(rendered).toContain('schemaVersion: 1;');
  expect(rendered).toContain('schemaVersion: 2;');
  expect(rendered).toContain('execution: { isolation: "shared"; } | { isolation: "worktree";');
  expect(rendered).not.toContain('unknown');
});

test('the complete inspection contract renders and generates a schema-valid sample', () => {
  const rendered = renderType(CONTRACT_VIEW_SCHEMA);
  for (const field of ['nativeSource', 'nativeDecisions', 'nativeProgress', 'nativeWaiting', 'durableAdmission', 'durableLaunchState', 'inputSnapshot', 'lastReport']) {
    expect(rendered).toContain(`${field}?:`);
  }
  expect(rendered).not.toContain('unknown');
  expect(firstJsonSchemaFailure(CONTRACT_VIEW_SCHEMA, sampleFromSchema(CONTRACT_VIEW_SCHEMA))).toBeUndefined();
});

test('schema samples retain fixed-width digest constraints in each selected-diff variant', () => {
  const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
  expect(sampleFromSchema(digest)).toBe('a'.repeat(64));
  expect(firstJsonSchemaFailure(digest, sampleFromSchema(digest))).toBeUndefined();
  for (const [pattern, expected] of [['^[0-9]{4}$', '0000'], ['^[A-Z]{2}$', 'AA']] as const) {
    const schema = { type: 'string', pattern };
    expect(sampleFromSchema(schema)).toBe(expected);
    expect(firstJsonSchemaFailure(schema, sampleFromSchema(schema))).toBeUndefined();
  }
  for (const branch of nativeSelectedDiffContextSchema.options) {
    const variant = toJSONSchema(branch);
    const sample = sampleFromSchema(variant);
    expect(firstJsonSchemaFailure(variant, sample)).toBeUndefined();
    expect(sample).toMatchObject({ revision: 'a'.repeat(64) });
  }
});
