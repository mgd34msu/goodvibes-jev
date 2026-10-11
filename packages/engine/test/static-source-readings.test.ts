import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SqliteDecisionLog, validateContextBudget, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, loadStaticSourceJournal, loadStaticSourceReadings, openStaticSourceJournal, parseStaticSourceReadings, readStaticInput, revalidateStaticInput, saveStaticSourceReadings, sha256, staticDecisionSourceHash, staticDecisionSourceManifest, staticInputCaptureComplete, staticInputKey, staticInputStanding, staticSelectionCandidates, staticSelectionContext, type StaticSourceReadings } from '../scripts/static-source-readings.ts';
import { staticOffendingAnchor } from '../scripts/batteries/static-source.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'sdk/src/example.ts', '// Exact public source\nconst value = 3;')[0]!;

test('a durable interrupted subset tree resumes only its missing call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-partial-subsets-'));
  try {
    const captured = input();
    const journalPath = join(root, 'checkpoint.journal');
    const logPath = join(root, 'calls.sqlite');
    const readings: Record<string, unknown> = {};
    const current: StaticSourceReadings = { format: 1, decisionSourceHash: staticDecisionSourceHash(), readings };
    {
      using log = new SqliteDecisionLog(logPath);
      using journal = openStaticSourceJournal(journalPath);
      journal.append(current);
      const fixture = fakePort((_name, _question, state) => {
        if (typeof state !== 'object' || state === null || !('anchors' in state) || !Array.isArray(state.anchors)) throw new Error('Unexpected state');
        return noulAnswer(state.anchors.length > 1 ? 0.5 : 0.01);
      });
      let calls = 0;
      const interrupted: JudgmentPort = { model: fixture.port.model, ask(request) {
        if (++calls === 3) throw new Error('Simulated interruption after the first answered subset');
        return fixture.port.ask(request);
      } };
      await expect(readStaticInput(withDecisionLog(interrupted, log), log, captured, undefined, {
        previous: current, onReceipt(source, receipt) {
          readings[staticInputKey(source)] = receipt;
          journal.append({ ...current, readings: { [staticInputKey(source)]: receipt } }, source);
        },
      })).rejects.toThrow('the judgment provider could not answer');
      expect(log.query({ status: 'answered' })).toHaveLength(2);
      expect(log.query({ status: 'failed' })).toHaveLength(1);
    }
    const retained = loadStaticSourceJournal(journalPath, null);
    if (!retained) throw new Error('Missing durable partial receipts');
    expect(staticInputCaptureComplete(captured, retained)).toBe(false);
    expect(staticInputStanding(captured, retained).kind).toBe('held');
    const rawJournal: unknown = JSON.parse(readFileSync(journalPath, 'utf8').split('\n')[1]!);
    expect(rawJournal).toMatchObject({ capturedInput: captured });
    const rootPresence = retained.readings[staticInputKey(captured)];
    const mutable = { ...retained.readings };
    const resumed = { ...retained, readings: mutable };
    using log = new SqliteDecisionLog(logPath);
    using journal = openStaticSourceJournal(journalPath);
    const fixture = fakePort(() => noulAnswer(0.01));
    const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured, undefined, {
      previous: resumed, onReceipt(source, value) {
        mutable[staticInputKey(source)] = value;
        journal.append({ ...resumed, readings: { [staticInputKey(source)]: value } }, source);
      },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.state).toMatchObject({ source: captured.source, anchors: [captured.anchors[1]] });
    if (typeof rootPresence !== 'object' || rootPresence === null || !('presence' in rootPresence)) throw new Error('Missing original presence');
    expect(rootPresence.presence).toEqual(receipt.presence);
    expect(log.query({ status: 'answered' })).toHaveLength(3);
    expect(log.query({ status: 'failed' })).toHaveLength(1);
    expect(staticInputCaptureComplete(captured, resumed)).toBe(true);
    expect(staticInputStanding(captured, resumed)).toEqual({ kind: 'clear' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted exact selector resumes without repeating its admitted presence', async () => {
  const captured = input();
  const readings: Record<string, unknown> = {};
  const current: StaticSourceReadings = { format: 1, decisionSourceHash: staticDecisionSourceHash(), readings };
  using log = new SqliteDecisionLog(':memory:');
  const fixture = fakePort(() => noulAnswer(0.99));
  let calls = 0;
  const interrupted: JudgmentPort = { model: fixture.port.model, ask(request) {
    if (++calls === 2) throw new Error('Selector interrupted');
    return fixture.port.ask(request);
  } };
  const progress = { previous: current, onReceipt(source: Parameters<typeof staticInputKey>[0], receipt: Awaited<ReturnType<typeof readStaticInput>>) {
    readings[staticInputKey(source)] = receipt;
  } };
  await expect(readStaticInput(withDecisionLog(interrupted, log), log, captured, undefined, progress)).rejects.toThrow('the judgment provider could not answer');
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const original = readings[staticInputKey(captured)];
  const resumed = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(name === 'violation' ? 0.01 : 0.99));
  const receipt = await readStaticInput(withDecisionLog(resumed.port, log), log, captured, undefined, progress);
  expect(resumed.requests).toHaveLength(1);
  expect(resumed.requests[0]?.state).toHaveProperty('candidates');
  if (typeof original !== 'object' || original === null || !('presence' in original)) throw new Error('Missing original presence');
  expect(original.presence).toEqual(receipt.presence);
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const noRepeat = fakePort(() => { throw new Error('An answered held selector must not be asked again'); });
  await readStaticInput(withDecisionLog(noRepeat.port, log), log, captured, undefined, progress);
  expect(noRepeat.requests).toHaveLength(0);
  expect(staticInputStanding(captured, current).kind).toBe('held');
});

