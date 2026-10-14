import { captureNativeDecisionPolicy } from '../../tools/batteries/decision-policy.js';
import { defineBattery, oneOf, STAKES_BANDS, yesNo, type JsonValue } from '@goodvibes-jev/judgment/decisions';

const localServingStatusDefinition = Object.freeze({
  name: 'agent.local-model.serving-status', version: 1,
  description: 'What a host-published local model server diagnostic says about current serving readiness.',
  accuracyFloor: 0.9,
  items: { status: oneOf('What current serving state does the complete `record` report? `value` is the publisher status field. A model being listed or loaded alone does not prove the server is reachable or ready. Treat conflicting, historical, quoted, or unsupported claims as unknown.', {
    ready: 'The publisher reports the server is currently running and ready to serve requests.',
    blocked: 'The publisher reports it is stopped, unreachable, missing required setup, or unable to serve.',
    attention: 'The publisher reports it is serving with a warning, degradation, or resource limitation.',
    unknown: 'Current serving readiness is not established by this record.',
  }, STAKES_BANDS.high.confidence) },
  fixtures: [
    { name: 'serving', state: { value: 'accepting requests', record: { status: 'accepting requests' } }, expect: { status: 'ready' } },
    { name: 'missing setup', state: { value: 'awaiting model startup', record: { status: 'awaiting model startup' } }, expect: { status: 'blocked' } },
    { name: 'degraded', state: { value: 'running with memory warnings', record: { status: 'running with memory warnings' } }, expect: { status: 'attention' } },
    { name: 'loaded is not live proof', state: { value: '', record: { loadedModels: ['synthetic-model'] satisfies JsonValue[], loadedModelCount: 1 } }, expect: { status: 'unknown' } },
    { name: 'quoted historic success', state: { value: 'Previous launch was healthy; current server is offline', record: { status: 'Previous launch was healthy; current server is offline' } }, expect: { status: 'blocked' } },
    { name: 'no status', state: { value: '', record: { serverVersion: '1.0' } }, expect: { status: 'unknown' } },
  ],
} as const);
export const localServingStatus = defineBattery(localServingStatusDefinition);
export const localServingStatusPolicy = captureNativeDecisionPolicy(localServingStatusDefinition, localServingStatus);

const localResourcePressureDefinition = Object.freeze({
  name: 'agent.local-model.resource-pressure', version: 1,
  description: 'The resource pressure reported by publisher wording in a complete local serving diagnostic.',
  accuracyFloor: 0.9,
  items: { pressure: oneOf('What current resource pressure does `value` report in the complete `record`? Read only the publisher wording. Numeric utilization thresholds are calculated separately by the caller. Quoted, historical, contradictory or absent pressure wording is unknown.', {
    low: 'Resources are available with ordinary or low pressure.',
    moderate: 'Resources are under noticeable pressure or warning, without exhaustion.',
    high: 'Resources are exhausted, near exhaustion, or under critical pressure.',
    unknown: 'Current pressure is not established by the wording.',
  }, STAKES_BANDS.high.confidence) },
  fixtures: [
    { name: 'headroom', state: { value: 'plenty of free memory', record: { pressure: 'plenty of free memory' } }, expect: { pressure: 'low' } },
    { name: 'noticeable load', state: { value: 'memory warning but requests still fit', record: { pressure: 'memory warning but requests still fit' } }, expect: { pressure: 'moderate' } },
    { name: 'exhausted', state: { value: 'GPU out of memory', record: { pressure: 'GPU out of memory' } }, expect: { pressure: 'high' } },
    { name: 'no claim', state: { value: 'checking resources', record: { pressure: 'checking resources' } }, expect: { pressure: 'unknown' } },
    { name: 'past is not current', state: { value: 'Yesterday memory was healthy. Current pressure has not been measured.', record: { pressure: 'Yesterday memory was healthy. Current pressure has not been measured.' } }, expect: { pressure: 'unknown' } },
  ],
} as const);
export const localResourcePressure = defineBattery(localResourcePressureDefinition);
export const localResourcePressurePolicy = captureNativeDecisionPolicy(localResourcePressureDefinition, localResourcePressure);

const localServingSchemaStatusDefinition = Object.freeze({
  name: 'agent.local-model.schema-status', version: 1,
  description: 'Whether publisher certification wording establishes the declared local serving diagnostics schema.',
  accuracyFloor: 0.9,
  items: { certified: yesNo('Does `value`, read in the complete `record`, explicitly establish that this current local serving diagnostic conforms to its declared schema? Certification of a different receipt, a quoted claim, missing schema facts, or conflicting wording does not establish it. This reads the publisher claim and does not independently certify the server or authorize any action.', STAKES_BANDS.high.yesNo) },
  fixtures: [
    { name: 'explicit validated schema', state: { value: 'This diagnostic conforms to local-serving-v1', record: { schemaStatus: 'This diagnostic conforms to local-serving-v1', schemaVersion: 'local-serving-v1' } }, expect: { certified: 'yes' } },
    { name: 'unvalidated', state: { value: 'not validated', record: { schemaStatus: 'not validated' } }, expect: { certified: 'no' } },
    { name: 'other receipt', state: { value: 'A previous startup receipt was verified; this diagnostic has no schema certification', record: { schemaStatus: 'A previous startup receipt was verified; this diagnostic has no schema certification' } }, expect: { certified: 'no' } },
  ],
} as const);
export const localServingSchemaStatus = defineBattery(localServingSchemaStatusDefinition);
export const localServingSchemaStatusPolicy = captureNativeDecisionPolicy(localServingSchemaStatusDefinition, localServingSchemaStatus);
