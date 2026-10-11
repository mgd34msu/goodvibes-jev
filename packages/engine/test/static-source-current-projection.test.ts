import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStaticInputs, loadStaticSourceReadings, projectCurrentStaticSourceReadings, saveStaticSourceReadings, staticDecisionSourceHash, staticInputCaptureComplete, staticInputKey, staticInputStanding, type StaticSourceReadings } from '../scripts/static-source-readings.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'sdk/src/example.ts', '// Public source\nconst value = 3;')[0]!;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

test('current projection retains complete held subset evidence and leaves private history unchanged', async () => {
  const captured = input();
  const prepared = await preparedStaticReadings([captured], .5);
  const receipt = prepared.readings[staticInputKey(captured)];
  if (!object(receipt) || !Array.isArray(receipt.parts)) throw new Error('Missing exact captured subsets');
  const prior = { oldRawProbability: .989999, requestId: 'old-request', sourceHash: 'old-source' };
  const withHistory = { ...receipt, previousCaptures: [prior], parts: receipt.parts.map(part => {
    if (!object(part)) throw new Error('Missing subset receipt');
    return { ...part, previousCaptures: [prior] };
  }) };
  const current = { ...prepared, readings: { [staticInputKey(captured)]: withHistory, obsolete: prior } };
  const original = JSON.stringify(current);
  const projected = projectCurrentStaticSourceReadings([captured], current);
  expect(Object.keys(projected.readings)).toEqual([staticInputKey(captured)]);
  expect(projected.readings[staticInputKey(captured)]).toEqual({ ...receipt, parts: receipt.parts });
  expect(JSON.stringify(current)).toBe(original);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputStanding(captured, projected)).toEqual(staticInputStanding(captured, current));
  expect(staticInputCaptureComplete(captured, projected)).toBe(staticInputCaptureComplete(captured, current));
  expect(staticInputCaptureComplete(captured, projected)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'static-current-projection-'));
  try {
    const privatePath = join(root, 'checkpoint.json');
    const canonicalPath = join(root, 'current.json.gz');
    saveStaticSourceReadings(current, privatePath);
    saveStaticSourceReadings(projected, canonicalPath);
    expect(loadStaticSourceReadings(privatePath)).toEqual(current);
    expect(loadStaticSourceReadings(canonicalPath)).toEqual(projected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('all active transitive capture manifests and original numeric answers survive projection', () => {
  const captured = input();
  const originalProbability = .989999;
  const currentHash = staticDecisionSourceHash();
  const current: StaticSourceReadings = { format: 1, decisionSourceHash: currentHash, readings: {
    [staticInputKey(captured)]: { decisionSourceHash: 'root-capture', validatedDecisionSourceHash: currentHash,
      presence: { captureDecisionSourceHash: 'presence-capture', answers: { violation: { type: 'noul', noul: originalProbability } } },
      parts: [{ decisionSourceHash: 'child-capture', selection: { captureDecisionSourceHash: 'selector-capture', answers: { untouched: originalProbability } }, parts: [], previousCaptures: [{ decisionSourceHash: 'obsolete-capture' }] }],
      previousCaptures: [{ decisionSourceHash: 'obsolete-capture' }] },
    obsolete: { decisionSourceHash: 'obsolete-capture' } },
    captureSources: Object.fromEntries([currentHash, 'root-capture', 'presence-capture', 'child-capture', 'selector-capture', 'obsolete-capture'].map(key => [key, [['exact-source', key]]])),
    captureBatterySources: Object.fromEntries([currentHash, 'root-capture', 'presence-capture', 'child-capture', 'selector-capture', 'obsolete-capture'].map(key => [key, `exact battery bytes ${key}`])) };
  const projected = projectCurrentStaticSourceReadings([captured], current);
  for (const key of [currentHash, 'root-capture', 'presence-capture', 'child-capture', 'selector-capture']) {
    expect(projected.captureSources?.[key]).toEqual(current.captureSources?.[key]);
    expect(projected.captureBatterySources?.[key]).toBe(current.captureBatterySources?.[key]);
  }
  expect(projected.captureSources).not.toHaveProperty('obsolete-capture');
  expect(projected.captureBatterySources).not.toHaveProperty('obsolete-capture');
  expect(projected.readings[staticInputKey(captured)]).toMatchObject({ presence: { answers: { violation: { noul: originalProbability } } }, parts: [{ selection: { answers: { untouched: originalProbability } } }] });
  expect(staticInputStanding(captured, projected)).toEqual(staticInputStanding(captured, current));
  expect(staticInputStanding(captured, projected).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, projected)).toBe(false);
});

test('projection cannot adopt an inherited historical root or turn missing evidence into a capture', async () => {
  const captured = input();
  const prepared = await preparedStaticReadings([captured]);
  const missing = { ...captured, sourceHash: 'new-source' };
  const roots = Object.create(prepared.readings);
  Object.defineProperty(roots, '__proto__', { value: { rawHistory: .123456789 }, enumerable: true });
  const current = { ...prepared, readings: roots };
  const projected = projectCurrentStaticSourceReadings([captured, missing], current);
  expect(projected.readings).toEqual({});
  expect(Object.hasOwn(current.readings, '__proto__')).toBe(true);
  for (const source of [captured, missing]) {
    expect(staticInputStanding(source, projected)).toEqual(staticInputStanding(source, current));
    expect(staticInputStanding(source, projected).kind).toBe('held');
    expect(staticInputCaptureComplete(source, projected)).toBe(false);
  }
});