test('journal recovery rejects torn or malformed records without altering original bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-partial-journal-'));
  try {
    const captured = input();
    const current = await preparedStaticReadings([captured]);
    const path = join(root, 'checkpoint.journal');
    const original = `${JSON.stringify(current)}\n{\"format\":1,\"decisionSourceHash\":\"unfinished`;
    writeFileSync(path, original);
    expect(loadStaticSourceJournal(path, null)).toEqual({ ...current, captureSources: {}, captureBatterySources: {} });
    {
      using journal = openStaticSourceJournal(path);
      journal.append({ ...current, readings: { malformed: { presence: 'invalid' } } });
    }
    expect(readFileSync(path, 'utf8').startsWith(original)).toBe(true);
    const recovered = loadStaticSourceJournal(path, null);
    expect(staticInputStanding(captured, recovered)).toEqual({ kind: 'clear' });
    expect(staticInputStanding({ ...captured, sourceHash: 'other-source' }, recovered).kind).toBe('held');
    expect(recovered?.readings.malformed).toEqual({ presence: 'invalid' });
    const prototypePath = join(root, 'prototype.journal');
    writeFileSync(prototypePath, `${JSON.stringify({ ...current, readings: { ['__proto__']: { [staticInputKey(captured)]: current.readings[staticInputKey(captured)] } } })}\n`);
    const prototype = loadStaticSourceJournal(prototypePath, null);
    if (!prototype) throw new Error('Missing controlled history record');
    expect(Object.hasOwn(prototype.readings, '__proto__')).toBe(true);
    expect(Object.hasOwn(prototype.readings, staticInputKey(captured))).toBe(false);
    expect(staticInputStanding(captured, prototype).kind).toBe('held');
    expect(revalidateStaticInput(captured, prototype)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stale partial policy cannot affect new source capture or revive its old answer', async () => {
  const captured = input();
  const original = await preparedStaticReadings([captured], 0.2);
  const prior = original.readings[staticInputKey(captured)];
  if (typeof prior !== 'object' || prior === null) throw new Error('Missing prior fixture');
  const manifest = staticDecisionSourceManifest().map(([path, hash]) => [path, path.endsWith('/bands.ts') ? 'stale-policy' : hash]);
  const oldHash = sha256(JSON.stringify(manifest));
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: { ...prior, decisionSourceHash: oldHash } };
  const staleCapture = readings[staticInputKey(captured)];
  const previous = { ...original, readings, captureSources: { [oldHash]: manifest } };
  const fixture = fakePort(() => noulAnswer(0.01));
  using log = new SqliteDecisionLog(':memory:');
  const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured, undefined, {
    previous, onReceipt(source, value) { readings[staticInputKey(source)] = value; },
  });
  expect(fixture.requests).toHaveLength(1);
  expect(receipt.presence.answers).toEqual({ violation: noulAnswer(0.01) });
  expect(receipt.decisionSourceHash).toBe(staticDecisionSourceHash());
  expect(receipt.previousCaptures?.[0]).toEqual(staleCapture);
  expect(staticInputStanding(captured, previous)).toEqual({ kind: 'clear' });
});

