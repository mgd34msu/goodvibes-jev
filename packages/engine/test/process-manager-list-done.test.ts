/** Completion is an owned lifecycle fact, independent of display status text. */
import { expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { waitFor } from './_helpers/test-timeout.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

function expectListedDone(manager: ProcessManager, id: string, done: boolean): void {
  const listed = manager.list().find((row) => row.id === id);
  expect(listed).toBeDefined();
  expect(listed!.done).toBe(done);
  const command = manager.handleCommand('bg_list');
  expect(command).toMatchObject({ success: true, exit_code: 0, stderr: '' });
  const serialized = JSON.parse(command!.stdout) as ReturnType<ProcessManager['list']>;
  expect(serialized.find((row) => row.id === id)).toEqual(listed);
}

for (const exitCode of [0, 7]) {
  test(`live process lists false, then true after normal exit ${exitCode} and output collection`, async () => {
    const directory = makeProjectTempDir('process-list-done');
    const releaseFile = join(directory, 'release');
    const manager = new ProcessManager();
    const code = `const fs = require('node:fs'); console.log('ready'); const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
      clearInterval(timer); console.log('final stdout'); console.error('final stderr'); process.exitCode = ${exitCode};
    }, 10);`;
    try {
      const child = await manager.spawnArgv(process.execPath, ['--no-env-file', '-e', code], directory, undefined,
        { timeout_ms: 12_000, sigterm_grace_ms: 20 });
      const id = child.process_id!;
      await waitFor(() => manager.getOutput(id)?.stdout.includes('ready') === true);
      expectListedDone(manager, id, false);
      writeFileSync(releaseFile, 'release');
      await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
      expectListedDone(manager, id, true);
      expect(manager.getStatus(id)).toMatchObject({ exitCode, done: true });
      expect(manager.getOutput(id)).toMatchObject({ stdout: 'ready\nfinal stdout\n', stderr: 'final stderr\n' });
    } finally { await manager.close(); }
  });
}

test('a timed-out process lists true after termination without reading its display status', async () => {
  const manager = new ProcessManager();
  try {
    const child = await manager.spawnArgv(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000);'], '/tmp', undefined,
      { timeout_ms: 100, sigterm_grace_ms: 20 });
    const id = child.process_id!;
    expectListedDone(manager, id, false);
    await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
    expectListedDone(manager, id, true);
    expect(manager.getStatus(id)).toMatchObject({ done: true, timedOut: true });
  } finally { await manager.close(); }
});

test('an expired timeout does not report completion when the process is allowed to continue', async () => {
  const manager = new ProcessManager();
  try {
    const child = await manager.spawnArgv(process.execPath, ['--no-env-file', '-e', 'setInterval(() => {}, 1000);'], '/tmp', undefined,
      { timeout_ms: 100, sigterm_grace_ms: 20, kill_on_timeout: false, kill_on_close: true });
    const id = child.process_id!;
    await waitFor(() => manager.getStatus(id)?.timedOut === true);
    expectListedDone(manager, id, false);
    await manager.close();
    expectListedDone(manager, id, true);
  } finally { await manager.close(); }
});

test('an exited handle lists false until both output streams have drained', async () => {
  const manager = new ProcessManager();
  let finish!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => { finish = resolve; });
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  const output = new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } });
  const errors = new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } });
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({
    pid: 1234, exited, stdout: output, stderr: errors,
  }) as unknown as ReturnType<typeof Bun.spawn>);
  try {
    // This intercepted, externally owned handle never signals a real PID.
    const child = await manager.spawnArgv('fixture', [], '/tmp', undefined, { kill_on_timeout: false });
    const id = child.process_id!;
    finish(0);
    await Promise.resolve();
    expectListedDone(manager, id, false);
    stdout.enqueue(new TextEncoder().encode('final stdout'));
    stdout.close();
    await Promise.resolve();
    expectListedDone(manager, id, false);
    stderr.enqueue(new TextEncoder().encode('final stderr'));
    stderr.close();
    await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
    expectListedDone(manager, id, true);
    expect(manager.getOutput(id)).toEqual({ stdout: 'final stdout', stderr: 'final stderr' });
  } finally {
    finish(0);
    // A failed assertion must still release this fixture's readers.
    try { stdout.close(); } catch { /* already closed */ }
    try { stderr.close(); } catch { /* already closed */ }
    spawn.mockRestore();
    await manager.close();
  }
});

if (process.platform !== 'win32') {
  test('a signal-terminated process lists true without a successful exit', async () => {
    const directory = makeProjectTempDir('process-list-signal');
    const releaseFile = join(directory, 'release');
    const manager = new ProcessManager();
    const code = `const fs = require('node:fs'); console.log('ready'); setInterval(() => {
      if (fs.existsSync(${JSON.stringify(releaseFile)})) process.kill(process.pid, 'SIGTERM');
    }, 10);`;
    try {
      const child = await manager.spawnArgv(process.execPath, ['--no-env-file', '-e', code], directory, undefined,
        { timeout_ms: 12_000, sigterm_grace_ms: 20 });
      const id = child.process_id!;
      await waitFor(() => manager.getOutput(id)?.stdout.includes('ready') === true);
      expectListedDone(manager, id, false);
      writeFileSync(releaseFile, 'release');
      await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
      expectListedDone(manager, id, true);
      expect(manager.getStatus(id)).toMatchObject({ done: true, signal: 'SIGTERM' });
      expect(manager.getStatus(id)?.timedOut ?? false).toBe(false);
    } finally { await manager.close(); }
  });

  test('an exited leader still lists false until its owned descendant and inherited output settle', async () => {
    const directory = makeProjectTempDir('process-list-group-drain');
    const readyFile = join(directory, 'ready');
    const releaseFile = join(directory, 'release');
    const manager = new ProcessManager();
    const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
    // The leader exits only after its descendant installs a TERM handler. It
    // acknowledges group cleanup but stays alive until this test releases it.
    const code = `const fs = require('node:fs');
      process.on('SIGTERM', () => { console.log('draining'); });
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
        clearInterval(timer); console.log('final descendant output'); console.error('final descendant error');
      }, 10);`;
    try {
      const child = await manager.spawn(`${quote(process.execPath)} --no-env-file -e ${quote(code)} & while [ ! -f ${quote(readyFile)} ]; do /bin/sleep 0.01; done; exit 0`,
        directory, undefined, { timeout_ms: 12_000, sigterm_grace_ms: 5_000 });
      const id = child.process_id!;
      await waitFor(() => manager.getOutput(id)?.stdout.includes('draining') === true);
      expect(manager.getStatus(id)?.killDeadline).not.toBeNull();
      expectListedDone(manager, id, false);
      writeFileSync(releaseFile, 'release');
      await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
      expectListedDone(manager, id, true);
      expect(manager.getStatus(id)).toMatchObject({ exitCode: 0, done: true });
      expect(manager.getOutput(id)?.stdout).toContain('final descendant output\n');
      expect(manager.getOutput(id)?.stderr).toBe('final descendant error\n');
    } finally {
      writeFileSync(releaseFile, 'release');
      await manager.close();
    }
  }, 15_000);
}
