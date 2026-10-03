import { describe, expect, test } from 'bun:test';
import {
  JEV_DECISION_BINDING_KEYS, JEV_DECISION_SCHEMA, JevDecisionError, parseJevDecision, validateJevDecision,
  type JevDecision, type JevDecisionBinding, type JevDecisionContext,
} from '../src/decisions.ts';

const binding: JevDecisionBinding = {
  sourceId: 'request-1', inputRevision: 'input-sha256-1',
  actionId: 'action-1', actionRevision: 'action-sha256-1',
  authorityId: 'session-1', authorityRevision: 'grant-version-1',
  scopeId: 'workspace-1', scopeRevision: 'scope-version-1',
};

const context: JevDecisionContext = {
  decisionId: 'decision-1', binding,
  judgmentDecisionIds: ['reading-1', 'reading-2'],
  evidence: [{ id: 'evidence-1', revision: 'evidence-sha256-1' }],
  continuations: [
    { kind: 'reconsider', id: 'read-again', revision: '1' },
    { kind: 'gather-evidence', id: 'inspect-target', revision: '1' },
    { kind: 'revise-action', id: 'narrow-target', revision: '1' },
  ],
  resumeConditions: [{ id: 'target-ready', revision: '1' }],
};

const base = {
  schemaVersion: 1 as const, decisionId: context.decisionId, binding,
  judgmentDecisionIds: ['reading-1'], evidence: context.evidence,
  summary: 'The current evidence supports this decision.',
};

const decisions: readonly JevDecision[] = [
  { ...base, outcome: 'act' },
  ...context.continuations.map((next) => ({ ...base, outcome: 'revise' as const, next })),
  { ...base, outcome: 'defer', until: context.resumeConditions[0]! },
  { ...base, evidence: [], outcome: 'reject', summary: 'There is insufficient evidence to act.' },
];

function expectKind(work: () => unknown, kind: JevDecisionError['kind']): void {
  try { work(); throw new Error('Expected validation to fail'); }
  catch (error) {
    expect(error).toBeInstanceOf(JevDecisionError);
    expect((error as JevDecisionError).kind).toBe(kind);
  }
}

