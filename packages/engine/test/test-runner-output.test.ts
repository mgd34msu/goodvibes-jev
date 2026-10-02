import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pumpTestOutput, runOwnedTestChild } from '../scripts/owned-test-child.ts';

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


function captureOutput(): { sink: Writable; text: () => string } {
  const chunks: string[] = [];
  return { sink: new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } }), text: () => chunks.join('') };
}

function ownedFixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-owned-options-'));
  writeFileSync(join(root, 'fixture.test.ts'), source);
  return root;
}

test('per-call sinks and ceilings remain independent and preserve SIGTERM handler output', async () => {
  const roots = ['first', 'second'].map((label) => ownedFixture(`
    import { test } from 'bun:test';
    process.on('SIGTERM', async () => {
      await Bun.write(Bun.stdout, '${label}-shutdown-out\\n');
      await Bun.write(Bun.stderr, '${label}-shutdown-err\\n');
      process.exit(0);
    });
    await new Promise(() => {});
    test('unreachable', () => {});
  `));
  const captures = roots.map(() => ({ stdout: captureOutput(), stderr: captureOutput() }));
  const began = Date.now();
  try {
    const runs = await Promise.all(roots.map(async (cwd, i) => ({
      result: await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd, env: { ...process.env },
        ceilingMs: i === 0 ? 100 : 2100, killGraceMs: 500, outputDrainGraceMs: 500,
        stdout: captures[i]!.stdout.sink, stderr: captures[i]!.stderr.sink }),
      elapsed: Date.now() - began,
    })));
    expect(runs[0]!.elapsed).toBeLessThan(runs[1]!.elapsed);
    for (const [i, label] of ['first', 'second'].entries()) {
      expect(runs[i]!.result.stopped).toBe('ceiling');
      expect(runs[i]!.result.exitCode).toBe(0);
      expect(runs[i]!.result.outputTruncated).toBe(false);
      expect(captures[i]!.stdout.text()).toContain(`${label}-shutdown-out`);
      expect(captures[i]!.stderr.text()).toContain(`${label}-shutdown-err`);
      expect(captures[i]!.stderr.text()).toContain('past its ceiling');
      expect(captures[i]!.stdout.sink.writableEnded).toBe(false);
      expect(captures[i]!.stderr.sink.listenerCount('error')).toBe(0);
    }
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test('per-call kill grace reaps a child that refuses SIGTERM', async () => {
  const root = ownedFixture("import { test } from 'bun:test'; process.on('SIGTERM', () => {}); await new Promise(() => {}); test('unreachable', () => {});");
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      ceilingMs: 100, killGraceMs: 100, outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    expect(result.stopped).toBe('ceiling');
    expect(result.signalCode).toBe('SIGKILL');
    expect(result.outputTruncated).toBe(false);
    expect(stderr.text()).toContain('did not exit 100ms after SIGTERM');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an inherited descendant pipe is bounded and reports truncation after a zero-exit child', async () => {
  const root = ownedFixture(`
    import { test } from 'bun:test';
    import { writeFileSync } from 'node:fs';
    test('leave an inherited pipe open', () => {
      const descendant = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' });
      writeFileSync('descendant.pid', String(descendant.pid));
      descendant.unref();
    });
  `);
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    expect(result.stopped).toBe('output-drain');
    expect(result.exitCode).toBe(1);
    expect(result.outputTruncated).toBe(true);
    expect(result.stopReason).toContain('truncated');
    expect(result.stopReason).toContain('100ms after child exit');
  } finally {
    try { process.kill(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* fixture already gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a per-call ceiling cannot disable or extend an enabled enclosing ceiling', async () => {
  const root = ownedFixture("import { test } from 'bun:test'; await new Promise(() => {}); test('unreachable', () => {});");
  const saved = process.env.GOODVIBES_TEST_CEILING_MS;
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    await expect(runOwnedTestChild({ argv: [], cwd: root, env: {}, ceilingMs: 0 })).rejects.toThrow('ceilingMs must be a positive integer');
    process.env.GOODVIBES_TEST_CEILING_MS = '100';
    const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      ceilingMs: 60_000, killGraceMs: 100, outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    expect(result.stopped).toBe('ceiling');
    expect(stderr.text()).toContain('past its ceiling of 0s');
  } finally {
    if (saved === undefined) delete process.env.GOODVIBES_TEST_CEILING_MS; else process.env.GOODVIBES_TEST_CEILING_MS = saved;
    rmSync(root, { recursive: true, force: true });
  }
});


function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return process.platform !== 'linux' || !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch { return false; }
}

test.each(['leader-exit', 'timeout'] as const)('opt-in owned group stops a surviving descendant on %s', async (mode) => {
  const root = ownedFixture(`
    import { test } from 'bun:test';
    import { writeFileSync, existsSync } from 'node:fs';
    test('spawn an owned descendant', async () => {
      const descendant = Bun.spawn(['bun', '-e', "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('descendant.ready', 'ready'); setInterval(() => {}, 1000);"], { stdout: 'ignore', stderr: 'ignore' });
      writeFileSync('descendant.pid', String(descendant.pid));
      while (!existsSync('descendant.ready')) await Bun.sleep(10);
      descendant.unref();
      ${mode === 'timeout' ? 'await Bun.sleep(60_000);' : ''}
    });
  `);
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      ownProcessGroup: true, ceilingMs: mode === 'timeout' ? 100 : 10_000,
      killGraceMs: 100, outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    await Bun.sleep(25);
    expect(pidIsRunning(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')))).toBe(false);
    expect(result.stopped).toBe(mode === 'timeout' ? 'ceiling' : null);
    expect(result.outputTruncated).toBe(false);
  } finally {
    try { process.kill(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* fixture gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('owned descendants with ignored stdio retain their termination grace after leader exit', async () => {
  const root = ownedFixture(`
    import { test } from 'bun:test';
    import { writeFileSync, existsSync } from 'node:fs';
    test('spawn a descendant with graceful cleanup', async () => {
      const descendant = Bun.spawn(['bun', '-e', "const fs = require('node:fs'); process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync('descendant.cleaned', 'clean'); process.exit(0); }, 40)); fs.writeFileSync('descendant.ready', 'ready'); setInterval(() => {}, 1000);"], { stdout: 'ignore', stderr: 'ignore' });
      writeFileSync('descendant.pid', String(descendant.pid));
      while (!existsSync('descendant.ready')) await Bun.sleep(10);
      descendant.unref();
    });
  `);
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      ownProcessGroup: true, killGraceMs: 250, outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    expect(existsSync(join(root, 'descendant.cleaned'))).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(false);
  } finally {
    try { process.kill(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* fixture gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawn failure removes its heartbeat and isolated home tree', async () => {
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-test-heartbeat-')).sort();
  await expect(runOwnedTestChild({ argv: [], cwd: tmpdir(), env: { PATH: '/not-a-real-executable-search-path' } })).rejects.toThrow();
  expect(readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-test-heartbeat-')).sort()).toEqual(before);
});

test('original parent ownership and explicit stall limits survive per-call options', async () => {
  const root = ownedFixture("import { test } from 'bun:test'; await new Promise(() => {}); test('unreachable', () => {});");
  const saved = process.env.GOODVIBES_TEST_STALL_MS;
  const stdout = captureOutput(); const stderr = captureOutput();
  try {
    const originalParent = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      expectedParentPid: process.ppid + 100_000, ceilingMs: 10_000, killGraceMs: 100, outputDrainGraceMs: 100,
      stdout: stdout.sink, stderr: stderr.sink });
    expect(originalParent.stopped).toBe('parent-died');
    process.env.GOODVIBES_TEST_STALL_MS = '100';
    const stalled = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
      stallMs: 60_000, ceilingMs: 10_000, killGraceMs: 100, outputDrainGraceMs: 100, stdout: stdout.sink, stderr: stderr.sink });
    expect(stalled.stopped).toBe('stalled');
    expect(stalled.stopReason).toContain('GOODVIBES_TEST_STALL_MS');
  } finally {
    if (saved === undefined) delete process.env.GOODVIBES_TEST_STALL_MS; else process.env.GOODVIBES_TEST_STALL_MS = saved;
    rmSync(root, { recursive: true, force: true });
  }
});


test.each(['timeout', 'error'] as const)('final network-violation diagnostic handles %s after child output is drained', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'gv-owned-final-diagnostic-review-'));
  const pidPath = join(root, 'child.pid');
  writeFileSync(join(root, 'fixture.test.ts'), `
    import { test } from 'bun:test';
    import { writeFileSync } from 'node:fs';
    test('record fixture violation without real network I/O', () => {
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      writeFileSync(process.env.GOODVIBES_TEST_NETWORK_VIOLATIONS, 'fixture network violation\\n');
    });
  `);
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const failure = new Error('final diagnostic sink failure');
  let diagnosticSeen = false;
  const stderr = new Writable({ write(chunk, _encoding, callback) {
    if (String(chunk).includes('goodvibes: unexpected external test I/O')) {
      diagnosticSeen = true;
      if (mode === 'error') callback(failure);
      return;
    }
    callback();
  } });
  try {
    let result: Awaited<ReturnType<typeof runOwnedTestChild>> | undefined; let caught: unknown;
    try {
      result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: root, env: { ...process.env },
        killGraceMs: 200, outputDrainGraceMs: 100, stdout, stderr });
    } catch (error) { caught = error; }
    console.log('FINAL-DIAGNOSTIC-' + mode.toUpperCase() + ':', JSON.stringify({ result,
      error: caught instanceof Error ? caught.message : caught, diagnosticSeen, childGone: !pidIsRunning(Number(readFileSync(pidPath, 'utf8'))) }));
    expect(diagnosticSeen).toBe(true);
    expect(!pidIsRunning(Number(readFileSync(pidPath, 'utf8')))).toBe(true);
    if (mode === 'error') expect(caught).toBe(failure);
    else {
      expect(caught).toBeUndefined();
      expect(result?.stopped).toBe('output-drain');
      expect(result?.outputTruncated).toBe(true);
      expect(result?.stopReason).toContain('truncated');
      expect(result?.exitCode).toBe(1);
    }
    expect(stderr.listenerCount('error')).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('a real cancellation signal escalates and stops the owned descendant group', () => {
  const root = ownedFixture(`
    import { test } from 'bun:test';
    import { writeFileSync, existsSync } from 'node:fs';
    process.on('SIGTERM', () => {});
    test('live descendant during cancellation', async () => {
      const descendant = Bun.spawn(['bun', '-e', "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('descendant.ready', 'ready'); setInterval(() => {}, 1000);"], { stdout: 'ignore', stderr: 'ignore' });
      writeFileSync('descendant.pid', String(descendant.pid));
      while (!existsSync('descendant.ready')) await Bun.sleep(10);
      await Bun.sleep(60_000);
    });
  `);
  try {
    writeFileSync(join(root, 'runner.ts'), `
      import { existsSync } from 'node:fs';
      import { runOwnedTestChild } from ${JSON.stringify(resolve(import.meta.dir, '../scripts/owned-test-child.ts'))};
      const cancel = setInterval(() => {
        if (existsSync('descendant.ready')) { clearInterval(cancel); process.kill(process.pid, 'SIGTERM'); }
      }, 10);
      const result = await runOwnedTestChild({ argv: ['./fixture.test.ts'], cwd: import.meta.dir, env: { ...process.env },
        ownProcessGroup: true, killGraceMs: 100, outputDrainGraceMs: 100 });
      process.stderr.write('CANCEL-RESULT:' + JSON.stringify(result) + '\\n');
    `);
    const run = spawnSync('bun', [join(root, 'runner.ts')], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('"stopped":"interrupted"');
    expect(run.stderr).toContain('"signalCode":"SIGKILL"');
    expect(run.stderr).toContain('"outputTruncated":false');
    expect(pidIsRunning(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')))).toBe(false);
  } finally {
    try { process.kill(Number(readFileSync(join(root, 'descendant.pid'), 'utf8')), 'SIGKILL'); } catch { /* fixture gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});
