import { expect, test } from 'bun:test';
import { canonicalJson, choice, defineSelector, noul, PINNED_MODEL, SqliteDecisionLog, STAKES_BANDS, toJson, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { captureStaticInputs, parseStaticSourceReadings, readStaticInput, revalidateStaticInput, sha256, STATIC_SITE, staticDecisionSourceHash, staticDecisionSourceManifest, staticInputCaptureComplete, staticInputKey, staticInputStanding, staticSelectionCandidates, staticSelectionContext, type StaticSourceReadings } from '../scripts/static-source-readings.ts';
import { STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS, STATIC_WEAK_ANCHOR_INSTRUCTIONS, staticWeakAnchor } from '../scripts/batteries/static-weak-anchor.ts';
import { STATIC_ANCHOR_FIT_INSTRUCTIONS, STATIC_ANCHOR_INSTRUCTIONS } from '../scripts/batteries/static-source.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const input = () => captureStaticInputs('internal-identifier', 'sdk/src/example.ts', 'const value = 3;', [{ id: 'candidate', line: 1, col: 7, text: 'value' }])[0]!;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

async function selected(presence: number, pick: 'candidate' | 'none', confidence: number, fit: number) {
  const captured = input();
  using log = new SqliteDecisionLog(':memory:');
  const fixture = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, pick, confidence) : noulAnswer(name === 'violation' ? presence : fit));
  const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured);
  return { captured, receipt, readings: { format: 1, decisionSourceHash: staticDecisionSourceHash(), readings: { [staticInputKey(captured)]: receipt } } satisfies StaticSourceReadings };
}

test('weak presence clears only with settled none and every exact negative fit', async () => {
  for (const presence of [0.2, 0.5, 0.8]) {
    const { captured, receipt, readings } = await selected(presence, 'none', 0.99, 0.01);
    expect(staticInputStanding(captured, readings)).toEqual({ kind: 'clear' });
    expect(receipt.presence.answers).toEqual({ violation: noulAnswer(presence) });
    expect(receipt.selection?.battery).toBe(staticWeakAnchor.name);
    expect(receipt.readingPlanVersion).toBe(2);
    expect(staticInputCaptureComplete(captured, readings)).toBe(true);
  }
  for (const fit of [0.2, 0.5, 0.8, 0.99]) {
    const { captured, readings } = await selected(0.5, 'none', 0.99, fit);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, readings)).toBe(true);
  }
  const uncertain = await selected(0.5, 'none', 0.8, 0.01);
  expect(staticInputStanding(uncertain.captured, uncertain.readings).kind).toBe('held');
});

test('new positive identity and fit must both settle and cannot clear a strong contradiction', async () => {
  const positive = await selected(0.5, 'candidate', 0.99, 0.99);
  expect(staticInputStanding(positive.captured, positive.readings)).toEqual({ kind: 'violation', anchor: positive.captured.anchors[0]! });
  for (const [confidence, fit] of [[0.8, 0.99], [0.99, 0.8], [0.99, 0.5], [0.99, 0.01]]) {
    const { captured, readings } = await selected(0.5, 'candidate', confidence!, fit!);
    expect(staticInputStanding(captured, readings).kind).toBe('held');
  }
  const contradiction = await selected(0.99, 'none', 0.99, 0.01);
  expect(staticInputStanding(contradiction.captured, contradiction.readings).kind).toBe('held');
  expect(contradiction.receipt.selection?.battery).toBe('engine.gates.static-offending-anchor');
});

test('legacy weak presence survives exactly and receives only the genuinely new selector once', async () => {
  const captured = input();
  const authored = await preparedStaticReadings([captured], 0.5);
  const raw = authored.readings[staticInputKey(captured)];
  if (!object(raw) || !object(raw.presence)) throw new Error('Missing authored evidence');
  const manifest = staticDecisionSourceManifest().filter(([path]) => path !== 'batteries/static-weak-anchor.ts');
  const oldHash = sha256(JSON.stringify(manifest));
  const presence = { ...raw.presence, captureDecisionSourceHash: oldHash };
  const original = { ...raw, readingPlanVersion: 1, decisionSourceHash: oldHash, presence, selection: null };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: original };
  const old = { ...authored, decisionSourceHash: oldHash, readings, captureSources: { [oldHash]: manifest } };
  const current = { ...old, decisionSourceHash: staticDecisionSourceHash() };
  expect(revalidateStaticInput(captured, old)).not.toBeNull();
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  using log = new SqliteDecisionLog(':memory:');
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(0.01));
  const progress = { previous: current, original: old, onReceipt(source: typeof captured, value: Awaited<ReturnType<typeof readStaticInput>>) {
    readings[staticInputKey(source)] = value;
  } };
  const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured, undefined, progress);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.questions).toHaveProperty('pick');
  expect(fixture.requests[0]?.questions).not.toHaveProperty('violation');
  expect<unknown>(receipt.presence).toEqual(presence);
  expect(receipt.decisionSourceHash).toBe(oldHash);
  expect(receipt.selection?.captureDecisionSourceHash).toBe(staticDecisionSourceHash());
  expect(staticInputStanding(captured, current)).toEqual({ kind: 'clear' });
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  const repeated = fakePort(() => { throw new Error('No answered identity may be resampled'); });
  await readStaticInput(withDecisionLog(repeated.port, log), log, captured, undefined, progress);
  expect(repeated.requests).toHaveLength(0);
  expect(log.query({ status: 'answered' })).toHaveLength(1);
});

