/**
 * Owner ruling (2026-07-10): automatic (turn-end/lifecycle) workspace
 * checkpoints run ONLY when the resolved workspace root is COVERED by the
 * shared registration store (../../config/workspace-registration.ts, SDK
 * 1.6.1 platform/workspace/registration), and explicit checkpoint creation
 * through the ws-only `checkpoints.create` gateway verb is refused with an
 * honest hint for an unregistered workspace. This exercises the real wiring
 * in ../../runtime/services.ts end to end, a fresh RuntimeServices instance
 * per case, not the shared test-helper singleton, so each case controls its
 * own workspace root and registration state independently.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createEventEnvelope } from '@goodvibes-jev/engine/transport-core';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createWorkspaceRegistrationStore, registerWorkspaceForCheckpoints } from '../../config/workspace-registration.ts';
import { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  // Callers pass a trailing '-' (historical mkdtemp-prefix convention);
  // makeProjectTempDir appends its own separator, so strip it here once.
  const dir = makeProjectTempDir(prefix.replace(/-+$/, ''));
  tempDirs.push(dir);
  return dir;
}

async function buildServices(opts: { registered: boolean; workingDir?: string; homeDir?: string }): Promise<{ services: RuntimeServices; runtimeBus: RuntimeEventBus; workingDir: string }> {
  const workingDir = opts.workingDir ?? makeTempDir('gv-checkpoint-reg-work-');
  const homeDir = opts.homeDir ?? makeTempDir('gv-checkpoint-reg-home-');
  const configDir = makeTempDir('gv-checkpoint-reg-config-');
  mkdirSync(configDir, { recursive: true });
  // `makeTempDir` (backed by `makeProjectTempDir`) places `workingDir` under
  // this repo's own `.test-tmp/`, which is itself INSIDE the real
  // goodvibes-agent git tree. With the SDK's `preferGitRoot` default (true),
  // the checkpoint manager would walk up and resolve the REAL repo root as
  // the snapshot root, cross-test pollution at best, real commits into this
  // repo's own `.goodvibes/checkpoints` at worst. `preferGitRoot: false` here
  // keeps every case strictly scoped to its own isolated `workingDir`.
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ checkpoints: { preferGitRoot: false } }));

  if (opts.registered) {
    const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory: homeDir });
    // Explicit checkpoint registration (registers AND stamps eligibility), a
    // plain store.add is a TUI-shaped self-record and is NOT checkpoint-eligible.
    await registerWorkspaceForCheckpoints(shellPaths, workingDir);
  }

  const runtimeBus = new RuntimeEventBus();
  const services = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
    configManager: new ConfigManager({ surfaceRoot: 'agent', configDir, workingDir, homeDir }),
    runtimeBus,
    runtimeStore: createRuntimeStore(),
    workingDir,
    homeDirectory: homeDir,
    getConversationTitle: () => 'checkpoint-registration-test',
  });
  return { services, runtimeBus, workingDir };
}

function emitTurnCompleted(bus: RuntimeEventBus, turnId: string): void {
  bus.emit('turn', createEventEnvelope('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId, response: 'done', stopReason: 'completed' }, {
    sessionId: 'checkpoint-registration-test',
    source: 'checkpoint-registration-test',
    turnId,
  }));
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

describe('registered-workspaces-only automatic checkpoints', () => {
  test('an unregistered workspace takes no automatic checkpoint on TURN_COMPLETED', async () => {
    const { services, runtimeBus } = await buildServices({ registered: false });
    await services.workspaceCheckpointManager.init();

    emitTurnCompleted(runtimeBus, 'turn-1');

    // Give any (unexpected) async subscription a real chance to fire before
    // asserting the negative, a bounded wait, not a race.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const checkpoints = await services.workspaceCheckpointManager.list();
    expect(checkpoints).toHaveLength(0);
  }, 10000);

  test('a registered workspace takes an automatic checkpoint on TURN_COMPLETED', async () => {
    const { services, runtimeBus, workingDir } = await buildServices({ registered: true });
    // A real file to snapshot: an empty workspace's tree matches the implicit
    // empty-tree parent, so `create()` would otherwise return its honest
    // no-op (null) even on the very first checkpoint (manager.ts's "current
    // tree is identical to the parent checkpoint's tree" case), not a
    // registration-gate bug, just nothing to snapshot.
    writeFileSync(join(workingDir, 'note.txt'), 'hello');
    await services.workspaceCheckpointManager.init();

    emitTurnCompleted(runtimeBus, 'turn-1');

    const created = await pollUntil(async () => (await services.workspaceCheckpointManager.list()).length > 0);
    expect(created).toBe(true);
    const checkpoints = await services.workspaceCheckpointManager.list();
    expect(checkpoints[0]?.kind).toBe('turn');
  }, 10000);

  test('explicit checkpoints.create is refused with a registration hint for an unregistered workspace', async () => {
    const { services } = await buildServices({ registered: false });

    // The gate moved with the verb. `checkpoints.create` is the daemon's now,
    // this process registers no handler for it, but the registered-workspace
    // rule still applies to every explicit create made IN this process, and
    // `guardedCheckpoints` is the manager those callers go through.
    // Thrown SYNCHRONOUSLY: the gate runs before the manager is reached, so
    // there is no promise to reject. The gateway handler that used to wrap this
    // turned it into a rejection; calling the guarded manager directly does not.
    expect(
      () => services.guardedCheckpoints.create({ kind: 'manual' }),
    ).toThrow(/not registered/);
  });

  test('explicit checkpoints.create succeeds for a registered workspace', async () => {
    const { services, workingDir } = await buildServices({ registered: true });
    writeFileSync(join(workingDir, 'note.txt'), 'hello');

    const created = await services.guardedCheckpoints.create({ kind: 'manual' });
    expect(created).not.toBeNull();
  });

  test('registering the workspace mid-launch starts automatic checkpoints without a restart', async () => {
    // Build services UNREGISTERED (mirrors a launch in a workspace nobody has
    // registered yet), confirm no automatic checkpoint fires, THEN register
    // the workspace through the same shared store `goodvibes-agent workspaces
    // register` writes to, all against the SAME long-running services
    // instance, no new createRuntimeServices call (no restart). A second
    // TURN_COMPLETED on that unchanged instance must now produce a checkpoint.
    const { services, runtimeBus, workingDir } = await buildServices({ registered: false });
    const homeDir = services.shellPaths.homeDirectory;
    writeFileSync(join(workingDir, 'note.txt'), 'hello');
    await services.workspaceCheckpointManager.init();

    emitTurnCompleted(runtimeBus, 'turn-before-registration');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await services.workspaceCheckpointManager.list()).toHaveLength(0);

    const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory: homeDir });
    await registerWorkspaceForCheckpoints(shellPaths, workingDir);

    emitTurnCompleted(runtimeBus, 'turn-after-registration');
    const created = await pollUntil(async () => (await services.workspaceCheckpointManager.list()).length > 0);
    expect(created).toBe(true);
    const checkpoints = await services.workspaceCheckpointManager.list();
    expect(checkpoints[0]?.kind).toBe('turn');
  }, 10000);

  test('explicit checkpoints.create also succeeds mid-launch once the workspace is registered, without a restart', async () => {
    const { services, workingDir } = await buildServices({ registered: false });
    const homeDir = services.shellPaths.homeDirectory;
    writeFileSync(join(workingDir, 'note.txt'), 'hello');

    // The gate moved with the verb. `checkpoints.create` is the daemon's now,
    // this process registers no handler for it, but the registered-workspace
    // rule still applies to every explicit create made IN this process, and
    // `guardedCheckpoints` is the manager those callers go through.
    // Thrown SYNCHRONOUSLY: the gate runs before the manager is reached, so
    // there is no promise to reject. The gateway handler that used to wrap this
    // turned it into a rejection; calling the guarded manager directly does not.
    expect(
      () => services.guardedCheckpoints.create({ kind: 'manual' }),
    ).toThrow(/not registered/);

    const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory: homeDir });
    await registerWorkspaceForCheckpoints(shellPaths, workingDir);

    const created = await services.guardedCheckpoints.create({ kind: 'manual' });
    expect(created).not.toBeNull();
  });

  test('defense in depth: the SDK root guard still refuses a broad root even when registered', async () => {
    const workingDir = makeTempDir('gv-checkpoint-broad-root-');
    // Deliberately equal to workingDir, to trigger the SDK's "this root looks
    // like a home directory" broad-root guard on both layers below.
    const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory: workingDir });

    // Layer 1: the shared registration store's own root-guard refuses to
    // register a root this broad in the first place (new in the shared
    // store, the local registry it replaced had no write-time guard).
    await expect(createWorkspaceRegistrationStore(shellPaths).add(workingDir)).rejects.toThrow(/broad|home|refus/i);

    // Layer 2: construct the SDK manager directly (not through
    // createRuntimeServices) so a root that somehow got INTO the registry
    // anyway (e.g. a pre-guard migrated record) is still refused at
    // checkpoint-creation time by the manager's own construction-time guard,
    // independent of the registration store above. Proves the registration
    // gate this change adds is a layer ON TOP of the guard, never a bypass
    // of it.
    const manager = new WorkspaceCheckpointManager({
      workspaceRoot: workingDir,
      preferGitRoot: false,
      homeDir: workingDir,
    });

    await expect(manager.create({ kind: 'manual' })).rejects.toThrow(/broad|home|refus/i);
  });
});

/**
 * Worktree-link inheritance (SDK 1.6.1 shared registration store): a linked
 * git worktree of a registered repo is COVERED without being registered
 * itself, the resolver follows `git rev-parse --git-common-dir`, not path
 * ancestry, so an orchestration-spawned sibling worktree outside the
 * registered root's subtree still checkpoints automatically. This exercises
 * the real end-to-end wiring (createRuntimeServices -> resolveWorkspaceRegistrationSync
 * -> the real `probeWorktreeLink` git spawn), not an injected git-metadata
 * stub, so it needs a real `git` binary and a real linked worktree.
 */
