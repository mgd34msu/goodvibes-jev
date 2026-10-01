import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { readAnswerObjectAlignment, ANSWER_OBJECT_LIMITS, type AnswerObjectCandidate } from '../sdk/src/platform/knowledge/semantic/answer-object-alignment/reader.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function candidate(reference: string, title: string, summary: string): AnswerObjectCandidate {
  return { reference, kind: 'knowledge_entity', title, summary, aliases: [], content: {}, associations: [] };
}
const speaker = candidate('object-1', 'Kitchen speaker', 'A wireless audio device.');
const bridge = candidate('object-2', 'Sound bridge', 'Software that relays events between the sound system and home controller.');
type Readings = readonly [number, number, number];
function port(rows: Readonly<Record<string, Readings>>, intent = 0.01) {
  const fake = fakePort((name, _question, state) => {
    if (name === 'integrationIntent') return noulAnswer(intent);
    const title = (state as { candidate: { title: string } }).candidate.title;
    const index = ['concreteObject', 'integrationObject', 'aligned'].indexOf(name);
    if (!rows[title] || index < 0) throw new Error(`Unscripted alignment: ${name}/${title}`);
    return noulAnswer(rows[title]![index]!);
  });
  installJudgmentPort(fake.port); return fake;
}
describe('prepared answer object and integration readings', () => {
  test('semantic paraphrase can align without query token overlap; keeps actual probabilities', async () => {
    const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.93], 'Sound bridge': [0.99, 0.99, 0.01] });
    const plan = await readAnswerObjectAlignment({ query: 'What plays tunes beside the sink?', candidates: [speaker, bridge] });
    expect(plan.accepted.map((row) => row.reference)).toEqual(['object-1']);
    expect(plan.accepted[0]!.aligned.probability).toBe(0.93);
    expect(fake.requests.every((request) => JSON.stringify(request.state).includes('Sound bridge'))).toBe(true);
  });
  test('ambiguous singular holds while a plural can select both objects', async () => {
    const other = candidate('object-2', 'Bedroom speaker', 'A wireless audio device beside the bed.');
    port({ 'Kitchen speaker': [0.99, 0.01, 0.6], 'Bedroom speaker': [0.99, 0.01, 0.6] });
    await expect(readAnswerObjectAlignment({ query: 'How heavy is the speaker?', candidates: [speaker, other] })).rejects.toMatchObject({ reason: 'uncertain' });
    port({ 'Kitchen speaker': [0.99, 0.01, 0.99], 'Bedroom speaker': [0.99, 0.01, 0.99] });
    const plan = await readAnswerObjectAlignment({ query: 'How heavy are both speakers?', candidates: [speaker, other] });
    expect(plan.accepted.map((row) => row.reference)).toEqual(['object-1', 'object-2']);
  });
  test('connection meaning without old keywords selects an integration', async () => {
    port({ 'Sound bridge': [0.99, 0.99, 0.99] }, 0.99);
    const plan = await readAnswerObjectAlignment({ query: 'How can the speakers talk to the home controller?', candidates: [bridge] });
    expect(plan.integrationIntent?.verdict).toBe('yes'); expect(plan.accepted[0]!.reference).toBe('object-2');
  });
  test('incidental old intent words do not select an integration', async () => {
    port({ 'Kitchen speaker': [0.99, 0.01, 0.99], 'Sound bridge': [0.99, 0.99, 0.99] });
    const plan = await readAnswerObjectAlignment({ query: 'After setup and service, how heavy is the kitchen speaker?', candidates: [speaker, bridge] });
    expect(plan.accepted.map((row) => row.reference)).toEqual(['object-1']); expect(plan.rejected[0]!.reference).toBe('object-2');
  });
  test('context or graph membership never forces acceptance; settled no is empty', async () => {
    port({ 'Kitchen speaker': [0.99, 0.01, 0.01] });
    const plan = await readAnswerObjectAlignment({ query: 'How heavy is a garden chair?', candidates: [{ ...speaker,
      associations: [{ origin: 'caller-context' }, { origin: 'graph', reference: 'context-2', relation: 'describes' }] }] });
    expect(plan.accepted).toEqual([]); expect(plan.rejected[0]?.aligned.verdict).toBe('no');
  });
  test('concrete identity is read, with no uppercase model heuristic', async () => {
    const concept = candidate('object-2', 'AUDIO-X9000', 'A general topic category, not a particular object.');
    port({ 'Kitchen speaker': [0.99, 0.01, 0.99], 'AUDIO-X9000': [0.01, 0.01, 0.99] });
    const plan = await readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker, concept] });
    expect(plan.accepted.map((row) => row.reference)).toEqual(['object-1']);
  });
  test('late aliases and nested model/subject values preflight before any requests or clipping', async () => {
    for (const change of [{ aliases: ['Authorization: Bearer synthetic'] },
      { content: { model: 'Authorization: Bearer synthetic' } }, { content: { subject: { password: 'synthetic-secret' } } }]) {
      const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.99], 'Sound bridge': [0.99, 0.99, 0.99] });
      await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker, { ...bridge,
        summary: 'Ordinary identity. '.repeat(500), ...change }] })).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
  });
  test('missing and failed ports hold distinctly from settled no', async () => {
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'unconfigured' });
    const fake = port({});
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'unavailable' });
    expect(fake.requests.length).toBeGreaterThan(0);
  });
  test('uncertain intent or any uncertain candidate holds the whole pass', async () => {
    port({ 'Kitchen speaker': [0.99, 0.01, 0.99] }, 0.6);
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'uncertain' });
    port({ 'Kitchen speaker': [0.99, 0.6, 0.99] });
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'uncertain' });
  });
  test('no candidates makes no request, but a cancelled empty pass still holds', async () => {
    expect((await readAnswerObjectAlignment({ query: 'What plays music?', candidates: [] })).accepted).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [] }, { signal: controller.signal })).rejects.toMatchObject({ reason: 'aborted' });
  });
  test('candidate overflow holds without clipping and before a request', async () => {
    const fake = port({});
    const candidates = Array.from({ length: ANSWER_OBJECT_LIMITS.candidates + 1 }, (_, index) => ({ ...speaker, reference: `object-${index + 1}` }));
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates })).rejects.toMatchObject({ reason: 'budget' });
    expect(fake.requests).toHaveLength(0);
  });
  test('a settled selection larger than its explicit result budget holds rather than choosing arbitrary targets', async () => {
    const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.99] });
    const candidates = Array.from({ length: ANSWER_OBJECT_LIMITS.selected + 1 }, (_, index) => ({ ...speaker, reference: `object-${index + 1}` }));
    await expect(readAnswerObjectAlignment({ query: 'Which speakers play music?', candidates })).rejects.toMatchObject({ reason: 'budget' });
    expect(fake.requests.filter((request) => 'aligned' in request.questions)).toHaveLength(candidates.length);
  });
  test('reader cancellation and deadline race uncooperative providers', async () => {
    const controller = new AbortController();
    const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.99] });
    installJudgmentPort({ ...fake.port, ask: () => new Promise(() => {}) });
    const reading = readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] }, { signal: controller.signal });
    controller.abort(); await expect(reading).rejects.toMatchObject({ reason: 'aborted' });
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] }, { timeoutMs: 5 })).rejects.toMatchObject({ reason: 'budget' });
  });
  test('configuration change after an await holds instead of using a fallback', async () => {
    const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.99] });
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); installJudgmentPort(fake.port); return result; } });
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'stale' });
  });
  test('invalid probabilities cannot become old score units', async () => {
    const fake = port({ 'Kitchen speaker': [0.99, 0.01, 0.99] });
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request);
      return { ...result, answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: 'noul' as const, noul: 97 }])) as typeof result.answers }; } });
    await expect(readAnswerObjectAlignment({ query: 'What plays music?', candidates: [speaker] })).rejects.toMatchObject({ reason: 'malformed' });
  });
});
