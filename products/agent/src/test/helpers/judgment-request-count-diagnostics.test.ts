import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createRequestCountDiagnostics } from './judgment-request-count-diagnostics.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

const question = { type: 'noul', instructions: 'Synthetic isolated count fixture.' } satisfies
  Parameters<ReturnType<typeof fakePort>['port']['ask']>[0]['questions'][string];

function fixture() {
  const lines: string[] = [];
  const diagnostics = createRequestCountDiagnostics('counter-diagnostic-control', line => { lines.push(line); });
  diagnostics.beginFixture();
  const fake = diagnostics.track(fakePort(() => noulAnswer(0.01)), 'original-fake');
  return { lines, diagnostics, fake };
}

test('correct raw counts do not emit or inspect a retained request', () => {
  const f = fixture(); let touched = 0;
  f.fake.requests.push({ get state() { touched++; return 'Synthetic private value'; }, questions: { match: question } });
  const ask = f.fake.port.ask;
  f.diagnostics.reportUnexpectedCount(f.fake, 1, 'correct-count');
  expect(f.lines).toEqual([]); expect(touched).toBe(0);
  expect(f.fake.requests).toHaveLength(1); expect(f.fake.port.ask).toBe(ask);
});

test.each(['private', 'accessor', 'proxy'])('%s request diagnostics expose no private value or hostile callback', kind => {
  const f = fixture(), sensitive = 'Synthetic-private-value-and-field-name'; let touched = 0;
  const original = { [sensitive]: sensitive };
  if (kind === 'accessor') Object.defineProperty(original, 'hostile', { enumerable: true, get() { touched++; return sensitive; } });
  const state = kind === 'proxy' ? new Proxy(original, {
    get() { touched++; return sensitive; }, ownKeys() { touched++; return []; },
    getOwnPropertyDescriptor() { touched++; return undefined; }, getPrototypeOf() { touched++; return null; },
  }) : original;
  f.fake.requests.push({ state, questions: { [sensitive]: { type: 'noul', instructions: sensitive } }, context: { battery: sensitive } });
  f.diagnostics.reportUnexpectedCount(f.fake, 0, 'private-count');
  expect(f.lines).toHaveLength(1); expect(f.lines.join('')).not.toContain(sensitive); expect(touched).toBe(0);
  const report: unknown = JSON.parse(f.lines[0] ?? 'null');
  expect(report).toMatchObject({ expected: 0, actual: 1, requests: [{
    battery: { kind: 'opaque', sha256: expect.any(String) }, questionIds: [{ kind: 'opaque', sha256: expect.any(String) }],
    state: { sha256: expect.any(String), shape: kind === 'proxy' ? { proxies: 1 } : kind === 'accessor' ? { accessors: 1 } : { objects: 1 } },
  }] });
  expect(f.fake.requests).toHaveLength(1);
});

test('strict refusal and raw request counts remain unchanged after failure reporting', async () => {
  const lines: string[] = [];
  const diagnostics = createRequestCountDiagnostics('strict-counter-control', line => { lines.push(line); });
  diagnostics.beginFixture();
  const fake = diagnostics.track(fakePort(() => { throw new Error('Original strict synthetic refusal'); }), 'strict-fake');
  const request = { state: { field: 'path' }, questions: { kind: question }, context: { battery: 'engine.redaction.field-kind' } };
  const ask = fake.port.ask;
  await expect(fake.port.ask(request)).rejects.toThrow('Original strict synthetic refusal');
  expect(fake.requests).toHaveLength(1);
  diagnostics.reportUnexpectedCount(fake, 0, 'strict-counter');
  expect(lines).toHaveLength(1); expect(fake.requests).toHaveLength(1); expect(fake.port.ask).toBe(ask);
  const report: unknown = JSON.parse(lines[0] ?? 'null');
  expect(report).toMatchObject({ requests: [{ battery: { kind: 'known', id: 'engine.redaction.field-kind' },
    questionIds: [{ kind: 'known', id: 'kind' }] }] });
  await expect(fake.port.ask(request)).rejects.toThrow('Original strict synthetic refusal');
  expect(fake.requests).toHaveLength(2);
});

test('installation and restore facts preserve native return values and never invoke port getters', () => {
  const f = fixture(), original = fakePort(() => noulAnswer(0.01)); let touched = 0;
  Object.defineProperty(f.fake.port, 'model', { get() { touched++; return 'Synthetic private model'; } });
  expect(f.diagnostics.installPort(original.port)).toBeUndefined();
  expect(f.diagnostics.installPort(f.fake.port)).toBe(original.port);
  expect(judgmentPort('counter-install-control')).toBe(f.fake.port);
  expect(f.diagnostics.installPort(undefined)).toBe(f.fake.port);
  expect(f.diagnostics.installPort(original.port)).toBeUndefined();
  f.diagnostics.endFixture();
  f.fake.requests.push({ state: 'Synthetic private source', questions: { match: question } });
  f.diagnostics.reportUnexpectedCount(f.fake, 0, 'restored-fixture');
  expect(touched).toBe(0); expect(f.lines).toHaveLength(1);
  const report: unknown = JSON.parse(f.lines[0] ?? 'null');
  expect(report).toMatchObject({ creation: { closed: true, creator: 'original-fake', fakeId: expect.any(Number), portObjectId: expect.any(Number) },
    currentFixture: { closed: true }, currentPortObjectId: expect.any(Number), portMatchesLastTrackedInstall: true,
    installationEvents: expect.arrayContaining([{ fixture: expect.any(Number), before: expect.any(Number), requested: null, after: null }]) });
  expect(f.lines.join('')).not.toContain('Synthetic private');
});

test('an untracked native installation is visible without acquiring any reading owner', () => {
  const f = fixture(), replacement = fakePort(() => noulAnswer(0.01));
  f.diagnostics.installPort(f.fake.port);
  installJudgmentPort(replacement.port);
  f.fake.requests.push({ state: 'Synthetic private source', questions: { match: question } });
  f.diagnostics.reportUnexpectedCount(f.fake, 0, 'untracked-replacement');
  const report: unknown = JSON.parse(f.lines[0] ?? 'null');
  expect(report).toMatchObject({ portMatchesLastTrackedInstall: false, currentPortObjectId: expect.any(Number),
    installationFacts: 'Observed public port objects and tracked fixture installs only; no native authority lease acquired.' });
  expect(judgmentPort('counter-untracked-control')).toBe(replacement.port);
});
