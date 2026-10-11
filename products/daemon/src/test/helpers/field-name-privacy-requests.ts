import { expect } from 'bun:test';
import { fieldKind } from '@goodvibes-jev/engine/sdk/platform/utils';

interface ObservedRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, unknown>>;
  readonly context?: { readonly battery?: string; readonly site?: string } | undefined;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// These exact field names come from native logger metadata. This observer grants
// no field role and supplies no answer for a source or residual privacy reading.
const fixtureFields = {
  battery: 'decision metadata', count: 'model-catalog definition count', sampleIds: 'model-catalog definition IDs',
  gitDir: 'checkpoint side repository', dir: 'native archetype/contract storage', path: 'checkpoint/worktree repository path',
  key: 'selected secret-store key', source: 'selected secret-store tier',
  branch: 'native worktree branch', agentId: 'native worktree agent ID', model: 'native agent model',
  targetId: 'native contract gate target', gate: 'native contract gate identity',
  passed: 'native contract gate result', skipped: 'native contract gate skipped state',
  contractId: 'native contract identity', provider: 'native agent provider', toolCallCount: 'native agent tool-call count',
};

/** Preserve every request; distinguish only the complete canonical field-name reader. */
export function isFieldNamePrivacyRequest(request: ObservedRequest): boolean {
  const kind = request.questions.kind;
  const claimed = request.context?.battery === 'engine.redaction.field-kind';
  const wire = request.context === undefined && record(request.state) && Object.hasOwn(request.state, 'field')
    && record(kind) && kind.type === 'choice' && record(kind.criteria) && Object.hasOwn(kind.criteria, 'owner_profile');
  if (!claimed && !wire) return false;
  if (request.context !== undefined) {
    expect(request.context.battery).toBe('engine.redaction.field-kind');
    expect(request.context.site).toBe('engine.redaction.field-kind');
  }
  expect(Object.keys(request.questions)).toEqual(['kind']);
  expect(record(kind)).toBe(true);
  if (!record(kind)) throw new Error('Invalid native field-name reading question.');
  expect(kind.type).toBe('choice');
  expect(record(kind.criteria)).toBe(true);
  if (!record(kind.criteria)) throw new Error('Invalid native field-name reading criteria.');
  expect(Object.keys(kind.criteria).sort()).toEqual(['content', 'other', 'owner_profile', 'secret']);
  expect<unknown>(kind).toEqual(fieldKind.items.kind.question);
  expect(record(request.state)).toBe(true);
  if (!record(request.state)) throw new Error('Invalid native field-name reading source.');
  expect(Object.keys(request.state)).toEqual(['field']);
  expect(typeof request.state.field).toBe('string');
  expect(request.state.field).toBeOneOf(Object.keys(fixtureFields));
  if (typeof request.state.field !== 'string' || !Object.hasOwn(fixtureFields, request.state.field)) {
    throw new Error('Unscripted fixture field-name privacy source.');
  }
  return true;
}

/** All other semantic requests remain visible to the original operation assertions. */
export function operationJudgmentRequests<T extends ObservedRequest>(requests: readonly T[]): T[] {
  return requests.filter(request => !isFieldNamePrivacyRequest(request));
}
