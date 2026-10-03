import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pumpTestOutput } from '../scripts/owned-test-child.ts';

function outputStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } });
}

// A real asynchronous Writable with backpressure, not a write() stub that can
// claim success before any byte reaches its destination.
test('the test output pump drains backpressure and retains file tracking without ending its sink', async () => {
  const delivered: string[] = [];
  const sink = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    setImmediate(() => { delivered.push(String(chunk)); callback(); });
  } });
  const seen = { lastLine: null as string | null, lastFile: null as string | null };
  await pumpTestOutput(outputStream('::group::test/noisy.test.ts:\n', 'tail\n'), sink, seen);
  expect(delivered).toEqual(['::group::test/noisy.test.ts:\n', 'tail\n']);
  expect(seen).toEqual({ lastLine: 'tail', lastFile: 'test/noisy.test.ts' });
  expect(sink.writableEnded).toBe(false);
  sink.destroy();
});

test('a test output write error rejects rather than reporting drained output', async () => {
  const failure = new Error('fixture output sink failed');
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(failure); } });
  await expect(pumpTestOutput(outputStream('tail\n'), sink, { lastLine: null, lastFile: null })).rejects.toBe(failure);
  expect(sink.destroyed).toBe(true);
  expect(sink.listenerCount('error')).toBe(0);
});

test.each(['failure', 'signal'] as const)('the owned runner preserves both noisy output tails before reporting %s', (outcome) => {
  const root = mkdtempSync(join(tmpdir(), 'gv-runner-output-'));
  try {
    const size = 1024 * 1024;
    writeFileSync(join(root, 'noisy.test.ts'), `
      import { expect, test } from 'bun:test';
      test('fixture noisy outcome', async () => {
        await Bun.write(Bun.stdout, 'O'.repeat(${size}) + '\\nSTDOUT-END\\n');
        await Bun.write(Bun.stderr, 'E'.repeat(${size}) + '\\nSTDERR-END\\n');
        ${outcome === 'failure' ? 'expect(1).toBe(2);' : "process.kill(process.pid, 'SIGTERM'); await Bun.sleep(10_000);"}
      });
    `);
    writeFileSync(join(root, 'runner.ts'), `
      import { runOwnedTestChild } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/owned-test-child.ts'))};
      const result = await runOwnedTestChild({ argv: ['./noisy.test.ts'], cwd: import.meta.dir, env: { ...process.env } });
      throw new Error('OWNED-RESULT: ' + JSON.stringify(result));
    `);
    const run = spawnSync('bun', [join(root, 'runner.ts')], { cwd: root, encoding: 'utf8', maxBuffer: 4 * size });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('O'.repeat(size) + '\nSTDOUT-END\n');
    expect(run.stderr).toContain('E'.repeat(size) + '\nSTDERR-END\n');
    expect(run.stderr).toContain('OWNED-RESULT:');
    expect(run.stderr).toContain('"stopped":null');
    expect(run.stderr).toContain(outcome === 'failure' ? '"exitCode":1' : '"signalCode":"SIGTERM"');
    if (outcome === 'failure') {
      expect(run.stderr).toContain('0 pass');
      expect(run.stderr).toContain('1 fail');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an output sink error stops and reaps the live child before rejecting', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-runner-output-error-'));
  try {
    const pidPath = join(root, 'child.pid');
    writeFileSync(join(root, 'live.test.ts'), `
      import { test } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      test('live child when output fails', async () => {
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        await Bun.write(Bun.stdout, 'OWNED-WRITE-FAIL\\n');
        await Bun.sleep(60_000);
      });
    `);
    writeFileSync(join(root, 'runner.ts'), `
      import { readFileSync } from 'node:fs';
      import { Writable } from 'node:stream';
      import { runOwnedTestChild } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/owned-test-child.ts'))};
      const sink = new Writable({ write(chunk, _encoding, callback) {
        callback(String(chunk).includes('OWNED-WRITE-FAIL') ? new Error('fixture sink failure') : undefined);
      } });
      Object.defineProperty(process, 'stdout', { value: sink });
      try {
        await runOwnedTestChild({ argv: ['./live.test.ts'], cwd: import.meta.dir, env: { ...process.env } });
        throw new Error('the sink error was ignored');
      } catch (error) {
        const pid = Number(readFileSync(${JSON.stringify(pidPath)}, 'utf8'));
        let childGone = false;
        try { process.kill(pid, 0); } catch { childGone = true; }
        process.stderr.write('SINK-RESULT: ' + JSON.stringify({ message: error.message, childGone, listeners: sink.listenerCount('error') }) + '\\n');
      }
    `);
    const run = spawnSync('bun', [join(root, 'runner.ts')], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('SINK-RESULT: {"message":"fixture sink failure","childGone":true,"listeners":0}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test.each(['read', 'write'] as const)('a sink destroyed during a pending %s rejects and releases its reader', async (waiting) => {
  const failure = new Error('fixture destroyed sink');
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) { if (waiting === 'write') controller.enqueue(new TextEncoder().encode('tail')); },
    cancel() { cancelled = true; },
  });
  const sink = new Writable({ write() { setImmediate(() => sink.destroy(failure)); } });
  const pumping = pumpTestOutput(source, sink, { lastLine: null, lastFile: null });
  if (waiting === 'read') setImmediate(() => sink.destroy(failure));
  await expect(pumping).rejects.toBe(failure);
  expect(cancelled).toBe(true);
  expect(source.locked).toBe(false);
  expect(sink.listenerCount('error')).toBe(0);
});


test('a permanently backpressured sink cannot outlive the existing stall ceiling', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-runner-output-stall-'));
  try {
    const pidPath = join(root, 'child.pid');
    writeFileSync(join(root, 'live.test.ts'), `
      import { test } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      test('live child while output is blocked', async () => {
        writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
        await Bun.write(Bun.stdout, 'BLOCKED-OUTPUT\\n');
        await Bun.sleep(60_000);
      });
    `);
    writeFileSync(join(root, 'runner.ts'), `
      import { readFileSync } from 'node:fs';
      import { Writable } from 'node:stream';
      import { runOwnedTestChild } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/owned-test-child.ts'))};
      const sink = new Writable({ write() {} });
      Object.defineProperty(process, 'stdout', { value: sink });
      process.env.GOODVIBES_TEST_STALL_MS = '100';
      const result = await runOwnedTestChild({ argv: ['./live.test.ts'], cwd: import.meta.dir, env: { ...process.env } });
      const pid = Number(readFileSync(${JSON.stringify(pidPath)}, 'utf8'));
      let childGone = false;
      try { process.kill(pid, 0); } catch { childGone = true; }
      process.stderr.write('STALL-RESULT: ' + JSON.stringify({ stopped: result.stopped, childGone, listeners: sink.listenerCount('error') }) + '\\n');
    `);
    const run = spawnSync('bun', [join(root, 'runner.ts')], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('STALL-RESULT: {"stopped":"stalled","childGone":true,"listeners":0}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
