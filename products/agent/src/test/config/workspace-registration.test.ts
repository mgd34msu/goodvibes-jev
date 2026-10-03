import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import {
  answerWorkspaceRegistrationPrompt,
  backfillCheckpointEligibilityIfNeeded,
  createWorkspaceRegistrationStore,
  isBroadWorkspaceRoot,
  migrateLegacyWorkspaceRegistryIfNeeded,
  normalizeWorkspaceRoot,
  registerWorkspaceForCheckpoints,
  resolveCheckpointEligibilitySync,
  resolveWorkspaceRegistrationSync,
  sharedWorkspaceRegistrationStorePath,
} from '../../config/workspace-registration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths() {
  const home = makeProjectTempDir('goodvibes-agent-workspace-registration');
  const work = makeProjectTempDir('goodvibes-agent-workspace-registration-work');
  return { shellPaths: createShellPathService({ workingDirectory: work, homeDirectory: home }), work, home };
}

function legacyRegistryPath(home: string): string {
  return join(home, '.goodvibes', 'agent', 'checkpoints', 'registered-workspaces.json');
}

describe('workspace-registration: shared store resolution', () => {
  test('an unregistered workspace resolves as unknown, no shared file created', () => {
    const { shellPaths, work } = makeShellPaths();
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, work, {});
    expect(resolution.status).toBe('unknown');
    expect(resolution.coveredBy).toBeNull();
    expect(existsSync(sharedWorkspaceRegistrationStorePath(shellPaths))).toBe(false);
  });

  test('registering via the async store makes the sync resolver report covered', async () => {
    const { shellPaths, work } = makeShellPaths();
    const store = createWorkspaceRegistrationStore(shellPaths);
    const result = await store.add(work);
    expect(result.alreadyRegistered).toBe(false);
    expect(result.record.root).toBe(normalizeWorkspaceRoot(work));

    const resolution = resolveWorkspaceRegistrationSync(shellPaths, work, {});
    expect(resolution.status).toBe('covered');
    expect(resolution.coveredBy).toBe(normalizeWorkspaceRoot(work));
  });

  test('coverage flows down a registered root\'s subtree', async () => {
    const { shellPaths, work } = makeShellPaths();
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.add(work);

    const nested = join(work, 'packages', 'app');
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, nested, {});
    expect(resolution.status).toBe('covered');
    expect(resolution.coveredBy).toBe(normalizeWorkspaceRoot(work));
  });

  test('worktree-link inheritance: a linked worktree outside the registered subtree still resolves covered', async () => {
    const { shellPaths, work } = makeShellPaths();
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.add(work);

    const siblingWorktree = makeProjectTempDir('goodvibes-agent-workspace-registration-worktree');
    // Outside `work`'s subtree entirely, so a plain path-ancestry check would
    // miss it, only the injected worktree-link git metadata makes it resolve.
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, siblingWorktree, {
      mainWorktreeRoot: work,
    });
    expect(resolution.status).toBe('covered');
    expect(resolution.viaWorktreeLink).toBe(true);
    expect(resolution.coveredBy).toBe(normalizeWorkspaceRoot(work));
  });

  test('a declined root is remembered subtree-scoped and does not silently re-register', async () => {
    const { shellPaths, work } = makeShellPaths();
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.decline(work);

    const resolution = resolveWorkspaceRegistrationSync(shellPaths, work, {});
    expect(resolution.status).toBe('declined');
    expect(resolution.declinedRoot).toBe(normalizeWorkspaceRoot(work));
  });
});