describe('registered-workspaces-only automatic checkpoints: worktree-link inheritance', () => {
  function git(cwd: string, args: readonly string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  test('a linked worktree of a registered main repo takes automatic checkpoints', async () => {
    const mainRepo = makeTempDir('gv-checkpoint-worktree-main-');
    const homeDir = makeTempDir('gv-checkpoint-worktree-home-');
    git(mainRepo, ['init', '--quiet']);
    git(mainRepo, ['config', 'user.email', 'test@example.com']);
    git(mainRepo, ['config', 'user.name', 'Test']);
    writeFileSync(join(mainRepo, 'seed.txt'), 'seed');
    git(mainRepo, ['add', '.']);
    git(mainRepo, ['commit', '--quiet', '-m', 'seed']);

    // mkdtempSync creates an empty directory, which `git worktree add` accepts
    // as its target (an existing path must be empty; it need not be absent).
    const worktreeDir = makeTempDir('gv-checkpoint-worktree-link-');
    git(mainRepo, ['worktree', 'add', '--quiet', '-b', 'orchestration-branch', worktreeDir]);

    const shellPaths = createShellPathService({ workingDirectory: mainRepo, homeDirectory: homeDir });
    await registerWorkspaceForCheckpoints(shellPaths, mainRepo);

    // The worktree lives OUTSIDE mainRepo's subtree entirely, so only the
    // git worktree-link inheritance, not path ancestry, makes it covered.
    const { services, runtimeBus } = await buildServices({ registered: false, workingDir: worktreeDir, homeDir });
    writeFileSync(join(worktreeDir, 'note.txt'), 'hello');
    await services.workspaceCheckpointManager.init();

    emitTurnCompleted(runtimeBus, 'turn-1');

    const created = await pollUntil(async () => (await services.workspaceCheckpointManager.list()).length > 0);
    expect(created).toBe(true);
  }, 15000);
});
