import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { classifyTone, composeDraftReply, countSentences, extractSenderName, extractStyleProfile, StyleReplyReadingError } from '../sdk/src/platform/email/style-reply.js';
import { taskRouteSourceFixture, exactRouteSourceSpans } from './_helpers/task-route-source.ts';

let prior: ReturnType<typeof installJudgmentPort>;
const owners: ReturnType<typeof taskRouteSourceFixture>[] = [];
beforeEach(() => { prior = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(prior); for (const owner of owners.splice(0).reverse()) await owner.close(); });
function source(options: Parameters<typeof taskRouteSourceFixture>[0] = {}) {
  const fixture = taskRouteSourceFixture(options); owners.push(fixture); return fixture;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected recorded style state');
  return Object.fromEntries(Object.entries(value));
}
function neutral(expected: readonly string[]) {
  return fakePort((name, question, state) => {
    const body = object(state);
    if (name !== 'tone' || question.type !== 'choice' || JSON.stringify(body) !== JSON.stringify({ bodies: expected })) throw new Error('Unknown full tone contract');
    return choiceAnswer(question, 'neutral', 0.999);
  });
}
function pending(port: JudgmentPort) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const wrapped: JudgmentPort = { model: port.model, async ask(request) { entered.resolve(); await release.promise; return port.ask(request); } };
  return { port: wrapped, entered: entered.promise, release: () => release.resolve() };
}

