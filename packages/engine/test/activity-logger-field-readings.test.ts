import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { ActivityLogger } from '../sdk/src/platform/utils/logger.js';
import { FieldKindReader } from '../sdk/src/platform/utils/field-kind-reading.js';

let previous: ReturnType<typeof installJudgmentPort>;
const roots: string[] = [];
const loggers: ActivityLogger[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  for (const logger of loggers.splice(0)) logger.dispose();
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function loggerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'logger-field-reading-')); roots.push(root);
  const logger = new ActivityLogger(); loggers.push(logger); logger.configure(root);
  return { logger, text() { logger.flushSync(); return readFileSync(join(root, 'activity.md'), 'utf8'); } };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('unknown structured fields are masked synchronously without a reader', () => {
  const { logger, text } = loggerFixture();
  logger.info('record', { unlockPassphrase: 'private-example', tokenCount: 42 });
  const written = text();
  expect(written).not.toContain('private-example');
  const lines = written.split('\n');
  expect(lines[0]).toMatch(/^\[[^\]]+\] \[INFO\] record$/);
  expect(lines[1]).toBe('```json');
  expect(lines.at(-2)).toBe('```');
  expect(lines.at(-1)).toBe('');
  const data: unknown = JSON.parse(lines.slice(2, -2).join('\n'));
  expect(data).toEqual({ unlockPassphrase: '[REDACTED]', tokenCount: '[REDACTED]' });
});

test('current settled fields contradict the former token substring heuristic without transmitting values', async () => {
  const fake = fakePort((_, question, state) => choiceAnswer(question,
    state !== null && typeof state === 'object' && !Array.isArray(state)
      && 'field' in state && state.field === 'unlockPassphrase' ? 'secret' : 'other', 0.99));
  installJudgmentPort(fake.port);
  const { logger, text } = loggerFixture();
  logger.info('prepare', { tokenCount: 17, max_tokens: 8192, unlockPassphrase: 'private-example' });
  await settle();
  logger.info('current', { tokenCount: 17, max_tokens: 8192, unlockPassphrase: 'private-example' });
  const written = text();
  expect(written).toContain('"tokenCount": 17'); expect(written).toContain('"max_tokens": 8192');
  expect(written).not.toContain('private-example');
  expect(fake.requests).toHaveLength(3);
  expect(fake.requests.every((request) => request.state !== null && typeof request.state === 'object'
    && Object.keys(request.state).join() === 'field')).toBe(true);
  expect(JSON.stringify(fake.requests)).not.toContain('private-example');
});

test('profile fields are withheld and nested/cyclic ordinary data is inspected recursively', async () => {
  const fake = fakePort((_, question, state) => choiceAnswer(question,
    state !== null && typeof state === 'object' && !Array.isArray(state)
      && 'field' in state && state.field === 'shippingAddress' ? 'owner_profile' : 'other', 0.99));
  installJudgmentPort(fake.port);
  const { logger, text } = loggerFixture();
  const data: Record<string, unknown> = { details: { count: 4, shippingAddress: 'private-address-example' } };
  data['self'] = data;
  logger.info('prepare parent', data); await settle();
  logger.info('prepare child', data); await settle();
  logger.info('current', data);
  const written = text();
  expect(written).toContain('"count": 4'); expect(written).toContain('[Circular]');
  expect(written).toContain('[REDACTED_PROFILE]'); expect(written).not.toContain('private-address-example');
  expect(JSON.stringify(fake.requests)).not.toContain('private-address-example');
});

test('unsettled and failed readers never release a value', async () => {
  const uncertain = fakePort((_, question) => choiceAnswer(question, 'other', 0.55));
  installJudgmentPort(uncertain.port);
  const { logger, text } = loggerFixture();
  logger.info('uncertain', { opaque: 'withheld-example' }); await settle();
  logger.info('still uncertain', { opaque: 'withheld-example' }); await settle();
  installJudgmentPort({ model: 'synthetic-failed', async ask() { throw new Error('synthetic reader failure'); } });
  logger.info('failed', { opaque: 'withheld-example' }); await settle();
  logger.info('still failed', { opaque: 'withheld-example' });
  expect(text()).not.toContain('withheld-example');
});

test('port replacement retires a previously ordinary field before the next append', async () => {
  const ordinary = fakePort((_, question) => choiceAnswer(question, 'other', 0.99));
  installJudgmentPort(ordinary.port);
  const { logger, text } = loggerFixture();
  logger.info('prepare', { custom: 'old-public-example' }); await settle();
  logger.info('current', { custom: 'old-public-example' });
  installJudgmentPort(fakePort((_, question) => choiceAnswer(question, 'secret', 0.99)).port);
  logger.info('replaced', { custom: 'new-private-example' }); await settle();
  logger.info('secret', { custom: 'new-private-example' });
  expect(text()).toContain('old-public-example'); expect(text()).not.toContain('new-private-example');
});

