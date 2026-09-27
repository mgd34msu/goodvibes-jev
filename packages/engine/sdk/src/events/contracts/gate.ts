/**
 * Field contracts for the `gate` runtime domain (events/gate.ts). One spec per
 * event type, keyed by the type so the table is exhaustive: adding an event
 * type without its spec is a compile error.
 */
import type { GateEventType } from '../gate.js';
import { validateEventFields, type ContractResult, type FieldSpec } from './shared.js';

const str = (key: string): FieldSpec => ({ key, kind: 'string' });
const optStr = (key: string): FieldSpec => ({ key, kind: 'string', optional: true });
const num = (key: string): FieldSpec => ({ key, kind: 'number' });
const bool = (key: string): FieldSpec => ({ key, kind: 'boolean' });
const optBool = (key: string): FieldSpec => ({ key, kind: 'boolean', optional: true });
const strs = (key: string): FieldSpec => ({ key, kind: 'string[]' });
const optStrs = (key: string): FieldSpec => ({ key, kind: 'string[]', optional: true });
const oneOf = (key: string, values: readonly string[]): FieldSpec => ({ key, kind: 'enum', values });

const STAKES = ['low', 'medium', 'high', 'critical'] as const;
const RULE_RESULTS = ['allow', 'deny', 'unknown'] as const;
const PRESET_RESULTS = ['allow', 'ask', 'deny'] as const;
const CHECK_RESULTS = ['pass', 'refuse', 'skipped'] as const;
const CALL: readonly FieldSpec[] = [str('callId'), str('tool')];

/** The required and optional fields of every gate event, beside `type`. */
export const GATE_EVENT_FIELD_SPECS: { readonly [T in GateEventType]: readonly FieldSpec[] } = {
  GATE_REQUESTED: [
    ...CALL,
    { key: 'args', kind: 'object', fields: [] },
    str('category'),
    optStr('classification'),
    optStr('riskLevel'),
    optStr('summary'),
    optStrs('reasons'),
  ],
  RULES_COLLECTED: [...CALL, num('ruleCount')],
  INPUT_NORMALIZED: [...CALL],
  POLICY_EVALUATED: [...CALL, oneOf('result', RULE_RESULTS)],
  SESSION_OVERRIDE_EVALUATED: [...CALL, bool('overrideApplied')],
  BOUNDARY_CHECKED: [
    ...CALL,
    bool('passed'),
    optStr('refusedBy'),
    { key: 'checks', kind: 'object[]', fields: [str('check'), oneOf('result', CHECK_RESULTS)] },
  ],
  STAKES_READ: [
    ...CALL,
    str('family'),
    oneOf('stakes', STAKES),
    bool('mutates'),
    bool('outward'),
    bool('secrets'),
    bool('irreversible'),
    bool('beyondProject'),
    bool('weakensSecurity'),
    bool('obfuscated'),
    strs('uncertain'),
  ],
  PRESET_EVALUATED: [...CALL, str('preset'), oneOf('stakes', STAKES), oneOf('result', PRESET_RESULTS)],
  PRESET_CHANGED: [str('preset'), str('previousPreset'), str('mode'), str('previousMode')],
  DECISION_EMITTED: [
    ...CALL,
    bool('approved'),
    str('source'),
    optStr('sourceLayer'),
    optBool('persisted'),
    optStr('reasonCode'),
    optStr('classification'),
    optStr('riskLevel'),
    optStr('summary'),
  ],
};

/** One validator per gate event type, for the EVENT_VALIDATORS registry. */
export const GATE_EVENT_VALIDATORS: { readonly [T in GateEventType]: (v: unknown) => ContractResult } = Object.fromEntries(
  Object.entries(GATE_EVENT_FIELD_SPECS).map(([type, fields]) => [type, (v: unknown) => validateEventFields(type, v, fields)]),
) as { readonly [T in GateEventType]: (v: unknown) => ContractResult };
