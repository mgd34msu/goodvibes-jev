import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const RUNNER = resolve(import.meta.dir, '../../../scripts/run-tests.ts');

function fixture(files: Readonly<Record<string, string>>): string {
  const root = makeProjectTempDir('runner-lifecycle');
  for (const [name, source] of Object.entries({
    'src/test/preload/temp-cleanup.ts': 'export {};',
    ...files,
  })) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

function run(root: string, args: readonly string[] = [], env: Record<string, string> = {}, entry = RUNNER) {
  return spawnSync(process.execPath, ['--no-env-file', entry, ...args], {
    cwd: root,
    env: { ...process.env, GOODVIBES_TEST_JOBS: '1', GOODVIBES_TEST_FILE_TIMEOUT_MS: '250', ...env },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanup(root: string): void {
  // A broken runner must not make the regression fixture itself leak a child.
  for (const file of readdirSync(root).filter((name) => name.endsWith('.pid'))) {
    const pid = Number(readFileSync(join(root, file), 'utf8'));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
}

describe('the product test runner owns every file through teardown', () => {
  test.each([false, true])('ends a hung module, drains its termination output, and runs the next file (exit zero: %s)', (exitZero) => {
    const root = fixture({
      'src/00-hung.test.ts': `
        import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
        writeFileSync('hung.pid', String(process.pid));
        const extra = process.cwd() + '/owned-extra';
        mkdirSync(extra);
        writeFileSync(process.env.GOODVIBES_TEST_TEMP_MANIFEST!, JSON.stringify([extra]));
        process.on('SIGTERM', () => {
          console.log('HUNG-STDOUT-TERM');
          console.error('HUNG-STDERR-TERM');
          if (existsSync(process.env.TMPDIR!) && existsSync(extra)) console.log('TEARDOWN-SCRATCH-PRESENT');
          ${exitZero ? 'process.exit(0);' : ''}
        });
        console.log('HUNG-STDOUT-START');
        console.error('HUNG-STDERR-START');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      `,
      'src/01-later.test.ts': `
        import { expect, test } from 'bun:test';
        test('later file still runs', () => { console.log('LATER-FILE-RAN'); expect(true).toBe(true); });
      `,
    });
    try {
      const result = run(root);
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain('src/00-hung.test.ts');
      expect(output).toMatch(/ceiling|timed out/i);
      expect(output).toContain('HUNG-STDOUT-START');
      expect(output).toContain('HUNG-STDERR-START');
      expect(output).toContain('HUNG-STDOUT-TERM');
      expect(output).toContain('HUNG-STDERR-TERM');
      expect(output).toContain('TEARDOWN-SCRATCH-PRESENT');
      expect(output).toContain('LATER-FILE-RAN');
      expect(output).toContain('Test files: 2, passed: 1, failed: 1');
      expect(alive(Number(readFileSync(join(root, 'hung.pid'), 'utf8')))).toBe(false);
      expect(existsSync(join(root, 'owned-extra'))).toBe(false);
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally { cleanup(root); }
  }, 20_000);

  test('preserves both full output tails and later success when a file fails', () => {
    const size = 1024 * 1024;
    const root = fixture({
      'src/00-fail.test.ts': `
        import { expect, test } from 'bun:test';
        test('noisy failure', async () => {
          await Bun.write(Bun.stdout, 'O'.repeat(${size}) + '\\nSTDOUT-END\\n');
          await Bun.write(Bun.stderr, 'E'.repeat(${size}) + '\\nSTDERR-END\\n');
          expect(1).toBe(2);
        });
      `,
      'src/01-pass.test.ts': `import { test } from 'bun:test'; test('next', () => console.log('NEXT-PASS'));`,
    });
    try {
      const result = run(root, [], { GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('O'.repeat(size) + '\nSTDOUT-END\n');
      expect(output).toContain('E'.repeat(size) + '\nSTDERR-END\n');
      expect(output).toContain('NEXT-PASS');
      expect(output).toContain('Test files: 2, passed: 1, failed: 1');
    } finally { cleanup(root); }
  }, 20_000);

  test('keeps E2E separate, isolates each file home, and preserves sibling scratch', () => {
    const root = fixture({
      'src/selected-pass.test.ts': `
        import { expect, test } from 'bun:test';
        test('isolated startup environment', () => {
          expect(process.env.OPENAI_API_KEY).toBeUndefined();
          expect(process.env.HOME).not.toBe('INHERITED-HOME');
          expect(process.env.GIT_CEILING_DIRECTORIES).toBe(process.cwd() + '/.test-tmp');
        });
      `,
      'src/not-selected.test.ts': `throw new Error('UNSELECTED-SOURCE-RAN');`,
      'src/test/e2e/selected-pass-e2e.test.ts': `throw new Error('E2E-SOURCE-RAN');`,
    });
    const sibling = join(root, '.test-tmp', 'run-987654321');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'kept'), 'sibling');
    try {
      const result = run(root, ['selected-pass'], {
        HOME: 'INHERITED-HOME', OPENAI_API_KEY: 'fixture-only-not-a-credential', GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000',
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain('Test files: 1, passed: 1, failed: 0');
      expect(existsSync(join(sibling, 'kept'))).toBe(true);
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual(['run-987654321']);
    } finally { cleanup(root); }
  });

  test('fails a successful test that catches a blocked external request', () => {
    const root = fixture({
      'src/network.test.ts': `
        import { expect, test } from 'bun:test';
        test('application catches the shared guard rejection', async () => {
          try { await fetch('https://runner-fixture.invalid/never-sent'); } catch {}
          expect(true).toBe(true);
        });
      `,
    });
    try {
      const result = run(root, [], { GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000' });
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain('1 pass');
      expect(output).toContain('unexpected external test I/O was blocked');
      expect(output).toContain('runner-fixture.invalid');
      expect(output).toContain('Test files: 1, passed: 0, failed: 1');
    } finally { cleanup(root); }
  });

  test('waits for active workers before cleaning their shared run directory', () => {
    const root = fixture({
      'src/00-fail.test.ts': `import { expect, test } from 'bun:test'; test('failure', () => expect(1).toBe(2));`,
      'src/01-slow.test.ts': `
        import { expect, test } from 'bun:test';
        import { existsSync, writeFileSync } from 'node:fs';
        test('scratch still belongs to the active child', async () => {
          const owned = process.env.TMPDIR!;
          await Bun.sleep(400);
          expect(existsSync(owned)).toBe(true);
          writeFileSync(owned + '/late-write', 'done');
          console.log('SLOW-WORKER-FINISHED');
        });
      `,
      'src/02-later.test.ts': `import { test } from 'bun:test'; test('later', () => console.log('LATER-WORKER-FINISHED'));`,
    });
    try {
      const result = run(root, ['--jobs', '2'], { GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('SLOW-WORKER-FINISHED');
      expect(output).toContain('LATER-WORKER-FINISHED');
      expect(output).toContain('Test files: 3, passed: 2, failed: 1');
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally { cleanup(root); }
  });

  test('cancels active children before cleanup and never starts queued files', async () => {
    const root = fixture({
      'src/00-hung.test.ts': `
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => console.error('CANCEL-TERM-TAIL'));
        writeFileSync('hung.pid', String(process.pid));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      `,
      'src/01-queued.test.ts': `import { writeFileSync } from 'node:fs'; writeFileSync('queued-ran', 'unexpected');`,
    });
    const proc = Bun.spawn([process.execPath, '--no-env-file', RUNNER, '--jobs', '1'], {
      cwd: root,
      env: { ...process.env, GOODVIBES_TEST_FILE_TIMEOUT_MS: '30000' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const safety = setTimeout(() => proc.kill('SIGKILL'), 12_000);
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(join(root, 'hung.pid')) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(root, 'hung.pid'))).toBe(true);
      proc.kill('SIGTERM');
      expect(await proc.exited).toBe(1);
      const text = (await output).join('');
      expect(text).toContain('CANCEL-TERM-TAIL');
      expect(text).toContain('interrupted: SIGTERM');
      expect(existsSync(join(root, 'queued-ran'))).toBe(false);
      expect(alive(Number(readFileSync(join(root, 'hung.pid'), 'utf8')))).toBe(false);
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally {
      clearTimeout(safety);
      proc.kill('SIGKILL');
      await proc.exited;
      cleanup(root);
      await output;
    }
  }, 20_000);

  test('a runner-side spawn error still permits its sibling and later files to finish', () => {
    const root = fixture({
      'src/00-spawn-error.test.ts': `throw new Error('the injected spawn error should prevent loading this file');`,
      'src/01-sibling.test.ts': `
        import { test, expect } from 'bun:test';
        import { existsSync } from 'node:fs';
        test('sibling completes', async () => {
          await Bun.sleep(200);
          expect(existsSync(process.env.TMPDIR!)).toBe(true);
          console.log('SIBLING-COMPLETED');
        });
      `,
      'src/02-later.test.ts': `import { test } from 'bun:test'; test('later', () => console.log('LATER-COMPLETED'));`,
    });
    const entry = join(root, 'inject-spawn-error.ts');
    writeFileSync(entry, `
      const spawn = Bun.spawn.bind(Bun);
      Reflect.set(Bun, 'spawn', (cmd, options) => {
        if (Array.isArray(cmd) && cmd.some(arg => String(arg).endsWith('/00-spawn-error.test.ts'))) throw new Error('fixture spawn failed');
        return spawn(cmd, options);
      });
      await import(${JSON.stringify(RUNNER)});
    `);
    try {
      const result = run(root, ['--jobs', '2'], { GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000' }, entry);
      const output = result.stdout + result.stderr;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toContain('fixture spawn failed');
      expect(output).toContain('SIBLING-COMPLETED');
      expect(output).toContain('LATER-COMPLETED');
      expect(output).toContain('Test files: 3, passed: 2, failed: 1');
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally { cleanup(root); }
  });

  test('parent death ends the whole queue instead of adopting a new parent per file', async () => {
    const root = fixture({
      'src/00-hung.test.ts': `
        import { writeFileSync } from 'node:fs';
        process.on('SIGTERM', () => { console.error('PARENT-DEATH-TAIL'); process.exit(0); });
        writeFileSync('hung.pid', String(process.pid));
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      `,
      'src/01-queued.test.ts': `import { writeFileSync } from 'node:fs'; writeFileSync('queued-ran', 'unexpected');`,
    });
    const launcher = join(root, 'launcher.ts');
    writeFileSync(launcher, `
      import { writeFileSync } from 'node:fs';
      const child = Bun.spawn([process.execPath, '--no-env-file', ${JSON.stringify(RUNNER)}, '--jobs', '1'], {
        cwd: process.cwd(), env: { ...process.env, GOODVIBES_TEST_FILE_TIMEOUT_MS: '30000' }, stdout: 'inherit', stderr: 'inherit',
      });
      writeFileSync('runner.pid', String(child.pid));
      await child.exited;
    `);
    const proc = Bun.spawn([process.execPath, '--no-env-file', launcher], { cwd: root, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    let safetyExpired = false;
    const safety = setTimeout(() => { safetyExpired = true; cleanup(root); proc.kill('SIGKILL'); }, 12_000);
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(join(root, 'hung.pid')) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(join(root, 'hung.pid'))).toBe(true);
      proc.kill('SIGKILL');
      await proc.exited;
      const text = (await output).join('');
      expect(safetyExpired).toBe(false);
      expect(text).toContain('PARENT-DEATH-TAIL');
      expect(text).toContain('interrupted: parent-died');
      expect(existsSync(join(root, 'queued-ran'))).toBe(false);
      expect(alive(Number(readFileSync(join(root, 'hung.pid'), 'utf8')))).toBe(false);
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally {
      clearTimeout(safety);
      proc.kill('SIGKILL');
      await proc.exited;
      if (existsSync(root)) cleanup(root);
      await output;
    }
  }, 20_000);

  test.each(['failed', 'blocked'] as const)('a %s output sink cannot remove an active sibling child’s scratch', (mode) => {
    const root = fixture({
      'src/00-fail.test.ts': `import { test } from 'bun:test'; test('first', () => {});`,
      'src/01-sibling.test.ts': `
        import { test, expect } from 'bun:test';
        import { existsSync, writeFileSync } from 'node:fs';
        writeFileSync('sibling.pid', String(process.pid));
        test('sibling completes after the reporter fails', async () => {
          await Bun.sleep(500);
          expect(existsSync(process.env.TMPDIR!)).toBe(true);
          writeFileSync('sibling-finished', 'scratch survived');
        });
      `,
    });
    const entry = join(root, 'inject-output-error.ts');
    writeFileSync(entry, `
      import { Writable } from 'node:stream';
      const sink = new Writable({ write(chunk, _encoding, callback) {
        if (String(chunk).includes('00-fail.test.ts')) {
          ${mode === 'failed' ? "callback(new Error('fixture report sink failed'));" : ''}
        } else callback();
      } });
      Object.defineProperty(process, 'stdout', { value: sink });
      await import(${JSON.stringify(RUNNER)});
    `);
    try {
      const result = run(root, ['--jobs', '2'], { GOODVIBES_TEST_FILE_TIMEOUT_MS: '5000' }, entry);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(mode === 'failed' ? 'fixture report sink failed' : 'output did not drain within 5000ms');
      expect(existsSync(join(root, 'sibling-finished'))).toBe(true);
      expect(alive(Number(readFileSync(join(root, 'sibling.pid'), 'utf8')))).toBe(false);
      expect(readdirSync(join(root, '.test-tmp')).filter((name) => name.startsWith('run-'))).toEqual([]);
    } finally { cleanup(root); }
  }, 20_000);
});