describe('workspace-registration: legacy registry migration', () => {
  test('no legacy file: migration is a no-op, no receipt written', () => {
    const { shellPaths, home } = makeShellPaths();
    const result = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(result).toBeNull();
    expect(existsSync(join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-registration-migration-receipt.json'))).toBe(false);
  });

  test('a legacy file with records migrates once into the shared store and writes a receipt', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: work, registeredAt: '2026-01-01T00:00:00.000Z', label: 'legacy' }],
    }));

    const result = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(result).not.toBeNull();
    expect(result?.recordsMigrated).toBe(1);
    expect(result?.recordsAlreadyPresent).toBe(0);

    const store = createWorkspaceRegistrationStore(shellPaths);
    const snapshot = await store.snapshot();
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0]?.root).toBe(normalizeWorkspaceRoot(work));
    expect(snapshot.workspaces[0]?.label).toBe('legacy');
    // Original registeredAt is preserved, not overwritten with "now".
    expect(snapshot.workspaces[0]?.registeredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('a second migration call is a no-op even though the legacy file is still present', () => {
    const { shellPaths, work, home } = makeShellPaths();
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: work, registeredAt: '2026-01-01T00:00:00.000Z' }],
    }));

    const first = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(first?.recordsMigrated).toBe(1);

    const second = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(second).toBeNull();
  });

  test('a migrated-then-unregistered root does not come back on a later startup', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: work, registeredAt: '2026-01-01T00:00:00.000Z' }],
    }));

    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.remove(work);

    // Migration must not re-run and re-add `work` on this later "startup".
    const second = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(second).toBeNull();
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, work, {});
    expect(resolution.status).toBe('unknown');
  });

  test('records already present in the shared store are counted, not duplicated', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    const store = createWorkspaceRegistrationStore(shellPaths);
    await store.add(work);

    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: work, registeredAt: '2026-01-01T00:00:00.000Z' }],
    }));

    const result = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(result?.recordsMigrated).toBe(0);
    expect(result?.recordsAlreadyPresent).toBe(1);
    const snapshot = await store.snapshot();
    expect(snapshot.workspaces).toHaveLength(1);
  });

  test('a malformed legacy file migrates zero records but still writes a receipt (never retried)', () => {
    const { shellPaths, home } = makeShellPaths();
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, 'not json');

    const result = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(result?.recordsMigrated).toBe(0);
    expect(existsSync(join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-registration-migration-receipt.json'))).toBe(true);

    const second = migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);
    expect(second).toBeNull();
  });
});

describe('workspace-registration: checkpoint-eligibility boundary', () => {
  // The agent's own receipt, under the agent's surface root, not the shared
  // (unscoped) tier the workspace register itself lives in.
  function backfillReceiptPath(home: string): string {
    return join(home, '.goodvibes', 'agent', 'control-plane', 'workspace-checkpoint-eligibility-backfill-receipt.json');
  }

  test('a TUI-shaped self-record (plain store.add, no flag) is registered but NOT checkpoint-eligible', async () => {
    const { shellPaths, work } = makeShellPaths();
    // The TUI's first-open self-recording is a plain SDK store.add, no flag.
    await createWorkspaceRegistrationStore(shellPaths).add(work);

    // Registered in the shared store...
    expect(resolveWorkspaceRegistrationSync(shellPaths, work, {}).status).toBe('covered');
    // ...but the checkpoint boundary does not consume it.
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('unknown');
  });

  test('explicit agent registration IS checkpoint-eligible', async () => {
    const { shellPaths, work } = makeShellPaths();
    await registerWorkspaceForCheckpoints(shellPaths, work);

    expect(resolveWorkspaceRegistrationSync(shellPaths, work, {}).status).toBe('covered');
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('covered');
  });

  test('a TUI self-record and an explicit registration coexist; only the explicit one is eligible', async () => {
    const { shellPaths, work } = makeShellPaths();
    const tuiDir = makeProjectTempDir('goodvibes-agent-workspace-registration-tui');
    await createWorkspaceRegistrationStore(shellPaths).add(tuiDir);
    await registerWorkspaceForCheckpoints(shellPaths, work);

    expect(resolveCheckpointEligibilitySync(shellPaths, tuiDir, {}).status).toBe('unknown');
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('covered');
  });

  test('a later SDK store write (a TUI self-record of another dir) does not wipe an explicit record\'s eligibility', async () => {
    const { shellPaths, work } = makeShellPaths();
    await registerWorkspaceForCheckpoints(shellPaths, work);
    // A subsequent plain SDK add (as the TUI does) rewrites the shared file; the
    // SDK preserves existing records' extra fields, so `work` stays eligible.
    const otherDir = makeProjectTempDir('goodvibes-agent-workspace-registration-other');
    await createWorkspaceRegistrationStore(shellPaths).add(otherDir);

    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('covered');
    expect(resolveCheckpointEligibilitySync(shellPaths, otherDir, {}).status).toBe('unknown');
  });

  test('coverage still flows down an eligible root\'s subtree and inherits through the worktree link', async () => {
    const { shellPaths, work } = makeShellPaths();
    await registerWorkspaceForCheckpoints(shellPaths, work);

    const nested = join(work, 'packages', 'app');
    expect(resolveCheckpointEligibilitySync(shellPaths, nested, {}).status).toBe('covered');

    const siblingWorktree = makeProjectTempDir('goodvibes-agent-workspace-registration-eligible-worktree');
    const inherited = resolveCheckpointEligibilitySync(shellPaths, siblingWorktree, { mainWorktreeRoot: work });
    expect(inherited.status).toBe('covered');
    expect(inherited.viaWorktreeLink).toBe(true);
  });

  test('backfill stamps the agent\'s legacy explicit-list records eligible, once', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    // An already-migrated shared store WITHOUT the flag, plus the still-present
    // legacy explicit-list file (the earlier-migration-then-added-flag case).
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: work, registeredAt: '2026-01-01T00:00:00.000Z' }],
    }));
    migrateLegacyWorkspaceRegistryIfNeeded(shellPaths);

    // Before backfill: registered, but not yet checkpoint-eligible.
    expect(resolveWorkspaceRegistrationSync(shellPaths, work, {}).status).toBe('covered');
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('unknown');

    const result = backfillCheckpointEligibilityIfNeeded(shellPaths);
    expect(result?.recordsStamped).toBe(1);
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('covered');

    // Idempotent: a second call is a receipt-gated no-op.
    expect(backfillCheckpointEligibilityIfNeeded(shellPaths)).toBeNull();
  });

  test('backfill with no legacy file is a no-op and writes no receipt', () => {
    const { shellPaths, home } = makeShellPaths();
    expect(backfillCheckpointEligibilityIfNeeded(shellPaths)).toBeNull();
    expect(existsSync(backfillReceiptPath(home))).toBe(false);
  });

  test('backfill does NOT stamp a record absent from the legacy explicit list (a TUI self-record)', async () => {
    const { shellPaths, work, home } = makeShellPaths();
    // A TUI self-record in the shared store, and a legacy file that does NOT
    // list it, so backfill must leave it ineligible.
    await createWorkspaceRegistrationStore(shellPaths).add(work);
    const legacyPath = legacyRegistryPath(home);
    mkdirSync(join(home, '.goodvibes', 'agent', 'checkpoints'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 1,
      workspaces: [{ root: join(home, 'some-other-explicit-project'), registeredAt: '2026-01-01T00:00:00.000Z' }],
    }));

    const result = backfillCheckpointEligibilityIfNeeded(shellPaths);
    expect(result?.recordsStamped).toBe(0);
    expect(resolveCheckpointEligibilitySync(shellPaths, work, {}).status).toBe('unknown');
  });
});