test('empty corpus defaults are native facts without source or judgment services', async () => {
  expect(await extractStyleProfile([])).toEqual({ greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true });
  expect(await countSentences('')).toBe(0); expect(await extractSenderName('')).toBe('');
});
test('a nonempty corpus without a source owner holds before any semantic question', async () => {
  const fake = neutral(['Ordinary author text.']); installJudgmentPort(fake.port);
  await expect(classifyTone(['Ordinary author text.'])).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(fake.requests).toHaveLength(0);
});
test('missing judgment transport cannot fall back to keyword tone', async () => {
  const owner = source(); await expect(classifyTone(['kindly pursuant cheers'], { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
});
test('complete source and meaningful tail survive the previous preview length', async () => {
  const body = 'Ordinary paragraph. '.repeat(300) + 'The actual ending remains neutral.';
  const fake = neutral([body]), owner = source(); installJudgmentPort(fake.port);
  expect(await classifyTone([body], { sourceOwner: owner.owner })).toBe('neutral');
  expect(fake.requests[0]?.state).toEqual({ bodies: [body] });
  expect(JSON.stringify(owner.calls)).toContain('The actual ending remains neutral.');
});
test('a private tail withheld by the actual source owner holds the complete corpus', async () => {
  const tail = 'synthetic-private-tail', body = 'Ordinary paragraph. '.repeat(300) + tail;
  const owner = source({ spans: exactRouteSourceSpans([tail]) }), fake = neutral([body]); installJudgmentPort(fake.port);
  await expect(classifyTone([body], { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(fake.requests).toHaveLength(0);
});
test.each(['inline-credential', 'card', 'accessor', 'hidden', 'proxy'] as const)('%s original input refuses before private screening or semantics', async kind => {
  const owner = source(), fake = neutral(['Ordinary author text.']); installJudgmentPort(fake.port); let getterCalls = 0;
  const bodies = kind === 'inline-credential' ? ['Authorization: Bearer synthetic-private-credential']
    : kind === 'card' ? ['4242 4242 4242 4242'] : ['Ordinary author text.'];
  if (kind === 'accessor') Object.defineProperty(bodies, '0', { get() { getterCalls++; return 'Ordinary author text.'; }, enumerable: true });
  if (kind === 'hidden') Object.defineProperty(bodies, 'unused', { value: 'synthetic-private-hidden', enumerable: false });
  const input = kind === 'proxy' ? new Proxy(bodies, { get() { getterCalls++; throw new Error('Do not read proxy'); } }) : bodies;
  await expect(classifyTone(input, { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(owner.calls).toHaveLength(0); expect(fake.requests).toHaveLength(0); expect(getterCalls).toBe(0);
});
test.each([0.5, 0.8] as const)('unsettled or confirm-band sentence evidence %s never becomes a count', async probability => {
  const owner = source(), fake = fakePort((name, question) => {
    if (name !== 'item_0' || question.type !== 'noul') throw new Error('Unexpected exact sentence question');
    return noulAnswer(probability);
  }); installJudgmentPort(fake.port);
  await expect(countSentences('Ready.', { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
});
test('abbreviation punctuation does not supply sentence-count authority', async () => {
  const text = 'Dr. Lee arrived.', owner = source();
  const fake = fakePort((name, question, state) => {
    const items = object(state).items;
    if (!Array.isArray(items) || !/^item_\d+$/.test(name) || question.type !== 'noul' || object(items[0]).document !== text) throw new Error('Unknown exact sentence state');
    return noulAnswer(object(items[Number(name.slice(5))]).position === text.length ? 0.999 : 0.001);
  }); installJudgmentPort(fake.port);
  expect(await countSentences(text, { sourceOwner: owner.owner })).toBe(1);
  expect(JSON.stringify(fake.requests)).toContain('Dr. Lee arrived.');
});
test('quoted greeting and formal vocabulary do not override actual author style', async () => {
  const body = 'Dear Jo,\nThe old template says "Hi, kindly, pursuant, sincerely". Let us use plain text.\nKind regards,\nMorgan';
  const owner = source(), fake = fakePort((name, question, state) => {
    const data = object(state);
    if (name === 'tone' && question.type === 'choice' && JSON.stringify(data) === JSON.stringify({ bodies: [body] })) return choiceAnswer(question, 'neutral', 0.999);
    const items = data.items;
    if (!Array.isArray(items) || !/^item_\d+$/.test(name) || question.type !== 'noul') throw new Error('Unknown complete corpus question');
    const item = object(items[Number(name.slice(5))]);
    if (item.body === body && item.purpose === 'greeting') return noulAnswer(item.candidate === 'Dear' ? 0.999 : 0.001);
    if (item.body === body && item.purpose === 'signOff') return noulAnswer(item.candidate === 'Kind regards' ? 0.999 : 0.001);
    if (object(items[0]).document === body) {
      const endings = [body.indexOf('".') + 2, body.indexOf('plain text.') + 'plain text.'.length];
      return noulAnswer(endings.includes(Number(item.position)) ? 0.999 : 0.001);
    }
    throw new Error('Unknown complete corpus evidence');
  }); installJudgmentPort(fake.port);
  expect(await extractStyleProfile([{ bodyPreview: body }], { sourceOwner: owner.owner })).toEqual({ greeting: 'Dear', signOff: 'Kind regards', medianSentenceCount: 2, tone: 'neutral', isDefault: false });
});
test.each([
  ['Maria del Carmen Ruiz <maria@example.test>', 'Maria del Carmen'],
  ['No Reply <noreply@example.test>', ''],
] as const)('personal name for %s is an offered supported span', async (from, expected) => {
  const owner = source(), fake = fakePort((name, question, state) => {
    const data = object(state), candidates = data.candidates;
    if (object(data.context).from !== from || !Array.isArray(candidates)) throw new Error('Unknown exact From evidence');
    const offered = candidates.map(object), selected = offered.find(candidate => object(candidate.content).text === expected), chosen = selected?.id ?? 'none';
    if (name === 'pick' && question.type === 'choice' && typeof chosen === 'string') return choiceAnswer(question, chosen, 0.999);
    if (/^fits_\d+$/.test(name) && question.type === 'noul') return noulAnswer(object(offered[Number(name.slice(5))]).id === chosen ? 0.999 : 0.001);
    throw new Error('Unknown exact name question');
  }); installJudgmentPort(fake.port);
  expect(await extractSenderName(from, { sourceOwner: owner.owner })).toBe(expected);
});
test('a corpus changed while source screening is pending cannot reach semantics', async () => {
  const bodies = ['Ordinary author text.'], owner = source({ beforeProposal: async () => { bodies[0] = 'Changed original author text.'; } });
  const fake = neutral(['Ordinary author text.']); installJudgmentPort(fake.port);
  await expect(classifyTone(bodies, { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError); expect(fake.requests).toHaveLength(0);
});
test.each(['source', 'caller', 'port', 'cancel'] as const)('%s retirement while semantics is pending holds publication', async kind => {
  const bodies = ['Ordinary author text.'], fake = neutral(bodies.slice()), wait = pending(fake.port), owner = source(), controller = new AbortController();
  const options = { sourceOwner: owner.owner, signal: controller.signal, assertCurrent: () => {} };
  installJudgmentPort(wait.port); const work = classifyTone(bodies, options); await wait.entered;
  if (kind === 'source') bodies[0] = 'Changed original author text.';
  if (kind === 'caller') options.assertCurrent = () => {};
  if (kind === 'port') { installJudgmentPort(fake.port); installJudgmentPort(wait.port); }
  if (kind === 'cancel') controller.abort();
  wait.release(); await expect(work).rejects.toBeInstanceOf(StyleReplyReadingError);
});
test('cancellation interrupts a noncooperating semantic reply before its late result', async () => {
  const fake = neutral(['Ordinary author text.']), wait = pending(fake.port), owner = source(), controller = new AbortController();
  installJudgmentPort(wait.port); const work = classifyTone(['Ordinary author text.'], { sourceOwner: owner.owner, signal: controller.signal });
  await wait.entered; controller.abort(); await expect(work).rejects.toBeInstanceOf(StyleReplyReadingError); wait.release();
});
test('replacement owner getters are not invoked and original release drains', async () => {
  const owner = source(), originalRelease = owner.owner.release, fake = neutral(['Ordinary author text.']), wait = pending(fake.port); let getters = 0;
  installJudgmentPort(wait.port); const work = classifyTone(['Ordinary author text.'], { sourceOwner: owner.owner }); await wait.entered;
  Object.defineProperty(owner.owner, 'release', { configurable: true, get() { getters++; return originalRelease; } });
  wait.release(); await expect(work).rejects.toBeInstanceOf(StyleReplyReadingError); expect(getters).toBe(0);
  Object.defineProperty(owner.owner, 'release', { configurable: true, writable: true, value: originalRelease });
});
test('unknown private response metadata is refused before conclusions are recorded', async () => {
  const owner = source(), fake = neutral(['Ordinary author text.']); let records = 0;
  const port: JudgmentPort = { model: fake.port.model, recorder: { recordReadings() { records++; }, recordAction() { records++; } }, async ask(request) {
    return { ...await fake.port.ask(request), decisionId: 'synthetic-style-response', extra: 'Authorization: Bearer synthetic-private-response' };
  } }; installJudgmentPort(port);
  await expect(classifyTone(['Ordinary author text.'], { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError); expect(records).toBe(0);
});
test('retained publication restrictions are pure and still observe original source edits', async () => {
  const body = ['Ordinary author text.'], owner = source(), fake = neutral(body.slice()), guards: Array<() => void> = [];
  installJudgmentPort(fake.port);
  expect(await classifyTone(body, { sourceOwner: owner.owner, assertCurrent: () => guards.forEach(guard => guard()), retainCurrent: guard => guards.push(guard) })).toBe('neutral');
  for (const guard of guards) guard(); body[0] = 'Changed original author text.';
  expect(() => guards.forEach(guard => guard())).toThrow(StyleReplyReadingError);
});
test('draft result uses detached profile and has no delivery port', async () => {
  const profile = { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true } satisfies Parameters<typeof composeDraftReply>[1];
  const owner = source(); installJudgmentPort(fakePort(() => { throw new Error('Empty From has no name question'); }).port);
  const result = await composeDraftReply({ from: '', subject: 'Project update', bodyPreview: 'Full ordinary inbound.' }, profile, 'The plan is ready.', () => false, { sourceOwner: owner.owner });
  expect(result.requiresBeforeSendReview).toBe(true); expect(result.profile).toEqual(profile); expect(result.profile).not.toBe(profile);
  profile.greeting = 'Changed caller profile'; expect(result.profile.greeting).toBe('Hi');
});

test('empty body text does not drop other supplied message fields from protection', async () => {
  const privateText = 'synthetic-private-subject', owner = source({ spans: exactRouteSourceSpans([privateText]) });
  const fake = fakePort(() => { throw new Error('No empty-body question may run'); }); installJudgmentPort(fake.port);
  const messages = [{ bodyPreview: '', subject: privateText }];
  await expect(extractStyleProfile(messages, { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(JSON.stringify(owner.calls)).toContain(privateText); expect(fake.requests).toHaveLength(0);
});
test('empty sender does not drop complete inbound and context protection', async () => {
  const privateText = 'synthetic-private-context', owner = source({ spans: exactRouteSourceSpans([privateText]) });
  const fake = fakePort(() => { throw new Error('Empty From has no name question'); }); installJudgmentPort(fake.port);
  const profile = { greeting: 'Hi', signOff: 'Thanks', medianSentenceCount: 3, tone: 'neutral', isDefault: true } satisfies Parameters<typeof composeDraftReply>[1];
  await expect(composeDraftReply({ from: '', subject: 'Project update', bodyPreview: 'Complete ordinary body.' }, profile, privateText, () => false, { sourceOwner: owner.owner })).rejects.toBeInstanceOf(StyleReplyReadingError);
  expect(JSON.stringify(owner.calls)).toContain(privateText); expect(fake.requests).toHaveLength(0);
});
