import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
