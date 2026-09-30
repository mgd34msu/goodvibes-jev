import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createSessionSurface, RuntimeEventBus } from '../../runtime/index.js';
import { createWorkspaceCheckpointing } from '../../runtime/workspace-checkpointing.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('daemon-checkpoint-composition');
  const workspaceRoot = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workspaceRoot); mkdirSync(homeDirectory);
  const values = { checkpoints: { preferGitRoot: false, autoRetention: false, unregisteredWorkspaces: 'off' } };
  const shellPaths = { homeDirectory, resolveUserPath: (...parts: string[]) => join(homeDirectory, '.goodvibes', ...parts) };
  const surface = createSessionSurface({ surfaceRoot: 'tui', workingDirectory: workspaceRoot, homeDirectory });
  const composition = createWorkspaceCheckpointing({
    workspaceRoot, surface, runtimeBus: new RuntimeEventBus(), shellPaths,
    configManager: { getRaw: () => values } as unknown as ConfigManager,
    resolveSessionId: () => 'fixture-session',
  });
  const register = (eligible: boolean) => {
    const path = shellPaths.resolveUserPath('shared', 'workspace-registrations.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, workspaces: eligible ? [{ root: workspaceRoot, registeredAt: '2026-09-30T00:00:00.000Z', checkpointEligible: true }] : [], declines: [] }));
  };
  return { composition, workspaceRoot, surface, values, register };
}

test('automatic and gateway checkpoint creation honor live registration without hiding existing reads', async () => {
  const f = fixture();
  try {
    await f.composition.manager.init();
    expect(f.composition.currentlyAllowed()).toBe(false);
    expect(await f.composition.manager.create({ kind: 'turn', label: 'unregistered automatic' })).toBeNull();
    expect(() => f.composition.gatewayManager.create({ kind: 'manual', label: 'unregistered manual' })).toThrow('not registered');
    f.register(true);
    writeFileSync(join(f.workspaceRoot, 'fixture.txt'), 'fixture content\n');
    const created = await f.composition.gatewayManager.create({ kind: 'manual', label: 'registered fixture' });
    expect(created).not.toBeNull();
    expect(created?.sessionId).toBe('fixture-session');
    expect(existsSync(join(f.surface.checkpointsDir, 'git', 'HEAD'))).toBe(true);
    expect(existsSync(join(f.workspaceRoot, '.goodvibes', 'checkpoints', 'git', 'HEAD'))).toBe(false);
    f.register(false);
    expect(f.composition.currentlyAllowed()).toBe(false);
    expect((await f.composition.gatewayManager.list()).some((checkpoint) => checkpoint.id === created?.id)).toBe(true);
    expect(await f.composition.manager.create({ kind: 'agent-run', label: 'unregistered again' })).toBeNull();
  } finally { f.composition.manager.dispose(); }
});

test('the explicit guarded-workspace setting is read live and retains snapshot guards and session attribution', async () => {
  const f = fixture();
  try {
    await f.composition.manager.init();
    f.values.checkpoints.unregisteredWorkspaces = 'guarded';
    expect(f.composition.currentlyAllowed()).toBe(true);
    writeFileSync(join(f.workspaceRoot, 'fixture.txt'), 'guarded fixture content\n');
    const created = await f.composition.gatewayManager.create({ kind: 'manual', label: 'guarded fixture', sessionId: 'explicit-fixture-session' });
    expect(created?.sessionId).toBe('explicit-fixture-session');
    f.values.checkpoints.unregisteredWorkspaces = 'off';
    expect(f.composition.currentlyAllowed()).toBe(false);
  } finally { f.composition.manager.dispose(); }
});
