import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { createServiceCommandRunner, observeServiceCommand } from '../sdk/src/platform/daemon/service-handover.ts';

describe('observed service command runner (synthetic children only)', () => {
  function fake() {
    const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
    const kills: string[] = [];
    child.kill = (signal) => { kills.push(signal); return true; };
    const runner = createServiceCommandRunner((() => child) as unknown as typeof spawn);
    return { child, kills, runner };
  }
  test('asynchronous spawn error is owned and failed', async () => {
    const { runner, child } = fake();
    const outcome = runner(['synthetic'], new AbortController().signal);
    child.emit('error', new Error('ENOENT'));
    child.emit('close', -2, null);
    expect(await outcome).toEqual({ status: 'failed', detail: 'ENOENT' });
  });
  test('synchronous spawn throw including undefined is failed', async () => {
    for (const error of [new Error('spawn rejected'), undefined]) {
      const runner = createServiceCommandRunner((() => { throw error; }) as typeof spawn);
      expect((await runner(['synthetic'], new AbortController().signal)).status).toBe('failed');
    }
  });
  for (const code of [0, 1, null]) {
    test(`completion ${String(code)} is observed`, async () => {
      const { runner, child } = fake();
      const outcome = runner(['synthetic'], new AbortController().signal);
      child.emit('close', code, code === null ? 'SIGTERM' : null);
      expect((await outcome).status).toBe(code === 0 ? 'accepted' : code === null ? 'unknown' : 'failed');
    });
  }
  test('timeout cancels the client, owns late error, and never asserts service health', async () => {
    const { runner, child, kills } = fake();
    const outcome = await observeServiceCommand(runner, ['synthetic'], 5);
    expect(outcome.status).toBe('unknown');
    expect(outcome.detail).toContain('timed out');
    expect(kills).toEqual(['SIGKILL']);
    child.emit('error', new Error('late error'));
    child.emit('close', 0, null);
  });
  test('pre-aborted operation never invokes a runner', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const outcome = await observeServiceCommand(async () => { calls++; return { status: 'accepted' }; }, ['synthetic'], 5, controller.signal);
    expect(outcome.status).toBe('unknown');
    expect(calls).toBe(0);
  });
});
