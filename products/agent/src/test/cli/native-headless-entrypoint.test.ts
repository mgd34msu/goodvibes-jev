/**
 * Real Agent AND TUI entrypoints; native routes and persistence are never mocked.
 * Defaults to source. Set both GOODVIBES_HEADLESS_{AGENT,TUI}_BINARY and
 * GOODVIBES_HEADLESS_REQUIRE_BINARIES=1 to run the identical proof on artifacts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { HEADLESS_PROMPT, HEADLESS_REPLY, makeHeadlessFixture, readEnvelope, type HeadlessProduct } from './native-headless-process-harness.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); }, 30000);
async function fixture(product: HeadlessProduct, reply = HEADLESS_REPLY) {
  const value = await makeHeadlessFixture(product, reply); cleanups.push(() => value.close()); return value;
}
const json = ['--output-format', 'json'];
const literal = '  Keep CRLF\r\n😀 !@source.md @context [IMAGE: attached]  ';

for (const product of ['agent', 'tui'] as const) describe(`${product} real native headless entrypoint`, () => {
  test('run, exec and -p preserve exact original capture and source authority', async () => {
    const f = await fixture(product);
    for (const args of [['run', literal], ['exec', literal], ['-p', literal]]) {
      f.door.loseNext('capture');
      const result = await f.run([...args, ...json]);
      expect(result.code).toBe(3);
      const capture = f.captures().at(-1)!;
      expect(capture.text).toBe(literal);
      expect(Object.keys(capture).sort()).toEqual(['inputId', 'requestId', 'text', 'unsupportedSources']);
      expect(capture.unsupportedSources).toEqual([
        { kind: 'image', label: '[IMAGE: attached]' }, { kind: 'file', label: '!@source.md' }, { kind: 'context', label: '@context' },
      ]);
      expect(f.journal().records.at(-1)?.command).toEqual(capture);
      expect(f.model.requests).toHaveLength(0);
      expect(f.home.judgments.accepted).toHaveLength(0);
      const before = f.door.requests.length;
      const status = await f.run(['run', '--intake-status', ...json]);
      expect(status.code).toBe(0);
      expect(readEnvelope(status).native.result?.kind).toBe('captured');
      expect(f.intakeCalls(before)).toEqual(['get']);
      const cancelled = await f.run(['run', '--intake-cancel', ...json]);
      expect(readEnvelope(cancelled).native.result?.kind).toBe('cancelled');
    }
    expect(f.captures()).toHaveLength(3);
    expect(new Set(f.captures().map(capture => capture.inputId)).size).toBe(3);
  }, 30000);

  test('all recovery-looking tokens after literal -- remain source text', async () => {
    const f = await fixture(product);
    for (const flag of ['--intake-status', '--intake-retry', '--intake-resume', '--intake-cancel']) {
      f.door.loseNext('capture');
      const output = await f.run(['run', ...json, '--', flag]);
      expect(output.code).toBe(3);
      expect(f.captures().at(-1)?.text).toBe(flag);
      await f.run(['run', '--intake-cancel', ...json]);
    }
    expect(f.captures()).toHaveLength(4);
    expect(f.home.judgments.accepted).toHaveLength(0);
    expect(f.model.requests).toHaveLength(0);
  }, 30000);

  test('malformed or conflicting recovery controls exit before daemon/source IO', async () => {
    const f = await fixture(product);
    for (const args of [
      ['run', '--intake-status', '--intake-retry'],
      ['run', '--intake-status=anything'],
      ['run', '--intake-status', 'new source'],
      ['run', '--intake-cancel', '--prompt', 'new source'],
    ]) {
      const output = await f.run([...args, ...json]);
      expect(output.code).toBe(2);
    }
    expect(f.door.requests).toHaveLength(0);
    expect(existsSync(f.journalPath)).toBe(false);
    expect(f.model.requests).toHaveLength(0);
  }, 30000);

  test('lost admission response survives restart; status is read-only; explicit retry dispatches once', async () => {
    const f = await fixture(product);
    f.door.loseNext('admit');
    const lost = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(lost.code).toBe(3);
    expect(f.intakeCalls()).toEqual(['capture', 'admit']);
    expect(f.model.requests).toHaveLength(0);
    const captured = f.captures()[0]!;
    const journalBefore = readFileSync(f.journalPath, 'utf8');
    const judgmentsBefore = [...f.home.judgments.accepted];
    const beforeStatus = f.door.requests.length;
    const status = await f.run(['run', '--intake-status', ...json]);
    expect(status.code).toBe(0);
    expect(readEnvelope(status).native.result?.kind).toBe('turn');
    expect(f.intakeCalls(beforeStatus)).toEqual(['get']);
    expect(readFileSync(f.journalPath, 'utf8')).toBe(journalBefore);
    expect(f.home.judgments.accepted).toEqual(judgmentsBefore);
    expect(f.model.requests).toHaveLength(0);

    const recovered = await f.run(['exec', '--intake-retry', ...json]);
    expect(recovered.code, `${recovered.stdout}\n${recovered.stderr}`).toBe(0);
    expect(readEnvelope(recovered).response).toBe(HEADLESS_REPLY);
    expect(f.journal().records[0]?.command).toEqual(captured);
    expect(f.journal().records[0]?.dispatch).toBeDefined();
    expect(f.captures()).toHaveLength(1);
    expect(f.model.requests).toHaveLength(1);
    expect(f.home.judgments.accepted).toContain('native-route');
    expect(f.home.judgments.accepted).toContain('native-turn');
    expect(f.home.judgments.accepted).not.toContain('route');
    expect(f.home.judgments.accepted).not.toContain('turn');
    expect(`${recovered.stdout}${recovered.stderr}`).not.toContain(f.pairedToken);
    expect(recovered.stdout).not.toContain('turnPermit');

    const beforeRetry = f.door.requests.length;
    const repeated = await f.run(['run', '--intake-retry', ...json]);
    expect(repeated.code).toBe(3);
    expect(f.intakeCalls(beforeRetry)).toEqual(['get']);
    expect(f.model.requests).toHaveLength(1);
    expect(f.captures()).toHaveLength(1);
    expect(f.host.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
    expect(f.door.requests.some(request => /\/planning\/|\/submissions|\/sessions\/.*\/turns/.test(request.path))).toBe(false);
  }, 60000);

  test('text and stream-json keep runtime notices off stdout and omit capabilities', async () => {
    const f = await fixture(product);
    const plain = await f.run(['run', HEADLESS_PROMPT, '--output', 'text']);
    expect(plain.code, plain.stderr).toBe(0); expect(plain.stdout.trim()).toBe(HEADLESS_REPLY);
    const streamed = await f.run(['run', HEADLESS_PROMPT, '--output', 'stream-json']);
    expect(streamed.code, streamed.stderr).toBe(0);
    const lines = streamed.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; response?: string });
    expect(lines.filter(line => line.type === 'NATIVE_INTAKE_RESULT')).toHaveLength(1);
    expect(lines.at(-1)?.response).toBe(HEADLESS_REPLY);
    expect(lines.some(line => line.type === 'STREAM_DELTA')).toBe(true);
    expect(streamed.stdout).not.toContain('turnPermit'); expect(streamed.stdout).not.toContain(f.pairedToken);
    expect(f.model.requests).toHaveLength(2);
  }, 30000);

  test('large final JSON is fully flushed before the process exits', async () => {
    const reply = 'exact 😀 response\n'.repeat(16_384);
    const f = await fixture(product, reply);
    const output = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(output.code).toBe(0);
    expect(readEnvelope(output).response).toBe(reply);
  }, 30000);

  test('SIGINT while inspecting prior retained input never cancels that input', async () => {
    const f = await fixture(product);
    f.door.loseNext('capture');
    expect((await f.run(['run', HEADLESS_PROMPT, ...json])).code).toBe(3);
    const original = f.journal();
    const gate = f.door.holdNext('get');
    const child = f.start(['run', '--intake-status', ...json]);
    try {
      await Promise.race([gate.entered, child.output.then(output => { throw new Error(`Status exited before lookup: ${output.stdout} ${output.stderr}`); })]);
      child.interrupt();
      expect((await child.output).code).toBe(130);
    } finally { gate.release(); }
    expect(f.intakeCalls()).toEqual(['capture', 'get']);
    expect(f.journal()).toEqual(original);
    const status = await f.run(['run', '--intake-status', ...json]);
    expect(readEnvelope(status).native.result?.kind).toBe('captured');
    expect(f.model.requests).toHaveLength(0);
  }, 30000);

  test('SIGINT during owned admission cancels the exact captured input', async () => {
    const f = await fixture(product);
    const gate = f.door.holdNext('admit');
    const child = f.start(['run', HEADLESS_PROMPT, ...json]);
    try {
      await Promise.race([gate.entered, child.output.then(output => { throw new Error(`Submit exited before admission: ${output.stdout} ${output.stderr}`); })]);
      child.interrupt();
      const output = await child.output;
      expect(output.code).toBe(130);
      expect(readEnvelope(output).native.result?.kind).toBe('cancelled');
    } finally { gate.release(); }
    expect(f.captures()).toHaveLength(1);
    expect(f.intakeCalls()).toEqual(['capture', 'admit', 'get', 'cancel']);
    expect(f.model.requests).toHaveLength(0);
    const status = await f.run(['run', '--intake-status', ...json]);
    expect(readEnvelope(status).native.result?.kind).toBe('cancelled');
  }, 30000);

  test('SIGINT during new submit inspection cannot cancel an older retained input', async () => {
    const f = await fixture(product);
    f.door.loseNext('capture');
    await f.run(['run', HEADLESS_PROMPT, ...json]);
    const original = f.journal();
    const gate = f.door.holdNext('get');
    const child = f.start(['run', 'A different new prompt', ...json]);
    try {
      await Promise.race([gate.entered, child.output.then(output => { throw new Error(`Submit exited before lookup: ${output.stdout} ${output.stderr}`); })]);
      child.interrupt(); expect((await child.output).code).toBe(130);
    } finally { gate.release(); }
    expect(f.intakeCalls()).toEqual(['capture', 'get']);
    expect(f.journal()).toEqual(original); expect(f.captures()).toHaveLength(1);
    const status = await f.run(['run', '--intake-status', ...json]);
    expect(readEnvelope(status).native.result?.kind).toBe('captured');
  }, 30000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) test(`${signal} during an admitted model request still writes a final result when diagnostics are unavailable`, async () => {
    const f = await fixture(product);
    // A rejected optional diagnostic keeps the original failure path observable
    // without admitting unknown questions or hiding a fixture rejection.
    f.home.judgments.rejectRecordedCancellationTimings();
    const gate = f.holdAdmittedModelRequest();
    const child = f.start(['run', HEADLESS_PROMPT, ...json]);
    try {
      await Promise.race([gate.entered, child.output.then(output => { throw new Error(`Run exited before its admitted model request: ${output.stdout} ${output.stderr}`); })]);
      expect(f.intakeCalls()).toContain('admit');
      expect(f.model.requests).toHaveLength(1);
      expect(f.journal().records[0]?.dispatch).toBeDefined();
      child.interrupt(signal);
      const output = await child.output;
      expect(output.code, `${signal}: ${Buffer.byteLength(output.stdout)} stdout bytes; ${output.stderr.slice(-1000)}`).toBe(130);
      expect(output.stdout.length, `${signal} must not terminate before final JSON`).toBeGreaterThan(0);
      const final = readEnvelope(output);
      expect(final.ok).toBe(false);
      expect(final.native.result?.kind).toBe('turn');
      expect(output.stdout).not.toContain('turnPermit');
      expect(output.stdout).not.toContain(f.pairedToken);
      expect(f.intakeCalls()).not.toContain('cancel');
      expect(f.home.judgments.unavailableDiagnostics.length).toBeGreaterThan(0);
    } finally { gate.release(); }
  }, 60000);

  test('a shared token or revoked paired principal cannot capture or fall back to an ordinary model', async () => {
    const f = await fixture(product);
    const shared = await f.run(['run', HEADLESS_PROMPT, ...json], f.host.daemon.token);
    expect(shared.code).toBe(1);
    expect(f.captures()).toHaveLength(0);
    const principal = f.host.daemon.services.pairingTokens.authenticateNative(f.pairedToken)!;
    expect(f.host.daemon.services.pairingTokens.revoke(principal.tokenId)).toBe(true);
    const revoked = await f.run(['-p', HEADLESS_PROMPT, ...json]);
    expect(revoked.code).toBe(1);
    expect(f.captures()).toHaveLength(0);
    expect(f.model.requests).toHaveLength(0);
    expect(f.home.judgments.accepted).toHaveLength(0);
    expect(existsSync(f.journalPath)).toBe(false);
  }, 30000);
});