test('replacing an invalid inherited subset preserves its original raw capture', async () => {
  const captured = input();
  const original = await preparedStaticReadings([captured], 0.5);
  const root = original.readings[staticInputKey(captured)];
  if (typeof root !== 'object' || root === null || !('parts' in root) || !Array.isArray(root.parts)
    || typeof root.parts[0] !== 'object' || root.parts[0] === null) throw new Error('Missing authored subset tree');
  const stalePart = { ...root.parts[0], sourceHash: 'stale-source' };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: { ...root, parts: [stalePart, root.parts[1]] } };
  const previous = { ...original, readings };
  const fixture = fakePort(() => noulAnswer(0.01));
  using log = new SqliteDecisionLog(':memory:');
  const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured, undefined, {
    previous, onReceipt(source, value) { readings[staticInputKey(source)] = value; },
  });
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.state).toMatchObject({ anchors: [captured.anchors[0]], source: captured.source });
  expect(receipt.parts[0]?.previousCaptures?.[0]).toEqual(stalePart);
  expect(receipt.parts[1]?.presence).toEqual(root.parts[1].presence);
  expect(staticInputCaptureComplete(captured, previous)).toBe(true);
  expect(staticInputStanding(captured, previous).kind).toBe('held');
});

test('gzip receipts preserve exact answers and provenance with deterministic epoch bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-receipt-codec-'));
  try {
    const captured = input();
    const readings = await preparedStaticReadings([captured], 0.12345678901234567);
    const value = { ...readings, captureSources: { original: [['policy', 'original-hash']] }, captureBatterySources: { original: 'exact original source bytes' },
      readings: { ...readings.readings, archived: { previousCaptures: [{ answers: { violation: { type: 'noul', noul: 0.9876543210987654 } }, at: '2026-10-01T00:00:00Z' }] } } };
    const path = join(root, 'receipt.json.gz');
    saveStaticSourceReadings(value, path);
    const bytes = readFileSync(path);
    expect(bytes.readUInt32LE(4)).toBe(0);
    expect(JSON.parse(gunzipSync(bytes).toString('utf8'))).toEqual(value);
    expect(loadStaticSourceReadings(path)).toEqual(value);
    saveStaticSourceReadings(value, path);
    expect(readFileSync(path)).toEqual(bytes);
    const plain = join(root, 'custom.json');
    saveStaticSourceReadings(value, plain);
    expect(loadStaticSourceReadings(plain)).toEqual(value);
    expect(JSON.parse(readFileSync(plain, 'utf8'))).toEqual(value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed gzip and compressed schemas hold the same complete evidence gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'static-receipt-invalid-codec-'));
  try {
    const path = join(root, 'receipt.json.gz');
    for (const bytes of [Buffer.from('not gzip'), gzipSync('{'), gzipSync(JSON.stringify({ format: 1, decisionSourceHash: 'x', readings: [] }))]) {
      writeFileSync(path, bytes);
      expect(loadStaticSourceReadings(path)).toBeNull();
      expect(staticInputStanding(input(), loadStaticSourceReadings(path)).kind).toBe('held');
    }
    const captured = input();
    const readings = await preparedStaticReadings([captured]);
    saveStaticSourceReadings({ ...readings, readings: { [staticInputKey(captured)]: { answers: 'malformed evidence' } } }, path);
    expect(staticInputStanding(captured, loadStaticSourceReadings(path)).kind).toBe('held');
    const truncated = readFileSync(path);
    writeFileSync(path, truncated.subarray(0, truncated.length - 3));
    expect(loadStaticSourceReadings(path)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only settled current no observations clear an offline source input', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
  expect(staticInputStanding(captured, null).kind).toBe('held');
  expect(staticInputStanding(captured, { ...readings, decisionSourceHash: 'stale' }).kind).toBe('held');
  const changed = captureStaticInputs('internal-identifier', captured.path, '// Changed source\nconst value = 3;')[0]!;
  expect(staticInputStanding(changed, readings).kind).toBe('held');
  expect(staticInputStanding({ ...captured, path: 'sdk/src/another.ts' }, readings).kind).toBe('held');
});

test('weak no and uncertain observations stay held without changing their probabilities', async () => {
  for (const probability of [0.2, 0.5, 0.8]) {
    const captured = input();
    const readings = await preparedStaticReadings([captured], probability);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
  }
});

test('a settled violation needs exact current canonical selector evidence', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured], 0.99, 'line_2');
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'violation', anchor: captured.anchors[1]! });
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null) throw new Error('Missing authored fixture receipt');
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: null } } }).kind).toBe('held');
});

