import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureCatalogData, captureCatalogSnapshot, captureCatalogSnapshotGuard } from '../../tools/agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  // Synthetic native protocol controls, without live semantic or timing claims.
  const readings = fakePort((name, question) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile'))
      return choiceAnswer(question, 'other', 0.999);
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name) && question.type === 'noul')
      return noulAnswer(0.001);
    throw new Error('Unscripted paired workspace privacy question');
  });
  previous = installJudgmentPort(readings.port);
});
afterEach(async () => {
  try { await cleanupResearchScreeningFixtures(); }
  finally { installJudgmentPort(previous); }
});

function workspaceData() {
  const row = { id: 'workspace-note', text: 'Complete ordinary native row tail' };
  const rows = [row];
  Object.defineProperty(rows, '0', { value: row, enumerable: false, writable: true, configurable: true });
  const source = { first: row, second: row, rows };
  Object.defineProperty(source, 'hidden', { value: { text: 'Complete hidden native tail' }, enumerable: false, configurable: true });
  return { row, rows, source };
}

function refusal(read: () => unknown): string {
  try { read(); return 'accepted'; }
  catch (error) {
    if (!(error instanceof ToolInputProjectionError)) throw error;
    return error.problem;
  }
}

function proposalParts(calls: ReturnType<typeof researchScreeningFixture>['calls']): readonly (readonly string[])[] {
  const proposals: string[][] = [];
  for (const call of calls) {
    if (call.path !== '/v1/chat/completions') continue;
    const messages: unknown = call.body.messages;
    if (!Array.isArray(messages)) throw new Error('Missing native screening messages');
    const message: unknown = messages[1];
    if (!message || typeof message !== 'object' || !('content' in message) || typeof message.content !== 'string')
      throw new Error('Missing complete native screening source');
    const source: unknown = JSON.parse(message.content);
    if (!source || typeof source !== 'object' || !('parts' in source) || !Array.isArray(source.parts))
      throw new Error('Missing complete source parts');
    const parts: string[] = [];
    for (const part of source.parts) {
      if (typeof part !== 'string') throw new Error('Unsupported source part');
      parts.push(part);
    }
    proposals.push(parts);
  }
  return proposals;
}

test('paired workspace capture exposes the existing full frozen copy without freezing borrowed data', () => {
  const { source, row, rows } = workspaceData();
  const paired = captureCatalogSnapshot(source), independent = captureCatalogData(source);
  expect(Object.getOwnPropertyDescriptors(paired.captured)).toEqual(Object.getOwnPropertyDescriptors(independent));
  expect(Reflect.ownKeys(paired.captured)).toEqual(Reflect.ownKeys(source));
  expect(Object.getPrototypeOf(paired.captured)).toBe(null);
  expect(Object.getPrototypeOf(paired.captured.first)).toBe(null);
  expect(Object.getPrototypeOf(paired.captured.rows)).toBe(Array.prototype);
  expect(paired.captured.first).toBe(paired.captured.second);
  expect(paired.captured.rows[0]).toBe(paired.captured.first);
  expect(Object.getOwnPropertyDescriptor(paired.captured.rows, '0')?.enumerable).toBe(false);
  expect(Object.getOwnPropertyDescriptor(paired.captured, 'hidden')?.enumerable).toBe(false);
  expect(Object.isFrozen(paired.captured)).toBe(true);
  expect(Object.isFrozen(paired.captured.first)).toBe(true);
  expect(Object.isFrozen(paired.captured.rows)).toBe(true);
  expect(Object.isFrozen(Object.getOwnPropertyDescriptor(paired.captured, 'hidden')?.value)).toBe(true);
  expect(Object.isFrozen(source)).toBe(false); expect(Object.isFrozen(row)).toBe(false); expect(Object.isFrozen(rows)).toBe(false);
  paired.assertCurrent(source);
  row.text = 'Changed live native row';
  expect(paired.captured.first.text).toBe('Complete ordinary native row tail');
  expect(refusal(() => paired.assertCurrent(source))).toBe('held');
});

function descriptorLayout(value: unknown, seen = new Map<object, number>()): unknown {
  if (value === null || typeof value !== 'object') return { value };
  const existing = seen.get(value);
  if (existing !== undefined) return { alias: existing };
  const index = seen.size; seen.set(value, index);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return {
    index, prototype: Object.getPrototypeOf(value), array: Array.isArray(value),
    slots: Reflect.ownKeys(descriptors).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('Unsupported native fixture descriptor');
      return { key, enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable,
        value: descriptorLayout(descriptor.value, seen) };
    }),
  };
}