test('interrupted new selector resumes once and preserves an answered weak selector forever', async () => {
  const captured = input();
  const authored = await preparedStaticReadings([captured], 0.5);
  const raw = authored.readings[staticInputKey(captured)];
  if (!object(raw)) throw new Error('Missing authored presence');
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: { ...raw, readingPlanVersion: 1, selection: null } };
  const current = { ...authored, readings };
  const progress = { previous: current, onReceipt(source: typeof captured, value: Awaited<ReturnType<typeof readStaticInput>>) { readings[staticInputKey(source)] = value; } };
  using log = new SqliteDecisionLog(':memory:');
  const interruption = fakePort(() => { throw new Error('Interrupted before selector answer'); });
  await expect(readStaticInput(withDecisionLog(interruption.port, log), log, captured, undefined, progress)).rejects.toThrow('the judgment provider could not answer');
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  const resumed = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const receipt = await readStaticInput(withDecisionLog(resumed.port, log), log, captured, undefined, progress);
  expect(resumed.requests).toHaveLength(1);
  expect<unknown>(receipt.presence).toEqual(raw.presence);
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  const forbidden = fakePort(() => { throw new Error('Answered uncertain selector cannot be repeated'); });
  await readStaticInput(withDecisionLog(forbidden.port, log), log, captured, undefined, progress);
  expect(forbidden.requests).toHaveLength(0);
  expect(log.query({ status: 'answered' })).toHaveLength(1);
  expect(log.query({ status: 'failed' })).toHaveLength(1);
});

test('weak selector plan, source, policy and full answer identity must remain exact', async () => {
  const { captured, receipt, readings } = await selected(0.5, 'none', 0.99, 0.01);
  const selector = receipt.selection;
  if (!selector) throw new Error('Missing selector fixture');
  for (const marker of [undefined, 1, 99]) {
    const mutated = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, readingPlanVersion: marker } } };
    expect(staticInputStanding(captured, mutated).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, mutated)).toBe(false);
  }
  expect(parseStaticSourceReadings({ ...readings, readingPlanVersion: 99 })).toBeNull();
  for (const [field, value] of [['observedModel', 'other'], ['requestedModel', 'jev-latest'], ['questionsHash', 'changed'], ['site', 'wrong'], ['stateHash', 'changed'], ['version', 1]]) {
    expect(staticInputStanding(captured, { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...selector, [String(field)]: value } } } }).kind).toBe('held');
  }
  for (const manifest of [staticDecisionSourceManifest().filter(([path]) => path !== 'batteries/static-weak-anchor.ts'),
    staticDecisionSourceManifest().map(([path, hash]) => [path, path === 'batteries/static-weak-anchor.ts' ? 'changed-policy' : hash])]) {
    const oldHash = sha256(JSON.stringify(manifest));
    const old = { ...readings, captureSources: { [oldHash]: manifest }, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...selector, captureDecisionSourceHash: oldHash } } } };
    expect(staticInputStanding(captured, old).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, old)).toBe(false);
  }
  for (const answers of [{ pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0.01, none: 0.99 } } },
    { pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0, none: 0.989999 } }, fits_0: noulAnswer(0.01) },
    { pick: { type: 'choice', choice: 'none', confidence: 0.99, probabilities: { candidate: 0.01, none: 0.99, extra: 0 } }, fits_0: noulAnswer(0.01) }]) {
    const malformed = { ...readings, readings: { [staticInputKey(captured)]: { ...receipt, selection: { ...selector, answers } } } };
    expect(staticInputStanding(captured, malformed).kind).toBe('held');
    expect(staticInputCaptureComplete(captured, malformed)).toBe(false);
  }
  expect(staticInputStanding({ ...captured, sourceHash: 'changed' }, readings).kind).toBe('held');
});