test('mismatched model, site, state or question evidence cannot clear a source input', async () => {
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt) || typeof receipt.presence !== 'object' || receipt.presence === null) throw new Error('Missing fixture presence');
  for (const [key, value] of [['observedModel', 'other-model'], ['requestedModel', 'jev-latest'], ['site', 'another-site'], ['stateHash', 'other-state'], ['questionsHash', 'other-question'], ['version', 99], ['captureDecisionSourceHash', 'unproved-policy']]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, presence: { ...receipt.presence, [String(key)]: value } } } }).kind).toBe('held');
  }
});

test('a malformed artifact or non-probability answer stays held', async () => {
  expect(parseStaticSourceReadings({ format: 1, decisionSourceHash: staticDecisionSourceHash(), readings: [] })).toBeNull();
  const captured = input();
  const readings = await preparedStaticReadings([captured]);
  const receipt: unknown = readings.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt) || typeof receipt.presence !== 'object' || receipt.presence === null) throw new Error('Missing fixture presence');
  for (const noul of [-1, 1.1, '0.01', null]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, presence: { ...receipt.presence, answers: { violation: { type: 'noul', noul } } } } } }).kind).toBe('held');
  }
});

test('windowing retains complete source lines and every offered anchor', () => {
  const text = Array.from({ length: 401 }, (_, index) => `// source line ${index + 1}`).join('\n');
  const inputs = captureStaticInputs('internal-identifier', 'docs/example.md', text,
    text.split('\n').map((line, index) => ({ id: `line_${index + 1}`, line: index + 1, col: 1, text: line })));
  expect(inputs.flatMap(captured => captured.anchors).map(anchor => anchor.line)).toEqual(Array.from({ length: 401 }, (_, index) => index + 1));
  expect(inputs[1]?.source).toContain('180| // source line 180');
  expect(inputs[0]?.source).toContain('181| // source line 181');
});

test('source windows fit the actual canonical selector without clipping evidence', async () => {
  const text = readFileSync(new URL('../bundle-budgets.json', import.meta.url), 'utf8');
  const inputs = captureStaticInputs('internal-identifier', 'bundle-budgets.json', text);
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01));
  const port: JudgmentPort = { model: fixture.port.model, ask(request) {
    validateContextBudget(request.state, request.questions);
    return fixture.port.ask(request);
  } };
  for (const captured of inputs) await staticOffendingAnchor.select(port, staticSelectionContext(captured), staticSelectionCandidates(captured));
  expect(fixture.requests).toHaveLength(inputs.length);
  for (const captured of inputs) for (const anchor of captured.anchors) expect(captured.source).toContain(anchor.text);
  expect(() => captureStaticInputs('internal-identifier', 'huge.ts', `const text = '${'x'.repeat(200_000)}';`)).toThrow('complete source unit and context exceed');
});

test('unchanged deferred policy revalidates through a shared-file internal-only revision', async () => {
  const captured = captureStaticInputs('deferred-work', 'source.ts', '// Intentional read-only adapter.')[0]!;
  const current = await preparedStaticReadings([captured]);
  const receipt: unknown = current.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt)) throw new Error('Missing authored capture');
  const source = readFileSync(new URL('../scripts/batteries/static-source.ts', import.meta.url), 'utf8');
  const oldSource = source.replace("name: 'engine.gates.internal-identifier', version: 2", "name: 'engine.gates.internal-identifier', version: 1");
  const oldManifest = staticDecisionSourceManifest().map(([path, hash]) => [path, path === 'batteries/static-source.ts' ? sha256(oldSource) : hash]);
  const oldHash = sha256(JSON.stringify(oldManifest));
  const old = { ...current, decisionSourceHash: oldHash, captureSources: { [oldHash]: oldManifest }, captureBatterySources: { [oldHash]: oldSource },
    readings: { [staticInputKey(captured)]: { ...receipt, decisionSourceHash: oldHash } } };
  const retained = revalidateStaticInput(captured, old);
  expect(retained).not.toBeNull();
  expect(retained).toMatchObject({ decisionSourceHash: oldHash, presence: receipt.presence });
  expect(staticInputStanding(captured, { ...old, decisionSourceHash: staticDecisionSourceHash(), readings: { [staticInputKey(captured)]: retained } })).toEqual({ kind: 'clear' });
  expect(revalidateStaticInput(captured, { ...old, captureBatterySources: { [oldHash]: `${oldSource}\n// tampered bytes` } })).toBeNull();
  const changedPolicy = oldSource.replace('yesNo(DEFERRED_WORK_INSTRUCTIONS, STAKES_BANDS.high.yesNo)', 'yesNo(DEFERRED_WORK_INSTRUCTIONS, STAKES_BANDS.medium.yesNo)');
  const changedManifest = oldManifest.map(([path, hash]) => [path, path === 'batteries/static-source.ts' ? sha256(changedPolicy) : hash]);
  const changedHash = sha256(JSON.stringify(changedManifest));
  expect(revalidateStaticInput(captured, { ...old, captureSources: { [changedHash]: changedManifest }, captureBatterySources: { [changedHash]: changedPolicy },
    readings: { [staticInputKey(captured)]: { ...receipt, decisionSourceHash: changedHash } } })).toBeNull();
});