test('late answers cannot release values after logger disposal', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fake = fakePort((_, question) => choiceAnswer(question, 'other', 0.99));
  installJudgmentPort({ ...fake.port, async ask(request) { await wait; return fake.port.ask(request); } });
  const { logger, text } = loggerFixture();
  logger.info('pending', { custom: 'private-example' });
  logger.dispose(); release(); await settle();
  logger.info('disposed', { custom: 'private-example' });
  expect(text()).not.toContain('private-example');
});

test('reconfiguring a disposed logger requires a fresh field reading', async () => {
  const fake = fakePort((_, question) => choiceAnswer(question, 'other', 0.99)); installJudgmentPort(fake.port);
  const { logger, text } = loggerFixture();
  logger.info('prepare', { count: 4 }); await settle();
  logger.dispose();
  const root = mkdtempSync(join(tmpdir(), 'logger-field-restart-')); roots.push(root);
  logger.configure(root); logger.info('restart', { count: 'first-restarted-value' }); logger.flushSync();
  expect(readFileSync(join(root, 'activity.md'), 'utf8')).not.toContain('first-restarted-value');
  await settle(); logger.info('current restart', { count: 8 }); logger.flushSync();
  expect(readFileSync(join(root, 'activity.md'), 'utf8')).toContain('"count": 8');
  expect(text()).not.toContain('first-restarted-value');
});

test('model changes on the same installed port invalidate cached field meanings', async () => {
  let model = 'synthetic-first';
  const fake = fakePort((_, question) => choiceAnswer(question, model === 'synthetic-first' ? 'other' : 'secret', 0.99));
  installJudgmentPort({ get model() { return model; }, ask: fake.port.ask });
  const { logger, text } = loggerFixture();
  logger.info('prepare', { custom: 'public-before-change' }); await settle();
  logger.info('current', { custom: 'public-before-change' });
  model = 'synthetic-second';
  logger.info('changed model', { custom: 'private-after-change' }); await settle();
  logger.info('secret model', { custom: 'private-after-change' });
  expect(text()).toContain('public-before-change'); expect(text()).not.toContain('private-after-change');
  expect(fake.requests).toHaveLength(2);
});

test('protected material in field names is neither transmitted nor appended', () => {
  const fake = fakePort((_, question) => choiceAnswer(question, 'other', 0.99)); installJudgmentPort(fake.port);
  const { logger, text } = loggerFixture();
  logger.info('refused name', { 'OPENAI_API_KEY=SYNTHETIC_SECRET': 'private-example' });
  expect(fake.requests).toHaveLength(0);
  expect(text()).not.toContain('SYNTHETIC_SECRET'); expect(text()).not.toContain('private-example');
});

test('bounded field cache cancels evicted pending readings', async () => {
  const signals: AbortSignal[] = [];
  installJudgmentPort({ model: 'synthetic-held', ask(request) {
    if (request.signal) signals.push(request.signal);
    return new Promise(() => {});
  } });
  const reader = new FieldKindReader();
  try {
    expect(reader.read('ordinaryField0')).toBeUndefined(); await settle();
    for (let i = 1; i < 257; i++) expect(reader.read(`ordinaryField${i}`)).toBeUndefined();
    await settle();
    expect(signals).toHaveLength(257); expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  } finally { reader.dispose(); }
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test('async consumers await the same field reading and retain caller cancellation', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const fake = fakePort((_, question) => choiceAnswer(question, 'other', 0.99));
  installJudgmentPort({ ...fake.port, async ask(request) { await wait; return fake.port.ask(request); } });
  const abort = new AbortController();
  const reader = new FieldKindReader({ signal: abort.signal });
  try {
    expect(reader.read('tokenCount')).toBeUndefined();
    const first = reader.readAsync('tokenCount'), second = reader.readAsync('tokenCount');
    await settle(); abort.abort();
    expect(await first).toBeUndefined(); expect(await second).toBeUndefined();
    release(); await settle(); expect(reader.read('tokenCount')).toBeUndefined();
  } finally { release(); reader.dispose(); }
});

test('async consumers share one current settled result without recapturing during publication', async () => {
  const fake = fakePort((_, question) => choiceAnswer(question, 'other', 0.99)); installJudgmentPort(fake.port);
  let active = true;
  const reader = new FieldKindReader({ assertCurrent() { if (!active) throw new Error('synthetic source retired'); } });
  try {
    expect(await reader.readAsync('tokenCount')).toBe('other');
    expect(await reader.readAsync('tokenCount')).toBe('other');
    expect(fake.requests).toHaveLength(1);
    active = false; expect(await reader.readAsync('tokenCount')).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
  } finally { reader.dispose(); }
});
