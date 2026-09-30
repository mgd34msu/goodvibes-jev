import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../sdk/src/platform/workspace/checkpoint/manager.ts';
import { SideGitRunner } from '../sdk/src/platform/workspace/checkpoint/side-git.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { emitTurnCompleted } from '../sdk/src/platform/runtime/emitters/turn.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('draining an unused manager does not initialize a checkpoint store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-drain-unused-'));
  try {
    const manager = new WorkspaceCheckpointManager({ workspaceRoot: root });
    await manager.drain();
    await manager.drain();
    expect(existsSync(join(root, '.goodvibes'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('drain waits for accepted initialization, releases its lock, and removes late subscriptions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-drain-init-'));
  const entered = deferred();
  const release = deferred();
  const original = SideGitRunner.prototype.init;
  const pause = spyOn(SideGitRunner.prototype, 'init').mockImplementation(async function (this: SideGitRunner) {
    if (this.workspaceRoot === root) { entered.resolve(); await release.promise; }
    return original.call(this);
  });
  const bus = new RuntimeEventBus();
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus, preferGitRoot: false });
  const initializing = manager.init();
  let draining: Promise<void> | undefined;
  try {
    await entered.promise;
    const lock = join(root, '.goodvibes', 'checkpoints', 'git', '.gv-lock');
    expect(existsSync(lock)).toBe(true);
    let drained = false;
    draining = manager.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await draining;
    await initializing;
    expect(existsSync(lock)).toBe(false);
    const create = spyOn(manager, 'create');
    try {
      emitTurnCompleted(bus, { sessionId: 'fixture', traceId: 'fixture', source: 'test' }, {
        turnId: 'after-drain', response: 'done', stopReason: 'completed',
      });
      await Promise.resolve();
      expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  } finally {
    release.resolve();
    await Promise.allSettled([initializing, draining]);
    manager.dispose();
    pause.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])('drain waits for accepted git work and releases its lock (failure=%s)', async (fail) => {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-drain-write-'));
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, preferGitRoot: false });
  const entered = deferred();
  const release = deferred();
  const original = SideGitRunner.prototype.writeTree;
  const pause = spyOn(SideGitRunner.prototype, 'writeTree').mockImplementation(async function (this: SideGitRunner) {
    if (this.workspaceRoot === root) {
      entered.resolve();
      await release.promise;
      if (fail) throw new Error('fixture write failure');
    }
    return original.call(this);
  });
  let creating: Promise<unknown> | undefined;
  let draining: Promise<void> | undefined;
  try {
    await manager.init();
    writeFileSync(join(root, 'file.txt'), 'checkpoint fixture');
    creating = manager.create({ kind: 'manual' }).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    let drained = false;
    draining = manager.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await draining;
    const outcome = await creating;
    if (fail) expect(outcome).toEqual({ error: new Error('fixture write failure') });
    else expect(outcome).toMatchObject({ value: { kind: 'manual' } });
    expect(existsSync(join(root, '.goodvibes', 'checkpoints', 'git', '.gv-lock'))).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([creating, draining]);
    manager.dispose();
    pause.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