test('bounded semantic revision clears only when complete exact subsets each settle no', async () => {
  const captured = input();
  using log = new SqliteDecisionLog(':memory:');
  const fixture = fakePort((_name, _question, state) => {
    if (typeof state !== 'object' || state === null || !('anchors' in state) || !Array.isArray(state.anchors)) throw new Error('Unexpected fixture state');
    return noulAnswer(state.anchors.length > 1 ? 0.5 : 0.01);
  });
  const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured);
  const readings = { format: 1, decisionSourceHash: staticDecisionSourceHash(), readings: { [staticInputKey(captured)]: receipt } } satisfies Parameters<typeof staticInputStanding>[1];
  expect(fixture.requests).toHaveLength(3);
  expect(fixture.requests.map(request => request.state)).toMatchObject([
    { source: captured.source, anchors: captured.anchors },
    { source: captured.source, anchors: [captured.anchors[0]] },
    { source: captured.source, anchors: [captured.anchors[1]] },
  ]);
  expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, parts: receipt.parts.slice(0, 1) } } }).kind).toBe('held');
  expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, parts: [receipt.parts[1], receipt.parts[0]] } } }).kind).toBe('held');
});

test('exact observation revalidation preserves old wire provenance and requires unchanged canonical policy', async () => {
  const captured = input();
  const current = await preparedStaticReadings([captured]);
  const receipt: unknown = current.readings[staticInputKey(captured)];
  if (typeof receipt !== 'object' || receipt === null || !('presence' in receipt)) throw new Error('Missing authored capture');
  const oldManifest = staticDecisionSourceManifest().map(([path, hash]) => [path, path === 'no-todo-marker-rules.ts' ? 'old-extractor' : hash]);
  const oldHash = sha256(JSON.stringify(oldManifest));
  const old = { ...current, decisionSourceHash: oldHash, captureSources: { [oldHash]: oldManifest },
    readings: { [staticInputKey(captured)]: { ...receipt, decisionSourceHash: oldHash } } };
  expect(staticInputStanding(captured, old).kind).toBe('held');
  const revalidated = revalidateStaticInput(captured, old);
  expect(revalidated).toMatchObject({ decisionSourceHash: oldHash, validatedDecisionSourceHash: staticDecisionSourceHash(), presence: receipt.presence });
  expect(staticInputStanding(captured, { ...old, decisionSourceHash: staticDecisionSourceHash(), readings: { [staticInputKey(captured)]: revalidated } })).toEqual({ kind: 'clear' });
  expect(revalidateStaticInput({ ...captured, sourceHash: 'changed' }, old)).toBeNull();
  expect(revalidateStaticInput(captured, { ...old, captureSources: {} })).toBeNull();
  const changedPolicy = oldManifest.map(([path, hash]) => [path, path?.endsWith('/bands.ts') ? 'changed-bands' : hash]);
  const changedHash = sha256(JSON.stringify(changedPolicy));
  expect(revalidateStaticInput(captured, { ...old, decisionSourceHash: changedHash, captureSources: { [changedHash]: changedPolicy },
    readings: { [staticInputKey(captured)]: { ...receipt, decisionSourceHash: changedHash } } })).toBeNull();
  const changedBattery = oldManifest.map(([path, hash]) => [path, path === 'batteries/static-source.ts' ? 'changed-battery-band' : hash]);
  const changedBatteryHash = sha256(JSON.stringify(changedBattery));
  expect(revalidateStaticInput(captured, { ...old, captureSources: { [changedBatteryHash]: changedBattery },
    readings: { [staticInputKey(captured)]: { ...receipt, decisionSourceHash: changedBatteryHash } } })).toBeNull();
  const weak = await preparedStaticReadings([captured], 0.2);
  const retainedWeak = revalidateStaticInput(captured, weak);
  expect(retainedWeak).not.toBeNull();
  expect(staticInputStanding(captured, { ...weak, readings: { [staticInputKey(captured)]: retainedWeak } }).kind).toBe('held');
});