test('weak v2 source-only questions leave original strong selector questions unchanged', async () => {
  for (const presence of [0.5, 0.99]) {
    const captured = input();
    using log = new SqliteDecisionLog(':memory:');
    const fixture = fakePort((name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.99) : noulAnswer(name === 'violation' ? presence : 0.01));
    const receipt = await readStaticInput(withDecisionLog(fixture.port, log), log, captured);
    const questions = fixture.requests[1]?.questions;
    if (!questions) throw new Error('Missing exact selector questions');
    expect(questions.pick).toEqual(choice(presence === 0.5 ? STATIC_WEAK_ANCHOR_INSTRUCTIONS : STATIC_ANCHOR_INSTRUCTIONS, { candidate: null, none: 'None of the candidates does what is needed.' }));
    expect(questions.fits_0).toEqual(noul({ question: presence === 0.5 ? STATIC_WEAK_ANCHOR_FIT_INSTRUCTIONS : STATIC_ANCHOR_FIT_INSTRUCTIONS, candidate: '`candidates[0]` (id "candidate")' }));
    expect(receipt.selection?.version).toBe(2);
    expect(receipt.selection?.questionsHash).toBe(sha256(canonicalJson(toJson(questions))));
  }
});

test('v1 weak answers remain raw history while only new v2 questions are measured once', async () => {
  const captured = input();
  const authored = await selected(0.5, 'none', 0.8, 0.5);
  using log = new SqliteDecisionLog(':memory:');
  const legacy = defineSelector({ name: staticWeakAnchor.name, version: 1, model: PINNED_MODEL, accuracyFloor: 0.95,
    description: 'Authored synthetic historical v1 fixture', instructions: STATIC_ANCHOR_INSTRUCTIONS,
    fitInstructions: STATIC_ANCHOR_FIT_INSTRUCTIONS, band: STAKES_BANDS.high.confidence, fitBand: STAKES_BANDS.high.yesNo,
    fixtures: [{ name: 'authored historical example', context: staticSelectionContext(captured), candidates: staticSelectionCandidates(captured), expect: 'none' }] });
  const fixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const run = await legacy.select(withDecisionLog(fixture.port, log), staticSelectionContext(captured), staticSelectionCandidates(captured), { site: `${STATIC_SITE}.${captured.kind}` });
  const entry = log.query({ status: 'answered' }).find(value => value.id === run.decisionId);
  if (!entry || entry.status !== 'answered') throw new Error('Missing authored v1 call');
  const manifest = staticDecisionSourceManifest().map(([path, hash]) => [path, path === 'batteries/static-weak-anchor.ts' ? sha256('authored synthetic archived v1 definition') : hash]);
  const oldHash = sha256(JSON.stringify(manifest));
  const rawSelection = { id: entry.id, at: entry.at, battery: staticWeakAnchor.name, version: 1, site: `${STATIC_SITE}.${captured.kind}`,
    stateHash: entry.stateHash, questionsHash: sha256(canonicalJson(entry.questions)), requestedModel: entry.requestedModel,
    observedModel: entry.model, requestId: entry.requestId, answers: entry.answers, captureDecisionSourceHash: oldHash };
  const presence = { ...authored.receipt.presence, captureDecisionSourceHash: oldHash };
  const original = { ...authored.receipt, decisionSourceHash: oldHash, presence, selection: rawSelection };
  const readings: Record<string, unknown> = { [staticInputKey(captured)]: original };
  const old = { format: 1, decisionSourceHash: oldHash, readings, captureSources: { [oldHash]: manifest } } satisfies StaticSourceReadings;
  const current = { ...old, decisionSourceHash: staticDecisionSourceHash() };
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, current)).toBe(false);
  const newFixture = fakePort((_name, question) => question.type === 'choice' ? choiceAnswer(question, 'none', 0.8) : noulAnswer(0.5));
  const progress = { previous: current, original: old, onReceipt(source: typeof captured, receipt: Awaited<ReturnType<typeof readStaticInput>>) { readings[staticInputKey(source)] = receipt; } };
  const updated = await readStaticInput(withDecisionLog(newFixture.port, log), log, captured, undefined, progress);
  expect(newFixture.requests).toHaveLength(1);
  expect(newFixture.requests[0]?.questions).not.toEqual(fixture.requests[0]?.questions);
  expect(updated.selection?.version).toBe(2);
  expect<unknown>(updated.presence).toEqual(presence);
  expect(updated.previousCaptures).toEqual([original]);
  expect(staticInputStanding(captured, current).kind).toBe('held');
  expect(staticInputCaptureComplete(captured, current)).toBe(true);
  const forbidden = fakePort(() => { throw new Error('Unchanged weak v2 answers cannot be resampled'); });
  await readStaticInput(withDecisionLog(forbidden.port, log), log, captured, undefined, progress);
  expect(forbidden.requests).toHaveLength(0);
  expect(log.query({ status: 'answered' })).toHaveLength(2);
});
