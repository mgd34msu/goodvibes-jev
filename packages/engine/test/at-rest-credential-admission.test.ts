import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import {
  AtRestLineWriter,
  clearAtRestCredentialReadings,
  readAtRestCredentialSpans,
  redactAtRestLine,
} from '../sdk/src/platform/runtime/at-rest-persistence.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import { captureRedactionSource, redactSensitiveData, registerAccountIdentityRedaction, registerProfileRedactionValues } from '../sdk/src/platform/utils/redaction.ts';

const DOCUMENT = 'key-rotation-policy-for-tenants';
// Synthetic sentinel values only. Nothing in this suite contacts a live service.
const PRIVATE = 'synthetic-private-sentinel';
const ISSUER = `ghp_${'x'.repeat(36)}`;
const PEM_LABEL = 'PRIVATE KEY';
const SYNTHETIC_PEM = `-----BEGIN ${PEM_LABEL}-----\nsynthetic\n-----END ${PEM_LABEL}-----`;
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  clearAtRestCredentialReadings();
});
afterEach(() => {
  registerProfileRedactionValues(null);
  registerAccountIdentityRedaction(null);
  installJudgmentPort(previous);
  clearAtRestCredentialReadings();
});

function safePort() { return fakePort(() => noulAnswer(0.01)); }

const protectedInputs = [
  ['declared value outside the candidate context', JSON.stringify({ body: `${DOCUMENT} ${'ordinary '.repeat(100)}`, password: PRIVATE })],
  ['nested encoded JSON', JSON.stringify({ body: DOCUMENT, nested: JSON.stringify({ password: PRIVATE }) })],
  ['decoded key in a JSONL batch', `${JSON.stringify({ body: DOCUMENT })}\n{"\\u0070assword":"${PRIVATE}"}\n`],
  ['issuer outside the candidate context', JSON.stringify({ body: `${DOCUMENT} ${'ordinary '.repeat(100)} ${ISSUER}` })],
  ['JSON-escaped issuer', `{"body":"${DOCUMENT}","note":"\\u0067hp_${'x'.repeat(36)}"}`],
  ['nested JSON-escaped issuer', JSON.stringify({ body: DOCUMENT, nested: '{"note":"\\u0067hp_' + 'x'.repeat(36) + '"}' })],
  ['PAN', JSON.stringify({ body: DOCUMENT, note: '4111 1111 1111 1111' })],
  ['PEM in a complete decoded record', JSON.stringify({ body: DOCUMENT, note: SYNTHETIC_PEM })],
  ['intact multiline source', `${JSON.stringify({ body: DOCUMENT })}\n${SYNTHETIC_PEM}\n`],
  ['URL password', JSON.stringify({ body: DOCUMENT, note: `https://synthetic:${PRIVATE}@example.invalid/path` })],
  ['protected key in a later batch record', `${JSON.stringify({ body: DOCUMENT })}\n${JSON.stringify({ password: PRIVATE })}\n`],
  ['malformed record', `${JSON.stringify({ body: DOCUMENT })}\n{"broken":`],
  ['unsupported oversized input', JSON.stringify({ body: DOCUMENT, note: 'x'.repeat(1_000_001) })],
] as const;