test('paired and guard-only construction keep one identical complete native descriptor acquisition', () => {
  const source = workspaceData().source;
  const borrowed = new Set<unknown>([source, source.first, source.rows, Object.getOwnPropertyDescriptor(source, 'hidden')?.value]);
  const native = Object.getOwnPropertyDescriptors;
  const subjects: unknown[] = [];
  const observed = (() => {
    try {
      Object.getOwnPropertyDescriptors = subject => { subjects.push(subject); return native(subject); };
      const guard = captureCatalogSnapshotGuard(source), originalSubjects = subjects.slice();
      subjects.length = 0;
      const paired = captureCatalogSnapshot(source), pairedSubjects = subjects.slice();
      return { guard, paired, originalSubjects, pairedSubjects };
    } finally { Object.getOwnPropertyDescriptors = native; }
  })();
  // Assertions run after restoration and cannot extend the observed operation trace.
  expect(observed.pairedSubjects).toHaveLength(observed.originalSubjects.length);
  observed.originalSubjects.forEach((subject, index) => {
    const current = observed.pairedSubjects[index];
    if (borrowed.has(subject)) expect(current).toBe(subject);
    else {
      expect(borrowed.has(current)).toBe(false); expect(current).not.toBe(subject);
      expect<unknown>(descriptorLayout(current)).toEqual(descriptorLayout(subject));
    }
  });
  const independent = captureCatalogData(source);
  expect(observed.paired.captured).not.toBe(independent);
  expect<unknown>(descriptorLayout(observed.paired.captured)).toEqual(descriptorLayout(independent));
  expect(observed.paired.assertCurrent.name).toBe(observed.guard.name);
});

test('paired construction and fresh guards retain invalid and held precedence without invoking private accessors', () => {
  let touched = 0;
  const accessor = Object.defineProperty({ visible: 'Ordinary native value' }, 'hidden', { get() { touched++; return 'unused'; } });
  const proxy = new Proxy({}, { ownKeys() { touched++; return []; }, getPrototypeOf() { touched++; return null; } });
  const privateTail = { changed: 'Changed first field', tail: accessor };
  let deep: unknown = 'Native leaf';
  for (let level = 0; level < 65; level++) deep = { child: deep };
  for (const unsupported of [accessor, proxy, deep, { text: 'x'.repeat(1_000_001) }]) {
    expect(refusal(() => captureCatalogSnapshot(unsupported))).toBe('invalid');
    expect(refusal(() => captureCatalogSnapshotGuard(unsupported))).toBe('invalid');
  }
  const original = { changed: 'Original first field', tail: { visible: 'Ordinary native value' } };
  const paired = captureCatalogSnapshot(original), guard = captureCatalogSnapshotGuard(original);
  expect(refusal(() => paired.assertCurrent(privateTail))).toBe('held');
  expect(refusal(() => guard(privateTail))).toBe('held');
  const sparse = new Array<unknown>(1), capturedSparse = captureCatalogSnapshot(sparse);
  expect(refusal(() => captureModelReadingInput(sparse))).toBe('invalid');
  expect(refusal(() => captureModelReadingInput(capturedSparse.captured))).toBe('invalid');
  expect(touched).toBe(0);
});

test('paired fresh comparison preserves enumerable order, hidden flags, alias shapes, and prototype restrictions', () => {
  const first = { first: 'Native first', second: 'Native second' };
  const second = { second: 'Native second', first: 'Native first' };
  const source = { left: first, right: second };
  Object.defineProperty(source, 'hidden', { value: 'Native hidden value', enumerable: false });
  const paired = captureCatalogSnapshot(source), guard = captureCatalogSnapshotGuard(source);
  const originalShape = () => Object.defineProperty({ left: { ...first }, right: { ...second } }, 'hidden', { value: 'Native hidden value', enumerable: false });
  paired.assertCurrent(originalShape()); guard(originalShape());
  const reordered = Object.defineProperty({ right: { ...second }, left: { ...first } }, 'hidden', { value: 'Native hidden value', enumerable: false });
  const shared = Object.defineProperty({ left: first, right: first }, 'hidden', { value: 'Native hidden value', enumerable: false });
  const hiddenChanged = Object.defineProperty({ left: first, right: second }, 'hidden', { value: 'Native hidden value', enumerable: true });
  const foreign = originalShape(); Object.setPrototypeOf(foreign, { inherited: 'Unsupported native shape' });
  for (const current of [reordered, shared, hiddenChanged, foreign]) {
    expect(refusal(() => paired.assertCurrent(current))).toBe('held');
    expect(refusal(() => guard(current))).toBe('held');
  }
  paired.assertCurrent(originalShape());
});

