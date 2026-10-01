import { BROWSER_JUDGMENT_PATH } from '@goodvibes-jev/engine/daemon-sdk';
import { methodDescriptor, objectSchema, arraySchema, STRING_SCHEMA, NUMBER_SCHEMA, BOOLEAN_SCHEMA } from './method-catalog-shared.js';

const literal = (value: string | number) => ({ type: typeof value, enum: [value] });
const ref = { type: 'string', minLength: 1, maxLength: 256 };
const candidate = { anyOf: [
  objectSchema({ kind: literal('builtin'), commandId: ref }, ['kind', 'commandId']),
  objectSchema({ kind: literal('chat'), sessionId: ref }, ['kind', 'sessionId']),
] };
const inputs = [
  ['webui.errors.daemon-refusal', objectSchema({ errorRef: ref }, ['errorRef'])],
  ['webui.status.badge-tone', objectSchema({
    vocabulary: { type: 'string', enum: ['badge', 'library-dot'] },
    source: { anyOf: [
      objectSchema({ kind: literal('catalog'), labelId: ref }, ['kind', 'labelId']),
      objectSchema({ kind: literal('daemon'), statusRef: ref }, ['kind', 'statusRef']),
    ] },
  }, ['vocabulary', 'source'])],
  ['webui.palette.command-rank', objectSchema({
    query: { anyOf: [
      objectSchema({ kind: literal('inline'), text: ref }, ['kind', 'text']),
      objectSchema({ kind: literal('reference'), queryRef: ref }, ['kind', 'queryRef']),
    ] },
    registryVersion: ref, candidates: { ...arraySchema(candidate), minItems: 1, maxItems: 64 },
  }, ['query', 'registryVersion', 'candidates'])],
] as const;
const envelope = (battery: string, input: Record<string, unknown>) => objectSchema({
  protocolVersion: literal(1), requestId: { ...STRING_SCHEMA, format: 'uuid' }, battery: literal(battery), batteryVersion: literal(1), input,
}, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'input']);
const outcomes = { type: 'string', enum: ['act', 'confirm', 'escalate'] };
const p = { type: 'number', minimum: 0, maximum: 1 };
const readings = { type: 'object', additionalProperties: { anyOf: [
  objectSchema({ kind: literal('yes-no'), probability: p, verdict: { type: 'string', enum: ['yes', 'no', 'uncertain'] }, outcome: outcomes }, ['kind', 'probability', 'verdict', 'outcome']),
  objectSchema({ kind: literal('choice'), choice: STRING_SCHEMA, confidence: p, probabilities: { type: 'object', additionalProperties: p }, outcome: outcomes }, ['kind', 'choice', 'confidence', 'probabilities', 'outcome']),
] } };
const evidence = arraySchema(objectSchema({
  decisionId: STRING_SCHEMA, model: STRING_SCHEMA, requestedModel: STRING_SCHEMA,
  usage: objectSchema({ inputTokens: NUMBER_SCHEMA, outputTokens: NUMBER_SCHEMA }, ['inputTokens', 'outputTokens']), latencyMs: NUMBER_SCHEMA,
}, ['decisionId', 'model', 'requestedModel', 'usage', 'latencyMs']));
const values = [
  objectSchema({ session_not_found: BOOLEAN_SCHEMA, session_closed: BOOLEAN_SCHEMA, session_active: BOOLEAN_SCHEMA, session_not_local: BOOLEAN_SCHEMA, method_unknown: BOOLEAN_SCHEMA }, ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown']),
  { anyOf: [
    objectSchema({ vocabulary: literal('badge'), tone: { type: 'string', enum: ['ok', 'warning', 'bad', 'neutral'] } }, ['vocabulary', 'tone']),
    objectSchema({ vocabulary: literal('library-dot'), tone: { type: 'string', enum: ['ok', 'warn', 'bad', 'info', 'idle'] } }, ['vocabulary', 'tone']),
  ] },
  objectSchema({ registryVersion: ref, accepted: arraySchema(objectSchema({ candidateIndex: { type: 'number', minimum: 0, maximum: 63 }, probability: p }, ['candidateIndex', 'probability'])), rejected: arraySchema({ type: 'number', minimum: 0, maximum: 63 }) }, ['registryVersion', 'accepted', 'rejected']),
];
const output = (battery: string, value: Record<string, unknown>) => ({ anyOf: [
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(1), status: literal('settled'), value, readings, outcome: outcomes, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'value', 'readings', 'outcome', 'evidence']),
  objectSchema({ protocolVersion: literal(1), requestId: STRING_SCHEMA, battery: literal(battery), batteryVersion: literal(1), status: literal('held'), reason: literal('uncertain'), readings, outcome: outcomes, evidence }, ['protocolVersion', 'requestId', 'battery', 'batteryVersion', 'status', 'reason', 'readings', 'outcome', 'evidence']),
] });

export const builtinBrowserJudgmentMethodDescriptors = [methodDescriptor({
  id: 'judgment.battery.run', title: 'Run Browser Judgment Battery', category: 'judgment',
  description: 'Run one explicitly installed, authorized browser battery. Unconfigured services and unresolved or unauthorized input remain held.',
  access: 'authenticated', scopes: ['write:judgment'], transport: ['http'], invokable: false,
  http: { method: 'POST', path: BROWSER_JUDGMENT_PATH },
  inputSchema: { anyOf: inputs.map(([battery, input]) => envelope(battery, input)) },
  outputSchema: { anyOf: inputs.map(([battery], index) => output(battery, values[index]!)) },
  metadata: { directHttpOnly: true, retry: false, protocolVersion: 1 },
})];