describe('complete at-rest source admission before any provider request', () => {
  for (const [label, input] of protectedInputs) {
    test(`${label}: zero requests and candidate stays masked`, async () => {
      const fake = safePort();
      installJudgmentPort(fake.port);
      await readAtRestCredentialSpans([input], 'test.at-rest-admission');
      expect(fake.requests).toHaveLength(0);
      expect(redactAtRestLine(input)).not.toContain(DOCUMENT);
      if (input.includes(ISSUER)) expect(redactAtRestLine(input)).not.toContain(ISSUER);
      // This patch preserves the persisted record schema; it does not claim
      // to mask arbitrary noncandidate values such as PRIVATE on disk.
    });
  }

  test('the actual writer preserves safe JSONL batching and admits all decoded records', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const safe = `${JSON.stringify({ body: DOCUMENT })}\n${JSON.stringify({ body: 'ordinary record' })}\n`;
    const protectedBatch = `${JSON.stringify({ body: DOCUMENT })}\n${JSON.stringify({ password: PRIVATE })}\n`;
    const output: string[] = [];
    const writer = new AtRestLineWriter('test.at-rest-admission');
    writer.write(safe, (line) => output.push(line));
    writer.write(protectedBatch, (line) => output.push(line));
    await writer.flush();
    expect(fake.requests).toHaveLength(1);
    expect(output).toHaveLength(2);
    expect(output[0]).toContain(DOCUMENT);
    expect(output[1]).not.toContain(DOCUMENT);
    expect(output[0]!.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(2);
    expect(output[1]!.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(2);
  });

  test('independent complete array elements do not borrow a refused record as context', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const safe = JSON.stringify({ body: DOCUMENT });
    const refused = JSON.stringify({ body: DOCUMENT, password: PRIVATE });
    await readAtRestCredentialSpans([safe, refused], 'test.at-rest-admission');
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests)).not.toContain(PRIVATE);
    expect(redactAtRestLine(safe)).toContain(DOCUMENT);
    expect(redactAtRestLine(refused)).not.toContain(DOCUMENT);
  });

  test('profile registration A to B to A cannot resurrect a cached clear reading', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const reader = () => ({ guarded: [], absolute: [] });
    registerProfileRedactionValues(reader);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    registerProfileRedactionValues(() => ({ guarded: [], absolute: [DOCUMENT] }));
    registerProfileRedactionValues(reader);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(fake.requests).toHaveLength(2);
  });

  test('stale profile disposer leaves the replacement active; current disposal is idempotent', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const disposeA = registerProfileRedactionValues(() => ({ guarded: [], absolute: [] }));
    const disposeB = registerProfileRedactionValues(() => ({ guarded: [], absolute: [PRIVATE] }));
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    disposeA();
    expect(redactSensitiveData(PRIVATE)).not.toContain(PRIVATE);
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    disposeB();
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    const afterDispose = captureRedactionSource();
    disposeB();
    expect(() => afterDispose.assertCurrent()).not.toThrow();
  });

  test('stale identity disposer leaves replacement identity and its proof lifetime intact', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const identity = { homeDirectory: '/home/synthetic-owner', userName: 'synthetic-owner' };
    const disposeA = registerAccountIdentityRedaction(() => identity);
    const disposeB = registerAccountIdentityRedaction(() => identity);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    disposeA();
    expect(redactSensitiveData(identity.homeDirectory)).not.toContain(identity.userName);
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    disposeB();
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    const afterDispose = captureRedactionSource();
    disposeB();
    expect(() => afterDispose.assertCurrent()).not.toThrow();
  });

  test('profile A to B to A while a reading completes cannot publish a clear result', async () => {
    const reader = () => ({ guarded: [], absolute: [] });
    registerProfileRedactionValues(reader);
    const fake = fakePort(() => {
      registerProfileRedactionValues(() => ({ guarded: [], absolute: [DOCUMENT] }));
      registerProfileRedactionValues(reader);
      return noulAnswer(0.01);
    });
    installJudgmentPort(fake.port);
    const line = JSON.stringify({ body: DOCUMENT });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('equal profile reloads retire a reading through the host load-generation identity', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    let generation: object = {};
    registerProfileRedactionValues(() => ({ guarded: [], absolute: [] }), () => generation);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    generation = {}; // Actual store.status() replaces its object on every load.
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('same-reader registration and identity clear each retire a cached reading', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const reader = () => ({ guarded: [], absolute: [] });
    registerProfileRedactionValues(reader);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    registerProfileRedactionValues(reader);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    registerAccountIdentityRedaction(null);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('simultaneously current source authority frames cannot share a clear proof', async () => {
    const fake = safePort();
    let identity: object = {};
    bindJudgmentPortAuthority(fake.port, () => ({ identity, assertCurrent: () => {} }));
    installJudgmentPort(fake.port);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    identity = {};
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(fake.requests).toHaveLength(2);
  });

  test('a no reading is source/context scoped, not reusable on the same token elsewhere', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const first = JSON.stringify({ body: `read docs/${DOCUMENT}.md` });
    const second = JSON.stringify({ body: `a different use of ${DOCUMENT}` });
    await readAtRestCredentialSpans([first, first], 'test.at-rest-admission');
    expect(fake.requests).toHaveLength(1);
    expect(redactAtRestLine(first)).toContain(DOCUMENT);
    expect(redactAtRestLine(second)).not.toContain(DOCUMENT);
    await readAtRestCredentialSpans([second], 'test.at-rest-admission');
    expect(fake.requests).toHaveLength(2);
    expect(redactAtRestLine(second)).toContain(DOCUMENT);
  });

  test('port replacement and restoring the same port cannot resurrect a prior clear reading', async () => {
    const fake = safePort();
    installJudgmentPort(fake.port);
    const line = JSON.stringify({ body: DOCUMENT });
    await readAtRestCredentialSpans([line], 'test.at-rest-admission');
    expect(redactAtRestLine(line)).toContain(DOCUMENT);
    installJudgmentPort(undefined);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    installJudgmentPort(fake.port);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('a source authority revoked during a reading leaves the candidate masked', async () => {
    let current = true;
    const fake = fakePort(() => { current = false; return noulAnswer(0.01); });
    bindJudgmentPortAuthority(fake.port, () => ({ identity: fake.port, assertCurrent: () => { if (!current) throw new Error(PRIVATE); } }));
    installJudgmentPort(fake.port);
    const line = JSON.stringify({ body: DOCUMENT });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('queued originals cannot silently borrow a replacement runtime port', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fake = safePort();
    let oldCalls = 0;
    installJudgmentPort({
      ...fake.port,
      async ask(request) {
        oldCalls += 1;
        started.resolve();
        await release.promise;
        return fake.port.ask(request);
      },
    });
    const output: string[] = [];
    const writer = new AtRestLineWriter('test.at-rest-admission');
    writer.write(JSON.stringify({ body: DOCUMENT }), (line) => output.push(line));
    writer.write(JSON.stringify({ body: `second ${DOCUMENT}` }), (line) => output.push(line));
    await started.promise;
    const replacement = safePort();
    installJudgmentPort(replacement.port);
    await writer.flush();
    expect(oldCalls).toBe(1);
    expect(replacement.requests).toHaveLength(0);
    expect(output).toHaveLength(2);
    expect(output.join('\n')).not.toContain(DOCUMENT);
    release.resolve();
  });

  test('missing port and hostile provider errors do not leak raw diagnostics or unmask a candidate', async () => {
    const line = JSON.stringify({ body: DOCUMENT });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    const output: string[] = [];
    const warnings: string[] = [];
    const warning = spyOn(logger, 'warn').mockImplementation((message) => { warnings.push(message); });
    let inspected = false;
    try {
      const rejection = Object.defineProperty({}, 'message', { get() { inspected = true; throw new Error(PRIVATE); } });
      installJudgmentPort({ ...safePort().port, async ask() { throw rejection; } });
      const writer = new AtRestLineWriter('test.at-rest-admission');
      writer.write(line, (text) => output.push(text));
      await writer.flush();
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(DOCUMENT);
      expect(warnings.join('\n')).not.toContain(PRIVATE);
      expect(warnings.join('\n')).not.toContain(DOCUMENT);
      expect(inspected).toBe(false);
    } finally { warning.mockRestore(); }
  });

  test('profile retirement during a response fences real decision-log entries and attachments', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const record = spyOn(log, 'record');
    const attach = spyOn(log, 'attach');
    try {
      const fake = fakePort(() => {
        registerProfileRedactionValues(() => ({ guarded: [], absolute: [DOCUMENT] }));
        return noulAnswer(0.01);
      });
      installJudgmentPort(withDecisionLog(fake.port, log));
      const line = JSON.stringify({ body: DOCUMENT });
      await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
      expect(fake.requests).toHaveLength(1);
      expect(record).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
      expect(log.query()).toEqual([]);
      expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
    } finally { record.mockRestore(); attach.mockRestore(); }
  });

  test('a hostile profile reader cannot leak its rejection or append raw fallback', () => {
    let inspected = false;
    const rejection = Object.defineProperty({}, 'message', { get() { inspected = true; return PRIVATE; } });
    registerProfileRedactionValues(() => { throw rejection; });
    const output: string[] = [];
    const line = JSON.stringify({ body: DOCUMENT });
    const writer = new AtRestLineWriter('test.at-rest-admission');
    expect(() => writer.write(line, (text) => output.push(text))).toThrow('unavailable');
    expect(() => redactAtRestLine(line)).toThrow('unavailable');
    expect(output).toEqual([]);
    expect(inspected).toBe(false);
  });

  test('the canonical retry guard rechecks profile admission before another attempt', async () => {
    const fake = safePort();
    let attempts = 0;
    installJudgmentPort({
      ...fake.port,
      async ask(request) {
        request.beforeAttempt?.();
        attempts += 1;
        registerProfileRedactionValues(() => ({ guarded: [], absolute: [DOCUMENT] }));
        // A transport retry calls the guard before dispatching again.
        request.beforeAttempt?.();
        attempts += 1;
        return fake.port.ask(request);
      },
    });
    const line = JSON.stringify({ body: DOCUMENT });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
    expect(attempts).toBe(1);
    expect(fake.requests).toHaveLength(0);
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });

  test('a same-key read joining a retired flight can recover on the next fresh call', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fake = safePort();
    let calls = 0;
    const reader = () => ({ guarded: [], absolute: [] });
    registerProfileRedactionValues(reader);
    installJudgmentPort({
      ...fake.port,
      async ask(request) {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return fake.port.ask(request);
      },
    });
    const line = JSON.stringify({ body: DOCUMENT });
    const original = readAtRestCredentialSpans([line], 'test.at-rest-admission').catch((error: unknown) => error);
    try {
      await entered.promise;
      registerProfileRedactionValues(reader); // Same text, a new registration lifetime.
      const joined = readAtRestCredentialSpans([line], 'test.at-rest-admission').catch((error: unknown) => error);
      release.resolve();
      const failures = await Promise.all([original, joined]);
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('At-rest credential reading is unavailable; unread spans remain masked');
      }
      expect(calls).toBe(1);
      expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
      // Both consumers settled and the rejected flight was removed. A fresh
      // call under the current owner must not be poisoned by that old promise.
      await readAtRestCredentialSpans([line], 'test.at-rest-admission');
      expect(calls).toBe(2);
      expect(fake.requests).toHaveLength(2);
      expect(redactAtRestLine(line)).toContain(DOCUMENT);
    } finally { release.resolve(); }
  });

  test('clearing readings while a request completes prevents late cache repopulation', async () => {
    const fake = fakePort(() => { clearAtRestCredentialReadings(); return noulAnswer(0.01); });
    installJudgmentPort(fake.port);
    const line = JSON.stringify({ body: DOCUMENT });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest-admission')).rejects.toThrow('unavailable');
    expect(redactAtRestLine(line)).not.toContain(DOCUMENT);
  });
});
