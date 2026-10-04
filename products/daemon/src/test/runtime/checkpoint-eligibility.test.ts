import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceRegistrationStore } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { readSharedWorkspaceRegistrationSnapshotSync, resolveCheckpointEligibilitySync, sharedWorkspaceRegistrationStorePath } from '../../runtime/trust/checkpoint-eligibility.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const homeDirectory = makeOwnedTempDir('daemon-checkpoint-register');
  const paths = { homeDirectory, resolveUserPath: (...parts: string[]) => join(homeDirectory, '.goodvibes', ...parts) };
  const shared = paths.resolveUserPath('shared', 'workspace-registrations.json');
  const legacy = paths.resolveUserPath('control-plane', 'workspace-registrations.json');
  const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  return { paths, shared, legacy, write };
}

test('registration reader keeps the legacy fallback read-only and prefers the shared path', () => {
  const f = fixture();
  const snapshot = { version: 1, workspaces: [], declines: [] };
  f.write(f.legacy, snapshot);
  expect(sharedWorkspaceRegistrationStorePath(f.paths)).toBe(f.legacy);
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths)).toEqual({ workspaces: [], declines: [] });
  expect(readFileSync(f.legacy, 'utf8')).toBe(JSON.stringify(snapshot));
  f.write(f.shared, snapshot);
  expect(sharedWorkspaceRegistrationStorePath(f.paths)).toBe(f.shared);
});

test('missing, corrupt and wrong-version registration stores grant no checkpoint eligibility', () => {
  const f = fixture();
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths).workspaces).toEqual([]);
  f.write(f.shared, { version: 2, workspaces: [{ root: '/fixture', checkpointEligible: true }] });
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths).workspaces).toEqual([]);
  writeFileSync(f.shared, 'invalid fixture JSON');
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths).workspaces).toEqual([]);
});

test('only an explicit boolean checkpoint grant covers a workspace, and each read is live', () => {
  const f = fixture(); const root = join(f.paths.homeDirectory, 'workspace');
  const row = { root, registeredAt: '2026-09-30T00:00:00.000Z' };
  f.write(f.shared, { version: 1, workspaces: [{ ...row, checkpointEligible: 'true' }], declines: [] });
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).not.toBe('covered');
  f.write(f.shared, { version: 1, workspaces: [{ ...row, checkpointEligible: true }], declines: [] });
  expect(resolveCheckpointEligibilitySync(f.paths, join(root, 'src'), {}).status).toBe('covered');
  f.write(f.shared, { version: 1, workspaces: [], declines: [] });
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).not.toBe('covered');
});

test('registered main worktree coverage is inherited only through the supplied git relationship', () => {
  const f = fixture(); const main = join(f.paths.homeDirectory, 'main'); const linked = join(f.paths.homeDirectory, 'linked');
  f.write(f.shared, { version: 1, workspaces: [{ root: main, registeredAt: '2026-09-30T00:00:00.000Z', checkpointEligible: true }], declines: [] });
  expect(resolveCheckpointEligibilitySync(f.paths, linked, {}).status).not.toBe('covered');
  expect(resolveCheckpointEligibilitySync(f.paths, linked, { mainWorktreeRoot: main })).toMatchObject({ status: 'covered', viaWorktreeLink: true });
});


test('SDK v2 promotion preserves legacy checkpoint permission without inventing native authority', async () => {
  const f = fixture();
  const root = join(f.paths.homeDirectory, 'existing-checkpoint-root');
  const otherRoot = join(f.paths.homeDirectory, 'new-native-root');
  mkdirSync(root); mkdirSync(otherRoot);
  const row = { root, registeredAt: '2026-09-30T00:00:00.000Z', checkpointEligible: true };
  f.write(f.shared, { version: 1, workspaces: [row], declines: [] });
  const store = new WorkspaceRegistrationStore({
    path: f.shared, homeDir: f.paths.homeDirectory, daemonStateDir: f.paths.resolveUserPath(), probe: () => ({}),
  });
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).toBe('covered');
  expect(() => store.currentScope(root)).toThrow('unmigrated');

  // The ordinary registration event legitimately promotes the shared file to
  // v2. It must neither erase the old checkpoint opt-in nor upgrade it to native.
  await store.add(otherRoot);
  expect(JSON.parse(readFileSync(f.shared, 'utf8')).version).toBe(2);
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).toBe('covered');
  expect(resolveCheckpointEligibilitySync(f.paths, join(root, 'src'), {}).status).toBe('covered');
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths).workspaces.find((entry) => entry.root === root))
    .toMatchObject(row);
  expect(() => store.currentScope(root)).toThrow('unmigrated');

  // Conversely, a real native incarnation does not imply checkpoint opt-in.
  expect(store.currentScope(otherRoot).scopeId).toMatch(/^workspace:/);
  expect(resolveCheckpointEligibilitySync(f.paths, otherRoot, {}).status).not.toBe('covered');
  await store.add(otherRoot, { checkpointEligible: true });
  expect(resolveCheckpointEligibilitySync(f.paths, otherRoot, {}).status).toBe('covered');

  const child = join(root, 'private');
  mkdirSync(child);
  await store.decline(child);
  expect(resolveCheckpointEligibilitySync(f.paths, child, {}).status).toBe('declined');
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).toBe('covered');
  await store.remove(root);
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).not.toBe('covered');
});

test('unknown registry schemas cannot grant checkpoint eligibility through valid-looking rows', () => {
  const f = fixture(); const root = join(f.paths.homeDirectory, 'unknown-schema-root');
  f.write(f.shared, { version: 3, workspaces: [{ root, registeredAt: '2026-09-30T00:00:00.000Z', checkpointEligible: true }], declines: [] });
  expect(readSharedWorkspaceRegistrationSnapshotSync(f.paths).workspaces).toEqual([]);
  expect(resolveCheckpointEligibilitySync(f.paths, root, {}).status).not.toBe('covered');
});
