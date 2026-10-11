import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import * as contracts from '@goodvibes-jev/engine/sdk/contracts';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureCatalogData, captureCatalogMethods, captureCatalogSnapshotGuard } from '../../tools/agent-harness-catalog-ranking.ts';
import { captureModelReadingInput } from '../../tools/agent-harness-model-reading-source.ts';
import { contractMethodsForLane } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { await cleanupResearchScreeningFixtures(); installJudgmentPort(previous); });

test('compiled backend slots retain inherited, absent, and descriptor ownership without calling new getters', () => {
  const method = () => {};
  const parent = { method }, subject = {};
  Object.setPrototypeOf(subject, parent);
  const assertCurrent = captureCatalogMethods(subject, ['method', 'missing']);
  assertCurrent();
  let touched = 0;
  Object.defineProperty(subject, 'method', { get() { touched++; return method; }, configurable: true });
  expect(assertCurrent).toThrow(); expect(touched).toBe(0);
  Reflect.deleteProperty(subject, 'method'); assertCurrent();
  Object.defineProperty(subject, 'missing', { get() { touched++; return undefined; }, configurable: true });
  expect(assertCurrent).toThrow(); expect(touched).toBe(0);
  Reflect.deleteProperty(subject, 'missing'); assertCurrent();
  Object.defineProperty(parent, 'method', { value: method, enumerable: false });
  expect(assertCurrent).toThrow();
});

test('compiled backend plans reject equal prototype replacement and pin native reflection', () => {
  const method = () => {}, parent = { method }, subject = {};
  Object.setPrototypeOf(subject, parent);
  const assertCurrent = captureCatalogMethods(subject, ['method']);
  Object.setPrototypeOf(subject, { method });
  expect(assertCurrent).toThrow();
  Object.setPrototypeOf(subject, parent);
  const descriptor = Object.getOwnPropertyDescriptor, prototype = Object.getPrototypeOf;
  let touched = 0;
  try {
    Object.getOwnPropertyDescriptor = () => { touched++; return undefined; };
    Object.getPrototypeOf = () => { touched++; return null; };
    parent.method = () => {};
    expect(assertCurrent).toThrow(); expect(touched).toBe(0);
  } finally {
    Object.getOwnPropertyDescriptor = descriptor; Object.getPrototypeOf = prototype;
  }
});

function hidden(value: string, enumerable = false) {
  const record = { visible: 'Native visible data' };
  Object.defineProperty(record, 'hidden', { value: { value }, enumerable, configurable: true });
  return record;
}

test('fresh snapshot comparison observes every hidden value and exact enumerable bit', () => {
  const assertCurrent = captureCatalogSnapshotGuard(hidden('Native hidden data'));
  expect(() => assertCurrent(hidden('Native hidden data'))).not.toThrow();
  expect(() => assertCurrent(hidden('Changed hidden data'))).toThrow();
  expect(() => assertCurrent(hidden('Native hidden data', true))).toThrow();
  expect(() => assertCurrent({ visible: 'Native visible data' })).toThrow();
});

test('enumerable object key reordering retains the original serialized currentness boundary', () => {
  const original = { first: 'Native first value', second: 'Native second value' };
  const reordered = { second: 'Native second value', first: 'Native first value' };
  expect(JSON.stringify(captureCatalogData(reordered))).not.toBe(JSON.stringify(captureCatalogData(original)));
  const assertCurrent = captureCatalogSnapshotGuard(original);
  assertCurrent({ ...original });
  expect(() => assertCurrent(reordered)).toThrow();
});

test('alias reuse cannot merge expected objects with different enumerable key orders', () => {
  const first = { first: 'Native first value', second: 'Native second value' };
  const second = { second: 'Native second value', first: 'Native first value' };
  const original = { left: first, right: second }, shared = { left: first, right: first };
  expect(JSON.stringify(captureCatalogData(shared))).not.toBe(JSON.stringify(captureCatalogData(original)));
  const assertCurrent = captureCatalogSnapshotGuard(original);
  assertCurrent({ left: { ...first }, right: { ...second } });
  expect(() => assertCurrent(shared)).toThrow();
});