test('paired model input keeps complete hidden screening and every native source and caller boundary', async () => {
  const live = { id: 'workspace-note', text: 'Complete native source tail' };
  const fresh = () => Object.defineProperty({ rows: [live] }, 'hidden', { value: { text: 'Complete hidden workspace tail' }, enumerable: false });
  const run = async (usePair: boolean) => {
    const original = fresh(), paired = captureCatalogSnapshot(original), phases: string[] = [];
    const screening = researchScreeningFixture({ beforeProposal: async () => { phases.push('screen'); } });
    const result = await withModelReadingSource(usePair ? paired.captured : original, {
      sourceOwner: screening.owner,
      assertCurrent() {
        phases.push('source'); paired.assertCurrent(fresh());
        phases.push('caller');
        phases.push('source'); paired.assertCurrent(fresh());
      },
    }, async (captured, current) => {
      phases.push('consume'); current.assertCurrent?.();
      expect(captured).toEqual(captureModelReadingInput(original));
      return captured;
    });
    return { result, phases, parts: proposalParts(screening.calls), paired };
  };
  const original = await run(false), paired = await run(true);
  expect(paired.result).toEqual(original.result);
  expect(paired.parts).toEqual(original.parts);
  expect(paired.phases).toEqual(original.phases);
  expect(JSON.stringify(paired.parts)).toContain('Complete native source tail');
  expect(JSON.stringify(paired.parts)).toContain('Complete hidden workspace tail');
  live.text = 'Changed after native release';
  expect(refusal(() => paired.paired.assertCurrent(fresh()))).toBe('held');
  live.text = 'Complete native source tail';
  paired.paired.assertCurrent(fresh());
});

test('detached workspace baseline does not authorize changed live data, late getters, or cancellation during screening', async () => {
  for (const change of ['hidden', 'accessor', 'cancel']) {
    const live = { text: 'Complete ordinary native source' }, controller = new AbortController();
    const fresh = () => Object.defineProperty({ rows: [live] }, 'hidden', { value: live, enumerable: false });
    const paired = captureCatalogSnapshot(fresh());
    let consumed = false, touched = 0;
    const screening = researchScreeningFixture({ beforeProposal: async () => {
      if (change === 'hidden') live.text = 'Changed complete hidden native source';
      else if (change === 'accessor') Object.defineProperty(live, 'text', { get() { touched++; return 'unused'; } });
      else controller.abort();
    } });
    await expect(withModelReadingSource(paired.captured, { sourceOwner: screening.owner, signal: controller.signal,
      assertCurrent: () => paired.assertCurrent(fresh()),
    }, async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false); expect(touched).toBe(0); expect(screening.calls.length).toBeGreaterThan(0);
  }
});

test('complete hidden private data is refused before source wire and post-body source changes prevent publication', async () => {
  for (const privateValue of ['4111111111111111', `ghp_${'A'.repeat(36)}`]) {
    const original = Object.defineProperty({ text: 'Ordinary native source' }, 'hidden', { value: privateValue, enumerable: false });
    const paired = captureCatalogSnapshot(original), screening = researchScreeningFixture();
    let consumed = false;
    await expect(withModelReadingSource(paired.captured, { sourceOwner: screening.owner, assertCurrent: () => paired.assertCurrent(original) }, async () => { consumed = true; })).rejects.toThrow();
    expect(consumed).toBe(false); expect(screening.calls).toHaveLength(0);
  }
  const live = { text: 'Original complete native source' }, fresh = () => ({ rows: [live] });
  const paired = captureCatalogSnapshot(fresh()), screening = researchScreeningFixture();
  let consumed = false;
  await expect(withModelReadingSource(paired.captured, { sourceOwner: screening.owner, assertCurrent: () => paired.assertCurrent(fresh()) }, async () => {
    consumed = true; live.text = 'Changed after native body'; return 'Must not publish';
  })).rejects.toThrow();
  expect(consumed).toBe(true); expect(screening.calls.length).toBeGreaterThan(0);
});
