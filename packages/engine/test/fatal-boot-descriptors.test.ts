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
  test('default context, reason and actual stack are disclosed', () => {
    const run = runInlineWriter(`reportFatalBootFailure(new Error('settings.json could not be read'));`);
    expect(run.stderr).toContain('goodvibes daemon host failed: settings.json could not be read');
    expect(run.stderr).toContain('Error: settings.json could not be read');
    expect(run.stderr).toContain('at ');
  });
  test('custom context replaces default label', () => {
    const run = runInlineWriter(`reportFatalBootFailure(new Error('boom'), 'goodvibes service install');`);
    expect(run.stderr).toContain('goodvibes service install failed: boom');
  });
  test('non-Error reason is disclosed without invented stack', () => {
    const run = runInlineWriter(`reportFatalBootFailure('just a string');`);
    expect(run.stderr).toContain('just a string');
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
});