test('a frozen parent cannot hide a changed mutable descendant or a new own field', () => {
  const child = { value: 'Original descendant' }, source = Object.freeze({ child });
  const assertCurrent = captureCatalogSnapshotGuard(source);
  assertCurrent(source);
  child.value = 'Changed descendant';
  expect(() => assertCurrent(source)).toThrow();
  expect(() => assertCurrent({ child: { value: 'Original descendant', extra: true } })).toThrow();
});

test.each(['proxy', 'accessor', 'symbol', 'function', 'nonfinite', 'cycle', 'prototype', 'toJSON', 'array-constructor', 'array-hole'] as const)
  ('fresh %s DTOs cannot bypass structural capture restrictions', kind => {
    let touched = 0;
    const source = { value: 'Original value' };
    let current: unknown = { value: 'Original value' };
    if (kind === 'proxy') current = new Proxy(source, {
      get() { touched++; return undefined; }, ownKeys() { touched++; return []; }, getPrototypeOf() { touched++; return null; },
    });
    if (kind === 'accessor') Object.defineProperty(current, 'value', { get() { touched++; return 'Original value'; } });
    if (kind === 'symbol') Object.defineProperty(current, Symbol('hidden'), { value: 'Original value' });
    if (kind === 'function') current = { value: () => 'Original value' };
    if (kind === 'nonfinite') current = { value: Number.NaN };
    if (kind === 'cycle') { const cyclic: { value: unknown } = { value: undefined }; cyclic.value = cyclic; current = cyclic; }
    if (kind === 'prototype') Object.setPrototypeOf(current, { extra: true });
    if (kind === 'toJSON') Object.defineProperty(current, 'toJSON', { value: () => { touched++; return source; } });
    if (kind === 'array-constructor' || kind === 'array-hole') {
      const array = ['Original value'];
      current = kind === 'array-hole' ? new Array<unknown>(1) : array;
      if (kind === 'array-constructor') Object.defineProperty(array, 'constructor', { value: Array });
      expect(() => captureCatalogSnapshotGuard(['Original value'])(current)).toThrow();
    } else expect(() => captureCatalogSnapshotGuard(source)(current)).toThrow();
    expect(touched).toBe(0);
  });

test.each(['nodes', 'characters', 'slots'] as const)('equal fresh DTOs still enforce the original %s budget', kind => {
  let source: unknown, current: unknown;
  if (kind === 'nodes') {
    const shared = { a: 0, b: 0, c: 0, d: 0, e: 0 };
    source = Array.from({ length: 20_000 }, () => shared);
    current = Array.from({ length: 20_000 }, () => ({ ...shared }));
  } else if (kind === 'characters') {
    const shared = { value: 'x'.repeat(300) };
    source = Array.from({ length: 5_000 }, () => shared);
    current = Array.from({ length: 5_000 }, () => ({ ...shared }));
  } else {
    const shared = Array.from({ length: 20_000 }, () => 0);
    source = Array.from({ length: 6 }, () => shared);
    current = Array.from({ length: 6 }, () => Array.from({ length: 20_000 }, () => 0));
  }
  const assertCurrent = captureCatalogSnapshotGuard(source);
  assertCurrent(source);
  expect(() => captureCatalogData(current)).toThrow();
  expect(() => assertCurrent(current)).toThrow();
});

test('initial complete capture retains depth limits and fresh alias equivalence', () => {
  let deep: unknown = 'Native leaf';
  for (let level = 0; level < 65; level++) deep = { child: deep };
  expect(() => captureCatalogSnapshotGuard(deep)).toThrow();
  const assertCurrent = captureCatalogSnapshotGuard({ left: { value: 'Same data' }, right: { value: 'Same data' } });
  const shared = { value: 'Same data' };
  expect(() => assertCurrent({ left: shared, right: shared })).not.toThrow();
});

