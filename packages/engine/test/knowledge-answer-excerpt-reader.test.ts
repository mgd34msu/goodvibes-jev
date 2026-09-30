import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { answerExcerptSelection } from '../sdk/src/platform/knowledge/semantic/answer-excerpts/battery.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/answer-excerpts/judgment-registry.js';
import { prepareAnswerExcerptReadings, answerExcerptSpans, type AnswerExcerptInput } from '../sdk/src/platform/knowledge/semantic/answer-excerpts/reader.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function input(text = 'AC-7: No Bluetooth.', reference = 'source-1'): AnswerExcerptInput {
  return { reference, query: 'Can AC-7 pair wirelessly?', source: { title: 'AC-7', sourceType: 'manual', uri: 'https://example.test/ac7' },
    context: '', documents: [{ reference: 'document-1', kind: 'extraction', text }] };
}
function readings(selected: readonly string[] = ['AC-7: No Bluetooth.']) {
  const fake = fakePort((name, _question, state) => {
    if (name !== 'excerptUseful') throw new Error('Unexpected excerpt fixture reading');
    return noulAnswer(selected.includes((state as { candidate: { text: string } }).candidate.text) ? 0.99 : 0.01);
  }); installJudgmentPort(fake.port); return fake;
}
function prepare(values = [input()], options: Parameters<typeof prepareAnswerExcerptReadings>[1] = {}) { return prepareAnswerExcerptReadings(values, options); }
describe('exact answer excerpt reader', () => {
  test('registered semantic fixtures cover meaning rather than token overlap', () => {
    expect(registry.list().map((battery) => battery.name)).toEqual([answerExcerptSelection.name]);
    expect(answerExcerptSelection.accuracyFloor).toBe(0.95);
    const names = answerExcerptSelection.fixtures.map((fixture) => fixture.name).join(' ');
    for (const word of ['paraphrase', 'keyword', 'short', 'non-Latin', 'table', 'variant', 'accessory', 'exception', 'quantity', 'URL', 'injection']) expect(names).toContain(word);
    expect(answerExcerptSelection.fixtures.some((fixture) => fixture.expect.excerptUseful === 'no')).toBe(true);
  });
  test('structural spans retain exact whitespace, short negatives, non-Latin and table rows', () => {
    const text = '  AC-7 不支持蓝牙。\r\n\r\nModel | Inputs\nAC-7 | 4\nAC-8 | 8\n\nOpen https://example.test/config.  ';
    const spans = answerExcerptSpans(input(text).documents[0]!);
    expect(spans.some((span) => span.text === 'AC-7 不支持蓝牙。')).toBe(true);
    expect(spans.some((span) => span.text === 'Model | Inputs\nAC-7 | 4\nAC-8 | 8')).toBe(true);
    expect(spans.some((span) => span.text === 'Open https://example.test/config.')).toBe(true);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.text);
  });
  test('an untrimmed whole-field option retains indentation, trailing whitespace and UTF-16 offsets', async () => {
    const text = '    print("🛰️")  \n\n  AC-7 不支持蓝牙。\t ';
    const fake = readings([text]); const selected = (await prepare([input(text)]).read())[0]!.spans;
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ start: 0, end: text.length, text });
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(selected[0]!.end);
    const short = answerExcerptSpans(input(text).documents[0]!).find((span) => span.text === 'AC-7 不支持蓝牙。')!;
    expect(short.start).toBe(text.indexOf('AC-7'));
    expect(short.start).toBe('    print("🛰️")  \n\n  '.length);
    expect(text.slice(short.start, short.end)).toBe(short.text);
    expect(fake.requests.some((request) => (request.state as { candidate: { text: string } }).candidate.text === text)).toBe(true);
  });
  test('offers original adjacent context and whole text for distant qualifiers; reads full context for every option', async () => {
    const text = 'AC-7 lasts twelve hours.\n\nOnly in standby.\n\nAC-7 active use: two hours.\n\nAC-8: eight hours.';
    const fake = readings([text]); const result = await prepare([input(text)]).read();
    expect(result[0]!.spans.map((span) => span.text)).toEqual([text]);
    expect(fake.requests.length).toBeGreaterThan(4);
    for (const request of fake.requests) expect((request.state as { documents: { text: string }[] }).documents[0]!.text).toBe(text);
  });
  test('settled no is actually empty, and one uncertain candidate holds all selections', async () => {
    readings([]); expect((await prepare().read())[0]!.spans).toEqual([]);
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      return { ...result, answers: { excerptUseful: noulAnswer((request.state as { reference: string }).reference === 'source-2' ? 0.6 : 0.99) } } as typeof result;
    } });
    await expect(prepare([input(), input('AC-8: eight ports.', 'source-2')]).read()).rejects.toMatchObject({ reason: 'unsettled' });
  });
  test('a rejected initial source is never read or returned by the excerpt pass', async () => {
    const fake = readings(['AC-7: No Bluetooth.', 'Other source.']);
    const result = await prepare([input(), input('Other source.', 'source-2')]).read(new Set(['source-1']));
    expect(result[1]!.spans).toEqual([]); expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.state as { reference: string }).reference).toBe('source-1');
  });
  test('whole selected input is protected before bounds or port acquisition, including late sources and URLs', () => {
    const fake = readings();
    for (const tail of ['Authorization: Bearer synthetic', '4111 1111 1111 1111', 'https://example.test/?api_key=synthetic']) {
      expect(() => prepare([input(), input(`${'Normal text. '.repeat(14_000)}${tail}`, 'source-2')])).toThrow(JudgmentInputError);
    }
    expect(fake.requests).toHaveLength(0);
  });
  test('accessors, extra fields, duplicate refs and oversized input are rejected without requests', () => {
    const fake = readings(); let accesses = 0;
    expect(() => prepare([{ ...input(), get context() { accesses++; return ''; } }])).toThrow(JudgmentInputError);
    expect(accesses).toBe(0);
    for (const values of [[input(), input()], [{ ...input(), metadata: {} } as AnswerExcerptInput], [input('x'.repeat(161_000))], [input(Array.from({ length: 101 }, (_, index) => `Paragraph ${index}`).join('\n\n'))]]) {
      expect(() => prepare(values)).toThrow();
    }
    expect(fake.requests).toHaveLength(0);
  });
  test('immutable captured input cannot be changed between preparation and later reads', async () => {
    const value = input(); const fake = readings(); const prepared = prepare([value]);
    (value.documents[0] as { text: string }).text = 'changed after preparation';
    const result = await prepared.read(); expect(result[0]!.spans[0]!.text).toBe('AC-7: No Bluetooth.');
    expect(Object.isFrozen(fake.requests[0]!.state)).toBe(true); expect(Object.isFrozen(result[0]!.spans[0])).toBe(true);
  });
  test('an empty structural pass needs no port, while unknown selected references hold', async () => {
    expect(await prepare([]).read()).toEqual([]);
    expect((await prepare([input('   ')]).read())[0]!.spans).toEqual([]);
    await expect(prepare().read(new Set(['source-unknown']))).rejects.toMatchObject({ reason: 'malformed' });
  });
  test('unknown, malformed, failed and missing readers are holds rather than empty selections', async () => {
    await expect(prepare().read()).rejects.toMatchObject({ reason: 'unconfigured' });
    const fake = readings();
    for (const probability of [NaN, Infinity, -1, 99]) {
      installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); return { ...result, answers: { excerptUseful: noulAnswer(probability) } } as typeof result; } });
      await expect(prepare().read()).rejects.toMatchObject({ reason: 'malformed' });
    }
    installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic offline reader'); } });
    await expect(prepare().read()).rejects.toMatchObject({ reason: 'unavailable' });
  });
  test('configuration changes and mixed model responses invalidate readings and later guard checks', async () => {
    const fake = readings(); const prepared = prepare(); await prepared.read(); installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    expect(() => prepared.assertCurrent()).toThrow();
    let index = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: `different-${++index}` }; } });
    await expect(prepare([input(), input('AC-8.', 'source-2')]).read()).rejects.toMatchObject({ reason: 'stale' });
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); installJudgmentPort(fake.port); return result; } });
    await expect(prepare().read()).rejects.toMatchObject({ reason: 'stale' });
  });
  test('deadlines and aborts settle even if the port ignores cancellation', async () => {
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { return new Promise(() => {}); } });
    await expect(prepare([input()], { timeoutMs: 10 }).read()).rejects.toMatchObject({ reason: 'budget' });
    const controller = new AbortController(); const result = prepare([input()], { signal: controller.signal }).read(); controller.abort();
    await expect(result).rejects.toMatchObject({ reason: 'aborted' });
  });
  test('complete request-byte budget is checked before any requests and concurrency is bounded', async () => {
    const fake = readings();
    const value = input(); const documents = Array.from({ length: 50 }, (_, index) => ({ reference: `document-${index + 1}`, kind: 'extraction' as const, text: `${'x'.repeat(1_450)}\n\n${'y'.repeat(1_450)}` }));
    expect(() => prepare([{ ...value, documents }])).toThrow(); expect(fake.requests).toHaveLength(0);
    let active = 0, maximum = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { active++; maximum = Math.max(maximum, active); await new Promise((resolve) => setTimeout(resolve, 1)); const result = await fake.port.ask(request); active--; return result; } });
    await prepare(Array.from({ length: 20 }, (_, index) => input('AC-7: No Bluetooth.', `source-${index + 1}`))).read();
    expect(maximum).toBeLessThanOrEqual(4); expect(fake.requests).toHaveLength(20);
  });
});
