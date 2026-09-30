import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../sdk/src/platform/runtime/remote/host/backends/process-runner.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const code = (source: string) => [process.execPath, '--no-env-file', '-e', source];
afterEach(() => {
  (Bun.spawn as unknown as { mockRestore?: () => void }).mockRestore?.();
});

function emptyStream() {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
}

function installChild(options: { blockedInput?: boolean; inputError?: boolean; streamError?: boolean }) {
  let kills = 0;
  let finish!: (exit: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  const child = {
    stdout: options.streamError
      ? new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('fixture output failed')); } })
      : emptyStream(),
    stderr: emptyStream(),
    stdin: {
      write: () => { if (options.inputError) throw new Error('fixture stdin failed'); },
      end: () => options.blockedInput ? new Promise<void>(() => {}) : undefined,
    },
    exited,
    kill: () => { kills += 1; finish(137); },
  };
  spyOn(Bun, 'spawn').mockImplementation((() => child) as unknown as typeof Bun.spawn);
  return { get kills() { return kills; }, finish };
}

describe('remote process runner preserved behavior', () => {
  test('captures stdout, stderr, environment and nonzero status', async () => {
    const result = await runProcess({
      args: code("process.stdout.write(process.env.GV_FIXTURE_VALUE); process.stderr.write('fixture err'); process.exit(3)"),
      env: { GV_FIXTURE_VALUE: 'fixture output' }, timeoutMs: 3000,
    });
    expect(result).toEqual({ stdout: 'fixture output', stderr: 'fixture err', exitCode: 3, timedOut: false });
  });

  test('pipes stdin while draining stdout', async () => {
    const input = 'fixture '.repeat(256);
    const result = await runProcess({
      args: code("process.stdin.pipe(process.stdout)"), stdin: input, timeoutMs: 3000,
    });
    expect(result.stdout).toBe(input);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test('reaps a direct child at the deadline', async () => {
    const started = Date.now();
    const result = await runProcess({ args: code('setTimeout(() => {}, 10000)'), timeoutMs: 80 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('rejects an empty executable list and a spawn failure', async () => {
    await expect(runProcess({ args: [], timeoutMs: 1000 })).rejects.toThrow('at least one argument');
    await expect(runProcess({ args: ['/fixture/command-that-does-not-exist'], timeoutMs: 1000 })).rejects.toThrow();
  });
});

describe('remote process deadline and failure ownership', () => {
  test('deadline starts before a blocked stdin.end', async () => {
    const child = installChild({ blockedInput: true });
    const started = Date.now();
    const result = await runProcess({ args: ['fixture'], stdin: 'fixture', timeoutMs: 40 });
    expect(result.timedOut).toBe(true);
    expect(child.kills).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  test('stdin failure kills and reaps the owned child', async () => {
    const child = installChild({ inputError: true });
    try {
      await expect(runProcess({ args: ['fixture'], stdin: 'fixture', timeoutMs: 40 })).rejects.toThrow('fixture stdin failed');
      expect(child.kills).toBe(1);
    } finally { child.finish(137); }
  });

  test('output stream failure kills and reaps the owned child', async () => {
    const child = installChild({ streamError: true });
    try {
      await expect(runProcess({ args: ['fixture'], timeoutMs: 40 })).rejects.toThrow('fixture output failed');
      expect(child.kills).toBe(1);
    } finally { child.finish(137); }
  });

  for (const exitEarly of [false, true]) {
    test.skipIf(process.platform === 'win32')(`deadline closes inherited pipes with parent already exited = ${exitEarly}`, async () => {
      const directory = makeProjectTempDir('remote-process-group');
      const marker = join(directory, 'grandchild-ran');
      const pidFile = join(directory, 'grandchild.pid');
      const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected'); }, 2000)`;
      const parent = `process.on('SIGTERM', () => {}); Bun.spawn([process.execPath, '--no-env-file', '-e', ${JSON.stringify(descendant)}], {stdout: 'inherit', stderr: 'inherit'}); ${exitEarly ? 'process.exit(0)' : 'setTimeout(() => {}, 10000)'}`;
      const started = Date.now();
      let descendantPid: number | undefined;
      try {
        const result = await runProcess({ args: code(parent), timeoutMs: 1000 });
        expect(result.timedOut).toBe(true);
        expect(Date.now() - started).toBeLessThan(1800);
        expect(existsSync(pidFile)).toBe(true);
        descendantPid = Number(readFileSync(pidFile, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 2100));
        expect(existsSync(marker)).toBe(false);
      } finally {
        // Keep the regression itself safe when run against the old implementation.
        if (!descendantPid && existsSync(pidFile)) descendantPid = Number(readFileSync(pidFile, 'utf8'));
        if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} }
      }
    }, 7000);
  }
});