describe('workspace-registration: first-start prompt support', () => {
  test('isBroadWorkspaceRoot refuses the home directory', () => {
    const { shellPaths, home } = makeShellPaths();
    expect(isBroadWorkspaceRoot(shellPaths, home)).toBe(true);
  });

  test('isBroadWorkspaceRoot refuses the filesystem root', () => {
    const { shellPaths } = makeShellPaths();
    expect(isBroadWorkspaceRoot(shellPaths, '/')).toBe(true);
  });

  test('isBroadWorkspaceRoot refuses the daemon state directory (~/.goodvibes)', () => {
    const { shellPaths, home } = makeShellPaths();
    expect(isBroadWorkspaceRoot(shellPaths, join(home, '.goodvibes'))).toBe(true);
  });

  test('isBroadWorkspaceRoot allows an ordinary project directory', () => {
    const { shellPaths, work } = makeShellPaths();
    expect(isBroadWorkspaceRoot(shellPaths, work)).toBe(false);
  });

  test('answerWorkspaceRegistrationPrompt(accepted:true) registers the root', async () => {
    const { shellPaths, work } = makeShellPaths();
    answerWorkspaceRegistrationPrompt(shellPaths, work, true);
    const store = createWorkspaceRegistrationStore(shellPaths);
    const resolved = await pollUntilResolved(store, work, 'covered');
    expect(resolved).toBe(true);
  });

  test('answerWorkspaceRegistrationPrompt(accepted:false) declines the root', async () => {
    const { shellPaths, work } = makeShellPaths();
    answerWorkspaceRegistrationPrompt(shellPaths, work, false);
    const store = createWorkspaceRegistrationStore(shellPaths);
    const resolved = await pollUntilResolved(store, work, 'declined');
    expect(resolved).toBe(true);
  });
});

async function pollUntilResolved(
  store: ReturnType<typeof createWorkspaceRegistrationStore>,
  path: string,
  status: 'covered' | 'declined',
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await store.resolve(path)).status === status) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