describe('autonomous semantic decision contract', () => {
  test.each(['evidence', 'judgmentDecisionIds'] as const)('snapshots %s length without invoking proxy getters', (field) => {
    let reads = 0;
    const value = new Proxy([], { get(target, key, receiver) {
      if (key === 'length') return ++reads <= 2 ? 1 : 0;
      return Reflect.get(target, key, receiver);
    } });
    expectKind(() => validateJevDecision({ ...base, outcome: 'act', [field]: value }, context), 'invalid-contract');
    expect(reads).toBe(0);
  });

  test('rejects a discriminant changed during property snapshotting', () => {
    let reads = 0;
    const value = new Proxy({ ...base, outcome: 'act' }, { getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'outcome' ? { ...descriptor, value: ++reads === 1 ? 'act' : 'reject' } : descriptor;
    } });
    expectKind(() => validateJevDecision(value, context), 'invalid-contract');
  });

  test.each([...decisions])('accepts $outcome with host-bound evidence and steps', (decision) => {
    expect(parseJevDecision(decision)).toEqual(decision);
    expect(validateJevDecision(decision, context)).toEqual(decision);
  });

  test.each(['confirm', 'escalate', 'allow-all', 'waiting', 'retrying', 'unavailable', 'approved', 'aborted'])('rejects nonsemantic or legacy outcome %s', (outcome) => {
    expectKind(() => parseJevDecision({ ...base, outcome }), 'invalid-contract');
  });

  test.each([...JEV_DECISION_BINDING_KEYS])('rejects changed %s, including authority revocation', (key) => {
    expectKind(() => validateJevDecision(decisions[0], { ...context, binding: { ...binding, [key]: 'changed' } }), 'binding-mismatch');
  });

  test('a different decision id cannot reuse a receipt', () => {
    expectKind(() => validateJevDecision(decisions[0], { ...context, decisionId: 'decision-2' }), 'binding-mismatch');
  });

  test('a well-shaped model claim cannot manufacture host evidence or recorded readings', () => {
    expectKind(() => validateJevDecision({ ...decisions[0], judgmentDecisionIds: ['fabricated-reading'] }, context), 'unknown-judgment');
    expectKind(() => validateJevDecision({ ...decisions[0], evidence: [{ id: 'fabricated', revision: '1' }] }, context), 'unknown-evidence');
    expectKind(() => validateJevDecision({ ...decisions[0], evidence: [{ ...context.evidence[0]!, revision: 'old' }] }, context), 'unknown-evidence');
    expectKind(() => validateJevDecision(decisions[0], { ...context, evidence: [] }), 'unknown-evidence');
  });

  test('reconsideration and evidence requests select an exact offered step', () => {
    for (const next of [
      { kind: 'gather-evidence', id: 'arbitrary-tool', revision: '1' },
      { kind: 'gather-evidence', id: 'inspect-target', revision: '2' },
      { kind: 'revise-action', id: 'inspect-target', revision: '1' },
    ]) expectKind(() => validateJevDecision({ ...base, outcome: 'revise', next }, context), 'unknown-continuation');
  });

  test('deferral needs a real versioned resume condition', () => {
    expectKind(() => validateJevDecision({ ...base, outcome: 'defer', until: { id: 'anything', revision: '1' } }, context), 'unknown-condition');
    expectKind(() => validateJevDecision({ ...base, outcome: 'defer', until: { id: 'target-ready', revision: 'old' } }, context), 'unknown-condition');
  });

  test.each([
    { ...base, outcome: 'act', approval: true },
    { ...base, outcome: 'act', next: context.continuations[0] },
    { ...base, outcome: 'act', until: context.resumeConditions[0] },
    { ...base, outcome: 'act', evidence: [] },
    { ...base, outcome: 'act', judgmentDecisionIds: [] },
    { ...base, outcome: 'act', judgmentDecisionIds: ['reading-1', 'reading-1'] },
    { ...base, outcome: 'act', evidence: [context.evidence[0], context.evidence[0]] },
    { ...base, outcome: 'act', binding: { ...binding, authority: 'approved' } },
    { ...base, outcome: 'act', binding: { ...binding, authorityRevision: '' } },
    { ...base, outcome: 'act', evidence: [{ ...context.evidence[0], approved: true }] },
    { ...base, outcome: 'act', schemaVersion: 2 },
    { ...base, outcome: 'act', summary: ' \n ' },
    { ...base, outcome: 'act', summary: 'a'.repeat(2001) },
    { ...base, outcome: 'act', decisionId: 'a'.repeat(257) },
    { ...base, outcome: 'act', decisionId: 'secret\nheader' },
    { ...base, outcome: 'act', decisionId: 'secret\n' },
    { ...base, outcome: 'act', decisionId: 'display name' },
    { ...base, outcome: 'act', decisionId: 'é' },
    { ...base, outcome: 'revise', next: { kind: 'ask-human', id: 'operator', revision: '1' } },
    { ...base, outcome: 'revise' },
    { ...base, outcome: 'defer' },
    { ...base, outcome: 'reject', next: context.continuations[0] },
    undefined, null, true, [],
  ].map((value) => [value] as const))('refuses malformed or authority-smuggling payload %#', (value) => {
    expectKind(() => parseJevDecision(value), 'invalid-contract');
  });

  test('a detached, deeply frozen receipt cannot be changed after validation', () => {
    const mutable = JSON.parse(JSON.stringify(decisions[1])) as Record<string, unknown>;
    const snapshot = validateJevDecision(mutable, context);
    (mutable.binding as Record<string, unknown>).authorityRevision = 'revoked';
    (mutable.evidence as Array<Record<string, unknown>>)[0]!.revision = 'new';
    (mutable.judgmentDecisionIds as string[])[0] = 'fake';
    (mutable.next as Record<string, unknown>).id = 'other';
    expect(snapshot).toEqual(decisions[1]!);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.binding)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence)).toBe(true);
    expect(Object.isFrozen(snapshot.evidence[0])).toBe(true);
    expect(Object.isFrozen(snapshot.judgmentDecisionIds)).toBe(true);
    expect(snapshot.outcome === 'revise' && Object.isFrozen(snapshot.next)).toBe(true);
  });

  test('does not invoke untrusted getters and sanitizes thrown proxy messages', () => {
    let invoked = false;
    const value = { ...decisions[0] };
    Object.defineProperty(value, 'decisionId', { get() { invoked = true; return 'decision-1'; } });
    expectKind(() => parseJevDecision(value), 'invalid-contract');
    expect(invoked).toBe(false);
    const secret = 'private upstream body';
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } });
    expect(() => parseJevDecision(proxy)).toThrow('Jev decision validation failed: invalid-contract');
    try { parseJevDecision(proxy); } catch (error) { expect(String(error)).not.toContain(secret); }
  });

  test('rejects sparse/accessor evidence arrays and inherited payloads', () => {
    expectKind(() => parseJevDecision({ ...decisions[0], evidence: Array(1) }), 'invalid-contract');
    const evidence = [context.evidence[0]];
    Object.defineProperty(evidence, '0', { get() { throw new Error('should not run'); } });
    expectKind(() => parseJevDecision({ ...decisions[0], evidence }), 'invalid-contract');
    expectKind(() => parseJevDecision(Object.create(decisions[0]!)), 'invalid-contract');
  });

  test('schema has four closed variants and is plain JSON for browser consumers', () => {
    const schema = JSON.parse(JSON.stringify(JEV_DECISION_SCHEMA)) as typeof JEV_DECISION_SCHEMA;
    expect(schema.oneOf.map((variant) => variant.properties.outcome.const)).toEqual(['act', 'revise', 'defer', 'reject']);
    for (const variant of schema.oneOf) {
      expect(variant.additionalProperties).toBe(false);
      expect(variant.properties.binding.required).toEqual(JEV_DECISION_BINDING_KEYS);
    }
  });

  test('exported schema and binding keys cannot be mutated to change validation', () => {
    expect(Object.isFrozen(JEV_DECISION_BINDING_KEYS)).toBe(true);
    expect(Object.isFrozen(JEV_DECISION_SCHEMA)).toBe(true);
    expect(Object.isFrozen(JEV_DECISION_SCHEMA.oneOf)).toBe(true);
    expect(Object.isFrozen(JEV_DECISION_SCHEMA.oneOf[0].properties.binding.required)).toBe(true);
    expect(Object.isFrozen(JEV_DECISION_SCHEMA.oneOf[0].properties.binding.properties.sourceId)).toBe(true);
  });

  test('each semantic variant requires an exhaustive consumer branch', () => {
    function render(decision: JevDecision): string {
      switch (decision.outcome) {
        case 'act': return decision.binding.actionId;
        case 'revise': return decision.next.kind;
        case 'defer': return decision.until.id;
        case 'reject': return decision.summary;
        default: { const impossible: never = decision; return impossible; }
      }
    }
    expect(decisions.map(render)).toHaveLength(6);
    // @ts-expect-error An operational wait is not a semantic decision.
    const waiting: JevDecision['outcome'] = 'waiting';
    expect(String(waiting)).toBe('waiting');
  });
});
