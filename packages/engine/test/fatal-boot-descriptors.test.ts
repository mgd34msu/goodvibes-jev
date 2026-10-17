/** Descriptor assertions from pinned daemon aa1d96a5117deafee31e4849c5bbd43a3e0d04c1.
 * Reconstructed after executor replacement; see the bounded source-proof audit.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from '../sdk/src/platform/daemon/index.js';
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function runInlineWriter(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-fatal-inline-'));
  dirs.push(dir);
  const modulePath = new URL('../sdk/src/platform/daemon/fatal-boot-report.ts', import.meta.url).pathname;
  const script = join(dir, 'inline.ts');
  writeFileSync(script,
    `import { reportFatalBootFailure, writeExitingStdoutLine, writeFatalLine } from ${JSON.stringify(modulePath)};\n${body}\n`);
  const result = spawnSync(process.execPath, ['run', script], {
    cwd: import.meta.dir, encoding: 'utf8', timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('fatal diagnostics reach actual descriptors', () => {
  test('fd 2 bypasses a replaced stderr.write', () => {
    const run = runInlineWriter(`const captured = [];
      process.stderr.write = ((chunk) => { captured.push(String(chunk)); return true; });
      writeFatalLine('daemon refused to start: settings unreadable');
      process.stdout.write('CAPTURED=' + captured.length + '\\n');`);
    expect(run.stdout).toBe('CAPTURED=0\n');
    expect(run.stderr).toBe('daemon refused to start: settings unreadable\n');
  });
  test('a line already ending in newline gets no extra newline', () => {
    const run = runInlineWriter(`writeFatalLine('one\\n'); writeFatalLine('two');`);
    expect(run.stderr).toBe('one\ntwo\n');
    expect(run.stdout).toBe('');
  });
  test('fd 1 output survives immediate exit', () => {
    const run = runInlineWriter(`writeExitingStdoutLine('service unit installed'); process.exit(0);`);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('service unit installed\n');
    expect(run.stderr).toBe('');
  });
  test('default context and reason remain readable while an unclassified stack is withheld', () => {
    const run = runInlineWriter(`reportFatalBootFailure(new Error('settings.json could not be read'));`);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('goodvibes daemon host failed: settings.json could not be read\n[REDACTED]\n');
    expect(run.stdout).toBe('');
  });
  test('custom context replaces default label', () => {
    const run = runInlineWriter(`reportFatalBootFailure(new Error('boom'), 'goodvibes service install');`);
    expect(run.stderr).toBe('[REDACTED] failed: boom\n[REDACTED]\n');
    expect(run.stderr).toContain('boom');
  });
  test('non-Error reason is disclosed without invented stack', () => {
    const run = runInlineWriter(`reportFatalBootFailure('just a string');`);
    expect(run.stderr).toBe('goodvibes daemon host failed: just a string\n');
    expect(run.stderr).not.toContain('at ');
  });
  test('closed descriptor does not turn diagnostic into second failure', () => {
    const run = runInlineWriter(`import { closeSync } from 'node:fs';
      closeSync(2); writeFatalLine('nobody can hear this'); process.stdout.write('SURVIVED\\n');`);
    expect(run.stdout).toContain('SURVIVED');
    expect(run.status).toBe(0);
  });
  test('canonical SDK exports all three writer functions', () => {
    expect(typeof writeFatalLine).toBe('function');
    expect(typeof writeExitingStdoutLine).toBe('function');
    expect(typeof reportFatalBootFailure).toBe('function');
  });

  test.each(['Authorization: Bearer synthetic-private-token', 'card 4111 1111 1111 1111'])('withholds an own private stack containing %s without changing Error or cause', (privateText) => {
    const run = runInlineWriter(`
      const cause = new Error('synthetic private cause');
      const error = new Error('boot refused', { cause });
      const stack = ${JSON.stringify(`Error: ${privateText}\n    at privateFixture`)};
      Object.defineProperty(error, 'stack', { value: stack, configurable: true, writable: true });
      reportFatalBootFailure(error, ${JSON.stringify(privateText)});
      if (error.cause !== cause || Object.getOwnPropertyDescriptor(error, 'stack')?.value !== stack) throw new Error('native identity changed');
      process.stdout.write('IDENTITY_PRESERVED\\n');
    `);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('IDENTITY_PRESERVED\n');
    expect(run.stderr).toContain('failed: boot refused');
    expect(run.stdout + run.stderr).not.toContain(privateText);
    expect(run.stdout + run.stderr).not.toContain('synthetic-private-token');
    expect(run.stdout + run.stderr).not.toContain('4111 1111 1111 1111');
    expect(run.stdout + run.stderr).not.toContain('privateFixture');
  });

  test('does not invoke a custom stack accessor on the fatal descriptor path', () => {
    const run = runInlineWriter(`
      const error = new Error('boot refused');
      let reads = 0;
      Object.defineProperty(error, 'stack', { get() { reads++; throw new Error('private accessor material'); } });
      reportFatalBootFailure(error);
      process.stdout.write('STACK_READS=' + reads + '\\n');
    `);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('STACK_READS=0\n');
    expect(run.stderr).toBe('goodvibes daemon host failed: boot refused\n');
    expect(run.stdout + run.stderr).not.toContain('private accessor material');
  });

  test('prints the complete ordinary own stack after its current canonical reading settles', () => {
    const redaction = new URL('../sdk/src/platform/utils/redaction.ts', import.meta.url).pathname;
    const errors = new URL('../errors/src/index.ts', import.meta.url).pathname;
    const testing = new URL('../../judgment/src/testing/index.ts', import.meta.url).pathname;
    const stack = 'ordinary fixture failure\n    at fixtureBootstrap';
    const context = 'goodvibes service install';
    const run = runInlineWriter(`
      import { redactSensitiveDataAsync } from ${JSON.stringify(redaction)};
      import { installJudgmentPort } from ${JSON.stringify(errors)};
      import { fakePort, noulAnswer } from ${JSON.stringify(testing)};
      const admitted = new Set(${JSON.stringify([context, ...stack.split('\n')])}.map(text => JSON.stringify({ phase: 'source', parts: [{ kind: 'text', text }], target: 'whole-line' })));
      const fixture = fakePort((name, question, state) => {
        if ((name !== 'lineHasCredential' && name !== 'spanIsCredential') || !admitted.has(JSON.stringify(state))) throw new Error('Unscripted public stack fixture');
        return noulAnswer(0.01);
      });
      installJudgmentPort(fixture.port);
      const stack = ${JSON.stringify(stack)};
      const context = ${JSON.stringify(context)};
      await Promise.all([redactSensitiveDataAsync(stack), redactSensitiveDataAsync(context), redactSensitiveDataAsync('ordinary fixture failure')]);
      const error = new Error('ordinary fixture failure');
      Object.defineProperty(error, 'stack', { value: stack });
      reportFatalBootFailure(error, context);
    `);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe(`${context} failed: ordinary fixture failure\n${stack}\n`);
  });
});