function membershipReadings(evidence: ReadonlyMap<string, string>, selected: string | undefined, beforeMatch?: () => void) {
  let entered = false;
  const fake = fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile'))
      return choiceAnswer(question, 'other', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name) && question.type === 'noul')
      return noulAnswer(0.001);
    if (name !== 'match' || question.type !== 'noul' || !state || typeof state !== 'object' || Array.isArray(state)
      || state.query !== 'tasks' || !state.candidate || typeof state.candidate !== 'object' || Array.isArray(state.candidate)
      || typeof state.candidate.name !== 'string' || typeof state.candidate.evidenceJson !== 'string'
      || evidence.get(state.candidate.name) !== state.candidate.evidenceJson) throw new Error('Unscripted native ownership request');
    entered = true; beforeMatch?.();
    return noulAnswer(state.candidate.name === selected ? 0.999 : 0.001);
  });
  return { ...fake, entered: () => entered };
}

test('actual immutable native metadata retains fresh owner screening and refuses equal root replacement', async () => {
  const native = contracts.OPERATOR_CONTRACT, selected = native.operator.methods.find(method => method.id === 'accounts.snapshot');
  if (!selected?.description || selected.invokable !== true) throw new Error('Missing actual native ownership control');
  const evidence = new Map(native.operator.methods.map(method => [method.id, JSON.stringify(captureModelReadingInput(method))]));
  const first = membershipReadings(evidence, selected.id), screening = researchScreeningFixture();
  installJudgmentPort(first.port);
  const result = await contractMethodsForLane('tasks', { sourceOwner: screening.owner });
  expect(result.available).toEqual([selected.id]); expect(first.entered()).toBe(true);

  const refused = membershipReadings(evidence, selected.id), untouched = researchScreeningFixture();
  installJudgmentPort(refused.port);
  const controller = new AbortController(); controller.abort();
  await expect(contractMethodsForLane('tasks', { sourceOwner: untouched.owner, signal: controller.signal })).rejects.toThrow();
  await expect(contractMethodsForLane('tasks', { sourceOwner: untouched.owner, assertCurrent() { throw new Error('Native caller retired'); } })).rejects.toThrow('Native caller retired');
  expect(untouched.calls).toHaveLength(0); expect(refused.entered()).toBe(false);

  const held = membershipReadings(evidence, selected.id), privateOwner = researchScreeningFixture({ spans: exactSensitiveSpans([selected.description]) });
  installJudgmentPort(held.port);
  await expect(contractMethodsForLane('tasks', { sourceOwner: privateOwner.owner })).rejects.toThrow();
  expect(held.entered()).toBe(false);

  const replacement = Object.freeze({ ...native });
  const getter = spyOn(contracts, 'getOperatorContract').mockReturnValue(native);
  const retired = membershipReadings(evidence, selected.id), changing = researchScreeningFixture({ beforeProposal: async () => { getter.mockReturnValue(replacement); } });
  installJudgmentPort(retired.port);
  try {
    await expect(contractMethodsForLane('tasks', { sourceOwner: changing.owner })).rejects.toThrow();
    expect(retired.entered()).toBe(false);
  } finally { getter.mockRestore(); }
}, 60_000);

test('foreign frozen parents retain mutable descendants through native owner awaits', async () => {
  const original = contracts.OPERATOR_CONTRACT.operator.methods[0];
  if (!original) throw new Error('Missing native fixture shape');
  const child = { value: 'Native mutable original' };
  const method = Object.freeze({ ...original, id: 'native.fixture-ownership', metadata: Object.freeze({ child }) });
  const native = contracts.OPERATOR_CONTRACT;
  const manifest = Object.freeze({ ...native, operator: Object.freeze({ ...native.operator, methods: Object.freeze([method]) }) });
  const getter = spyOn(contracts, 'getOperatorContract').mockReturnValue(manifest);
  const evidence = new Map([[method.id, JSON.stringify(captureModelReadingInput(method))]]);
  const fake = membershipReadings(evidence, method.id), screening = researchScreeningFixture({ beforeProposal: async () => { child.value = 'Changed during native privacy'; } });
  installJudgmentPort(fake.port);
  try {
    await expect(contractMethodsForLane('tasks', { sourceOwner: screening.owner })).rejects.toThrow();
    expect(fake.entered()).toBe(false);
  } finally { getter.mockRestore(); }
});
