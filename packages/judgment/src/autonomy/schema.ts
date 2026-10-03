/** Runtime-neutral JSON Schema for storage and wire consumers (draft 7). */
const referenceString = { type: 'string', minLength: 1, maxLength: 256, not: { pattern: '[^!-~]' } } as const;
const versionRef = {
  type: 'object', additionalProperties: false, required: ['id', 'revision'],
  properties: { id: referenceString, revision: referenceString },
} as const;

export const JEV_DECISION_BINDING_KEYS = Object.freeze([
  'sourceId', 'inputRevision', 'actionId', 'actionRevision',
  'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision',
] as const);

export const JEV_CONTINUATION_KINDS = Object.freeze(['reconsider', 'gather-evidence', 'revise-action'] as const);

function freezeSchema<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSchema(child);
    Object.freeze(value);
  }
  return value;
}

const common = {
  schemaVersion: { const: 1 },
  decisionId: referenceString,
  binding: {
    type: 'object', additionalProperties: false, required: JEV_DECISION_BINDING_KEYS,
    properties: Object.fromEntries(JEV_DECISION_BINDING_KEYS.map((key) => [key, referenceString])),
  },
  judgmentDecisionIds: { type: 'array', minItems: 1, maxItems: 256, uniqueItems: true, items: referenceString },
  evidence: { type: 'array', maxItems: 256, uniqueItems: true, items: versionRef },
  summary: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
} as const;

const variant = (outcome: string, extra: Readonly<Record<string, object>>) => ({
  type: 'object', additionalProperties: false,
  required: [...Object.keys(common), 'outcome', ...Object.keys(extra)],
  properties: { ...common, outcome: { const: outcome }, ...extra },
});

/**
 * Shape validation only. Consumers must additionally call validateJevDecision
 * against trusted current context; JSON Schema cannot verify opaque references.
 */
export const JEV_DECISION_SCHEMA = freezeSchema({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'JevDecision',
  oneOf: [
    { ...variant('act', {}), properties: { ...common, outcome: { const: 'act' }, evidence: { ...common.evidence, minItems: 1 } } },
    variant('revise', { next: {
      ...versionRef, required: ['id', 'revision', 'kind'],
      properties: { ...versionRef.properties, kind: { enum: JEV_CONTINUATION_KINDS } },
    } }),
    variant('defer', { until: versionRef }),
    variant('reject', {}),
  ],
} as const);
