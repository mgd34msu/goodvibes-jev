import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, promises as fs, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceRegistrationStore } from '../../config/workspace-registration.ts';
import { WORKSPACE_REGISTRATION_QUESTION } from '../../shell/workspace-registration-question.ts';
import { ownerWorkspaceStartupReadiness, observeOwnedWorkspaceDecline } from '../helpers/owner-workspace-startup.ts';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Owned registration write did not reach the controlled boundary'); await Bun.sleep(5); }
}

test('owner startup cannot acknowledge composer echo before the real decline is persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-ack-'));
  const home = { home: join(root, 'home'), workspace: join(root, 'workspace') };
  mkdirSync(home.home); mkdirSync(home.workspace);
  const paths = { homeDirectory: home.home, resolveUserPath: (...parts: string[]) => join(home.home, '.goodvibes', ...parts) };
  const path = paths.resolveUserPath('shared', 'workspace-registrations.json');
  let release!: () => void; let renaming = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename;
  const spy = spyOn(fs, 'rename').mockImplementation(async (source, target) => {
    if (String(target) === path) { renaming = true; await held; }
    return rename(source, target);
  });
  let decline: ReturnType<ReturnType<typeof createWorkspaceRegistrationStore>['decline']> | undefined;
  try {
    decline = createWorkspaceRegistrationStore(paths).decline(home.workspace); void decline.catch(() => {});
    await until(() => renaming);
    // The old fixture accepted this echo and could exit/restart while its
    // actual asynchronous registration owner was still before atomic rename.
    const pending = ownerWorkspaceStartupReadiness('┃  x', home);
    expect(pending.registration).toMatchObject({ present: false, byteCount: 0, ownedDecline: false });
    expect(pending.ready).toBe(false); expect(pending.canEcho).toBe(false);
    release(); await decline;
    const committed = ownerWorkspaceStartupReadiness('┃  x', home);
    expect(committed.ready).toBe(true); expect(committed.registration.ownedDecline).toBe(true);
    expect(committed.registration.byteCount).toBeGreaterThan(0); expect(committed.registration.sha256).toHaveLength(64);
    expect(ownerWorkspaceStartupReadiness(`${WORKSPACE_REGISTRATION_QUESTION}\n┃  x`, home).ready).toBe(false);
    const other = join(root, 'other'); mkdirSync(other);
    expect(ownerWorkspaceStartupReadiness('┃  x', { ...home, workspace: other }).ready).toBe(false);
  } finally {
    release();
    try { await decline; } finally { spy.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('startup diagnostics identify malformed registry bytes without exposing their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-ack-malformed-'));
  const home = { home: join(root, 'home'), workspace: join(root, 'workspace') };
  mkdirSync(home.workspace); mkdirSync(join(home.home, '.goodvibes/shared'), { recursive: true });
  try {
    writeFileSync(join(home.home, '.goodvibes/shared/workspace-registrations.json'), 'not-json-sensitive-fixture-marker');
    const evidence = observeOwnedWorkspaceDecline(home);
    expect(evidence).toMatchObject({ present: true, readable: false, ownedDecline: false });
    expect(evidence.byteCount).toBeGreaterThan(0); expect(evidence.sha256).toHaveLength(64);
    expect(JSON.stringify(evidence)).not.toContain('sensitive-fixture-marker');
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('startup acknowledgment is scoped to this home and exact canonical workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workspace-ack-scope-'));
  const home = { home: join(root, 'home'), workspace: join(root, 'workspace') };
  const otherHome = join(root, 'other-home'); const sibling = join(root, 'workspace-other'); const alias = join(root, 'workspace-alias');
  for (const directory of [home.home, home.workspace, otherHome, sibling]) mkdirSync(directory);
  const paths = { homeDirectory: home.home, resolveUserPath: (...parts: string[]) => join(home.home, '.goodvibes', ...parts) };
  try {
    expect(ownerWorkspaceStartupReadiness('┃  x', home).ready).toBe(false);
    await createWorkspaceRegistrationStore(paths).decline(home.workspace);
    expect(ownerWorkspaceStartupReadiness('┃  x', home).ready).toBe(true);
    expect(ownerWorkspaceStartupReadiness('┃  x', { ...home, workspace: sibling }).ready).toBe(false);
    expect(ownerWorkspaceStartupReadiness('┃  x', { ...home, home: otherHome }).ready).toBe(false);
    symlinkSync(home.workspace, alias, 'dir');
    expect(ownerWorkspaceStartupReadiness('┃  x', { ...home, workspace: alias }).ready).toBe(true);
    expect(ownerWorkspaceStartupReadiness('┃  x', { home: otherHome, workspace: alias }).ready).toBe(false);
    unlinkSync(alias); symlinkSync(sibling, alias, 'dir');
    expect(ownerWorkspaceStartupReadiness('┃  x', { ...home, workspace: alias }).ready).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
