import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../sdk/src/platform/state/persistent-store.ts';
import { WorkspaceRegistrationStore, withWorkspaceRegistrationWriteLockSync } from '../sdk/src/platform/workspace/registration/store.ts';
import { foldLegacyWorkspaceRegister } from '../sdk/src/platform/workspace/registration/fold-legacy-register.ts';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-workspace-scope-'));
  fixtures.push(home);
  const root = join(home, 'project');
  const child = join(root, 'private');
  mkdirSync(child, { recursive: true });
  const path = join(home, 'state', 'workspaces.json');
  const make = (extra: { fallbackReadPath?: string } = {}) => new WorkspaceRegistrationStore({
    path, homeDir: home, daemonStateDir: join(home, 'state'), probe: () => ({}), ...extra,
  });
  const seed = (document: unknown) => { mkdirSync(join(home, 'state'), { recursive: true }); writeFileSync(path, JSON.stringify(document)); };
  return { home, root, child, path, make, seed };
}
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

describe('native workspace scope ownership', () => {
  test('new registration establishes canonical incarnation stable after restart and idempotent add', async () => {
    const f = fixture(); const store = f.make();
    await store.add(f.root);
    const scope = store.currentScope(`${f.root}/.`);
    expect(scope.root).toBe(f.root);
    expect(scope.scopeId).toMatch(/^workspace:/);
    expect(f.make().currentScope(f.root)).toEqual(scope);
    await store.add(f.root);
    expect(store.currentScope(f.root)).toEqual(scope);
  });
  test('legacy registration stays readable and native-ineligible through provenance upgrades', async () => {
    const f = fixture();
    f.seed({ version: 1, workspaces: [{ root: f.root, registeredAt: '2026-01-01' }], declines: [] });
    const store = f.make();
    expect((await store.resolve(f.root)).status).toBe('covered');
    expect(() => store.currentScope(f.root)).toThrow('unmigrated');
    await store.add(f.root, { checkpointEligible: true });
    expect(() => store.currentScope(f.root)).toThrow('unmigrated');
    expect(JSON.parse(readFileSync(f.path, 'utf8')).workspaces[0].nativeScope).toBeUndefined();
  });
  test('native reads never use fallback, repair corruption, or cache removed authority', async () => {
    const f = fixture(); const store = f.make();
    await store.add(f.root);
    const fallback = join(f.home, 'legacy.json');
    writeFileSync(fallback, readFileSync(f.path)); unlinkSync(f.path);
    const other = f.make({ fallbackReadPath: fallback });
    expect((await other.resolve(f.root)).status).toBe('covered');
    expect(() => other.currentScope(f.root)).toThrow('unavailable');
    expect(() => store.currentScope(f.root)).toThrow('unavailable');
    await expect(other.add(f.child)).rejects.toThrow('fallback');
    expect(existsSync(f.path)).toBe(false);
    writeFileSync(f.path, '{broken');
    expect(() => store.currentScope(f.root)).toThrow('unavailable');
    expect(readFileSync(f.path, 'utf8')).toBe('{broken');
  });
  test('remove/readd retains a tombstone and cannot revive the previous incarnation', async () => {
    const f = fixture(); const store = f.make();
    await store.add(f.root); const old = store.currentScope(f.root);
    await store.remove(f.root);
    expect(() => f.make().currentScope(f.root)).toThrow('unavailable');
    await f.make().add(f.root);
    expect(store.currentScope(f.root).scopeId).not.toBe(old.scopeId);
    expect(JSON.parse(readFileSync(f.path, 'utf8')).scopeTombstones).toEqual([
      expect.objectContaining({ root: f.root, scopeId: old.scopeId }),
    ]);
    let launched = false;
    await expect(store.withCurrentScope(old, () => { launched = true; })).rejects.toThrow('changed');
    expect(launched).toBe(false);
  });
  test('descendant decline and nearer registration change authority without changing UX coverage', async () => {
    const f = fixture(); const store = f.make();
    await store.add(f.root); const scope = store.currentScope(f.root);
    expect(store.currentScope(f.child).scopeId).toBe(scope.scopeId);
    await f.make().decline(f.child);
    expect(() => store.currentScope(f.child)).toThrow('unavailable');
    await expect(store.withCurrentScope(scope, () => {})).rejects.toThrow('changed');
    await store.add(f.child);
    expect(store.currentScope(f.child).scopeId).not.toBe(scope.scopeId);
  });
  test('canonical symlink alias works but retargeting loses its native authority', async () => {
    const f = fixture(); const alias = join(f.home, 'alias'); symlinkSync(f.root, alias);
    const store = f.make(); await store.add(alias); const scope = store.currentScope(alias);
    expect(scope.root).toBe(f.root); expect(store.currentScope(f.root)).toEqual(scope);
    unlinkSync(alias); const other = join(f.home, 'other'); mkdirSync(other); symlinkSync(other, alias);
    expect(() => store.currentScope(alias)).toThrow('changed');
    await expect(store.withCurrentScope(scope, () => {})).rejects.toThrow();
  });
  test('async inner ownership holds the writer lock and retained validator expires afterward', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root);
    const scope = store.currentScope(f.root); const entered = deferred(); const finish = deferred();
    let retained: (() => void) | undefined;
    const owner = store.withCurrentScope(scope, async (assertCurrent) => {
      retained = assertCurrent; entered.resolve(); await finish.promise; assertCurrent(); return 'launched';
    });
    await entered.promise;
    expect(() => withWorkspaceRegistrationWriteLockSync(f.path, () => {})).toThrow();
    let removed = false;
    const writer = f.make().remove(f.root).then(() => { removed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30)); expect(removed).toBe(false);
    finish.resolve(); expect(await owner).toBe('launched');
    expect(() => retained!()).toThrow('callback'); await writer; expect(removed).toBe(true);
  });
  test('failed persistence neither publishes a new scope nor claims a durable removal', async () => {
    const f = fixture(); const store = f.make();
    let fail = spyOn(PersistentStore.prototype, 'persist').mockRejectedValue(new Error('fixture persistence failure'));
    try { await expect(store.add(f.root)).rejects.toThrow('fixture persistence failure'); } finally { fail.mockRestore(); }
    expect(existsSync(f.path)).toBe(false); expect(() => store.currentScope(f.root)).toThrow('unavailable');
    await store.add(f.root); const scope = store.currentScope(f.root);
    fail = spyOn(PersistentStore.prototype, 'persist').mockRejectedValue(new Error('fixture persistence failure'));
    try { await expect(store.remove(f.root)).rejects.toThrow('fixture persistence failure'); } finally { fail.mockRestore(); }
    expect(f.make().currentScope(f.root)).toEqual(scope);
  });
  test('legacy fold refuses v2 without erasing incarnations or resurrecting tombstones', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root); await store.remove(f.root);
    const before = readFileSync(f.path, 'utf8'); const legacy = join(f.home, 'legacy.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, workspaces: [{ root: f.root, registeredAt: '2099-01-01' }], declines: [] }));
    await expect(foldLegacyWorkspaceRegister({ legacyPath: legacy, sharedPath: f.path })).rejects.toThrow('refuses');
    expect(readFileSync(f.path, 'utf8')).toBe(before); expect(() => store.currentScope(f.root)).toThrow('unavailable');
  });
  test('malformed generations and active tombstoned incarnations fail closed', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root); const doc = JSON.parse(readFileSync(f.path, 'utf8'));
    f.seed({ ...doc, scopeGeneration: 0 }); expect(() => store.currentScope(f.root)).toThrow('unavailable');
    f.seed({ ...doc, scopeTombstones: [{ root: f.root, scopeId: doc.workspaces[0].nativeScope.id, generation: 1 }] });
    expect(() => store.currentScope(f.root)).toThrow('unavailable');
  });

  test('v1 copied native-looking fields never become attested during a later registration', async () => {
    const f = fixture(); const store = f.make(); await store.add(f.root);
    const original = JSON.parse(readFileSync(f.path, 'utf8'));
    f.seed({ version: 1, workspaces: original.workspaces, declines: [] });
    await store.add(f.child);
    expect(() => store.currentScope(f.root)).toThrow('unmigrated');
    expect(store.currentScope(f.child).scopeId).not.toBe(original.workspaces[0].nativeScope.id);
  });

  test('native scope never borrows client or probed worktree-link coverage', async () => {
    const f = fixture(); const linked = join(f.home, 'linked'); mkdirSync(linked);
    const store = new WorkspaceRegistrationStore({ path: f.path, homeDir: f.home, daemonStateDir: join(f.home, 'state'),
      probe: () => ({ mainWorktreeRoot: f.root }) });
    await store.add(f.root);
    expect((await store.resolve(linked)).status).toBe('covered');
    expect(() => store.currentScope(linked)).toThrow('unavailable');
  });

  test('nonexistent roots retain registration UX but do not acquire authority when a directory later appears', async () => {
    const f = fixture(); const store = f.make(); const future = join(f.home, 'future');
    expect((await store.add(future)).alreadyRegistered).toBe(false);
    expect((await store.resolve(future)).status).toBe('covered');
    expect(() => store.currentScope(future)).toThrow('unavailable');
    mkdirSync(future);
    expect(() => store.currentScope(future)).toThrow('unmigrated');
    await store.remove(future); await store.add(future);
    expect(store.currentScope(future).root).toBe(future);
  });
});
