/** Namespace allocation, recovery and cleanup against real Git, without model calls. */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { judgmentInputBoundary } from '../sdk/src/platform/gate/boundary.js';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { createPermissionConfigReader, PermissionManager } from '../sdk/src/platform/permissions/manager.js';
import { UserPermissionRuleStore } from '../sdk/src/platform/permissions/user-rule-store.js';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktreeIsolationManager, itemWorktreeBranch } from '../sdk/src/platform/orchestration/worktree-isolation.js';
import { CURRENT_WORKSTREAM_SCHEMA_VERSION, type OrchestrationEvent, type WorkItem, type Workstream } from '../sdk/src/platform/orchestration/types.js';
import { emptyWorkItemUsage } from '../sdk/src/platform/orchestration/types.js';
import { serializeWorkstreamSnapshot, deserializeWorkstreamSnapshot, deserializeWorkstream } from '../sdk/src/platform/orchestration/persistence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'worktree-namespace-')); roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(root, 'seed.txt'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'seed');
  return root;
}
function stream(): Workstream {
  const item: WorkItem = { id: 'u1', title: 'unit', task: 'task', state: 'pending', currentPhaseId: null,
    dependsOn: [], allAgentIds: [], visits: new Map(), touchedPaths: [], usage: emptyWorkItemUsage(), transportRetryCount: 0, createdAt: 0 };
  return { id: 'g1', title: 'group', schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION, phases: [], items: [item], isolation: 'worktree', createdAt: 0 };
}
function manager(root: string, stateNamespace?: string, events: OrchestrationEvent[] = []) {
  return createWorktreeIsolationManager({ projectRoot: root, stateNamespace, emit: event => events.push(event) });
}

test('full namespace identity isolates duplicate group/unit IDs and cleanup owns only its allocation', async () => {
  const root = repo(); const a = stream(); const b = stream();
  // The suffix is deliberately identical. Namespace shortening would collide.
  const first = manager(root, 'contract-one-same'); const second = manager(root, 'contract-two-same');
  const [own, other] = await Promise.all([first.ensureWorktree(a, a.items[0]!), second.ensureWorktree(b, b.items[0]!)]);
  expect(own.path).not.toBe(other.path); expect(a.items[0]!.worktreeBranch).not.toBe(b.items[0]!.worktreeBranch);
  const otherBranch = b.items[0]!.worktreeBranch!; const otherHead = git(root, 'rev-parse', otherBranch);
  writeFileSync(join(other.path, 'unfinished.txt'), 'other contract owns this\n');
  await first.cleanupTerminated(a, a.items[0]!); await first.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(other.path)).toBe(true);
  expect(readFileSync(join(other.path, 'unfinished.txt'), 'utf8')).toBe('other contract owns this\n');
  expect(git(root, 'rev-parse', otherBranch)).toBe(otherHead);
  await second.cleanupTerminated(b, b.items[0]!); await second.join();
  expect(b.items[0]!.worktreeKept).toBe(true); expect(existsSync(other.path)).toBe(true);
});

test('failed allocation cleanup cannot delete an existing branch even when it has no worktree', async () => {
  const root = repo(); const ws = stream(); const item = ws.items[0]!; const owner = manager(root);
  const branch = itemWorktreeBranch(ws.id, item.id); git(root, 'branch', branch); const head = git(root, 'rev-parse', branch);
  await expect(owner.ensureWorktree(ws, item)).rejects.toThrow();
  await owner.cleanupTerminated(ws, item); await owner.join();
  expect(git(root, 'rev-parse', branch)).toBe(head);
  expect(item.worktreePath).toBeUndefined();
});

test('failed allocation cleanup cannot remove a pre-existing clean worktree at the derived path', async () => {
  const root = repo(); const ws = stream(); const item = ws.items[0]!; const owner = manager(root);
  const path = join(root, '.goodvibes', '.worktrees', 'ws', 'g1', 'u1');
  git(root, 'worktree', 'add', '-q', '-b', 'user-owned', path); const before = git(root, 'worktree', 'list', '--porcelain');
  await expect(owner.ensureWorktree(ws, item)).rejects.toThrow();
  await owner.cleanupTerminated(ws, item); await owner.join();
  expect(existsSync(path)).toBe(true); expect(git(path, 'branch', '--show-current')).toBe('user-owned');
  expect(readFileSync(join(path, 'seed.txt'), 'utf8')).toBe('original\n');
  expect(git(root, 'worktree', 'list', '--porcelain')).toBe(before);
});

test('unrecorded recovery adopts only the same namespace and leaves other namespaces and legacy trees untouched', async () => {
  const root = repo(); const a = stream(); const b = stream(); const legacy = stream();
  const first = manager(root, 'contract-A'); const second = manager(root, 'contract-B'); const old = manager(root);
  const own = await first.ensureWorktree(a, a.items[0]!); const other = await second.ensureWorktree(b, b.items[0]!);
  const previous = await old.ensureWorktree(legacy, legacy.items[0]!);
  const resumed = stream(); const events: OrchestrationEvent[] = []; const recovering = manager(root, 'contract-A', events);
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeBranch).toBe(a.items[0]!.worktreeBranch);
  expect(events.filter(event => event.type === 'orphan-worktree-reconciled')).toEqual([
    expect.objectContaining({ path: own.path, disposition: 'adopted' }),
  ]);
  expect((await recovering.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(own.path);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(other.path)).toBe(true); expect(existsSync(previous.path)).toBe(true);
});

test('resumed recorded legacy names are retained under a namespace and cancellation before claim cleans only that record', async () => {
  const root = repo(); const legacy = stream(); const other = stream();
  const original = manager(root); const separate = manager(root, 'contract-B');
  const own = await original.ensureWorktree(legacy, legacy.items[0]!); const foreign = await separate.ensureWorktree(other, other.items[0]!);
  const resumed = stream(); Object.assign(resumed.items[0]!, { worktreePath: own.path, worktreeBranch: legacy.items[0]!.worktreeBranch });
  const recovering = manager(root, 'contract-A'); recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreeBranch).toBe('ws/g1/u1'); expect(resumed.items[0]!.worktreePath).toBe(own.path);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(foreign.path)).toBe(true);
});

test('namespace fragments are deterministic, safe, and never collapse namespaces with identical suffixes', () => {
  const names = ['contract-a-same', 'contract-b-same', '', '../../escape\n☃', 'CONTRACT-a-same'];
  const branches = names.map(namespace => itemWorktreeBranch('group-1', 'unit-1', namespace));
  expect(new Set(branches).size).toBe(names.length);
  expect(itemWorktreeBranch('group-1', 'unit-1')).toBe('ws/1/1');
  for (const [index, branch] of branches.entries()) {
    expect(branch).toBe(itemWorktreeBranch('group-1', 'unit-1', names[index]));
    expect(branch).toMatch(/^ws-ns\/[a-fk-t]{64}\/1\/1$/);
  }
  expect(itemWorktreeBranch('../group', '../unit', '../../namespace')).toMatch(/^ws-ns\/[a-fk-t]{64}\/[a-f0-9]{8}\/[a-f0-9]{8}$/);
});

test('recorded legacy resources win over a same-namespace orphan and missing branch metadata comes from Git', async () => {
  const root = repo(); const legacy = stream(); const canonical = stream();
  const old = manager(root); const fresh = manager(root, 'contract-A');
  const own = await old.ensureWorktree(legacy, legacy.items[0]!); const extra = await fresh.ensureWorktree(canonical, canonical.items[0]!);
  const resumed = stream(); resumed.items[0]!.worktreePath = own.path;
  const events: OrchestrationEvent[] = []; const recovering = manager(root, 'contract-A', events);
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreeBranch).toBe('ws/g1/u1');
  expect((await recovering.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(own.path);
  expect(events.filter(event => event.type === 'orphan-worktree-reconciled')).toEqual([
    expect.objectContaining({ path: extra.path, disposition: 'reported' }),
  ]);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(extra.path)).toBe(true);
});

test('resumed pending integration uses its recorded legacy branch without touching another contract', async () => {
  const root = repo(); const legacy = stream(); const other = stream();
  const old = manager(root); const foreign = manager(root, 'contract-B');
  const own = await old.ensureWorktree(legacy, legacy.items[0]!); const separate = await foreign.ensureWorktree(other, other.items[0]!);
  const otherBranch = other.items[0]!.worktreeBranch!; const otherHead = git(root, 'rev-parse', otherBranch);
  writeFileSync(join(own.path, 'completed.txt'), 'preserved output\n'); git(own.path, 'add', 'completed.txt'); git(own.path, 'commit', '-qm', 'complete');
  const resumed = stream(); Object.assign(resumed.items[0]!, { state: 'passed', mergeState: 'pending', worktreePath: own.path, worktreeBranch: legacy.items[0]!.worktreeBranch });
  const recovering = manager(root, 'contract-A'); recovering.reconcileOrphans(resumed); await recovering.join();
  expect(resumed.items[0]!.mergeState).toBe('merged'); expect(resumed.items[0]!.mergeHash).toMatch(/^[a-f0-9]{40}$/);
  expect(readFileSync(join(root, 'completed.txt'), 'utf8')).toBe('preserved output\n');
  expect(existsSync(own.path)).toBe(false); expect(existsSync(separate.path)).toBe(true);
  expect(git(root, 'rev-parse', otherBranch)).toBe(otherHead); expect(existsSync(join(separate.path, 'completed.txt'))).toBe(false);
});

test('a successful allocation stays cleanup-owned when its initializer later fails', async () => {
  const root = repo(); const ws = stream(); const item = ws.items[0]!; let acquiredPath = '';
  const owner = createWorktreeIsolationManager({ projectRoot: root, stateNamespace: 'contract-A', emit: () => undefined,
    initializeWorktree: async worktree => { await worktree.create(); acquiredPath = worktree.path; throw new Error('materialization failed'); } });
  await expect(owner.ensureWorktree(ws, item)).rejects.toThrow('materialization failed');
  expect(existsSync(acquiredPath)).toBe(true); expect(item.worktreePath).toBe(acquiredPath); expect(item.worktreeInitialized).toBe(false);
  await expect(owner.ensureWorktree(ws, item)).rejects.toThrow('requires recovery');
  await owner.cleanupTerminated(ws, item); await owner.join();
  expect(existsSync(acquiredPath)).toBe(false);
  expect(git(root, 'branch', '--list', itemWorktreeBranch('g1', 'u1', 'contract-A'))).toBe('');
});

test('branch-only legacy recovery resolves the recorded resource before applying the namespace filter', async () => {
  const root = repo(); const legacy = stream(); const old = manager(root);
  const own = await old.ensureWorktree(legacy, legacy.items[0]!);
  const resumed = stream(); resumed.items[0]!.worktreeBranch = legacy.items[0]!.worktreeBranch;
  const recovering = manager(root, 'contract-A'); recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeBranch).toBe('ws/g1/u1');
  expect((await recovering.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(own.path);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join(); expect(existsSync(own.path)).toBe(false);
});

test('dirty failed initialization survives serialization and recovery cannot execute or integrate its partial tree', async () => {
  const root = repo(); const ws = stream(); const item = ws.items[0]!;
  const owner = createWorktreeIsolationManager({ projectRoot: root, stateNamespace: 'contract-A', emit: () => undefined,
    initializeWorktree: async worktree => { await worktree.create(); writeFileSync(join(worktree.path, 'partial.txt'), 'incomplete\n'); throw new Error('materialization failed'); } });
  await expect(owner.ensureWorktree(ws, item)).rejects.toThrow('materialization failed');
  const path = item.worktreePath!; await owner.cleanupTerminated(ws, item); await owner.join();
  expect(item.worktreeKept).toBe(true); expect(item.worktreeInitialized).toBe(false);
  const serialized = serializeWorkstreamSnapshot(ws, [])!;
  const snapshot = deserializeWorkstreamSnapshot(serialized)!; const resumed = deserializeWorkstream(snapshot.workstream);
  const recovering = manager(root, 'contract-A'); recovering.reconcileOrphans(resumed);
  await expect(recovering.ensureWorktree(resumed, resumed.items[0]!)).rejects.toThrow('requires recovery');
  await recovering.enqueueIntegration(resumed, resumed.items[0]!); await recovering.join();
  expect(resumed.items[0]!.mergeState).toBe('conflict'); expect(resumed.items[0]!.worktreeInitialized).toBe(false);
  expect(readFileSync(join(path, 'partial.txt'), 'utf8')).toBe('incomplete\n'); expect(existsSync(join(root, 'partial.txt'))).toBe(false);
});

test('unrecorded initializer-owned orphan is retained with unknown readiness and never reused as complete', async () => {
  const root = repo(); const ws = stream(); const existing = manager(root, 'contract-A');
  const acquired = await existing.ensureWorktree(ws, ws.items[0]!);
  const resumed = stream(); const recovering = createWorktreeIsolationManager({ projectRoot: root, stateNamespace: 'contract-A', emit: () => undefined,
    initializeWorktree: worktree => worktree.create() });
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(acquired.path); expect(resumed.items[0]!.worktreeInitialized).toBe(false);
  await expect(recovering.ensureWorktree(resumed, resumed.items[0]!)).rejects.toThrow('requires recovery');
  expect(existsSync(acquired.path)).toBe(true);
});


test('generated namespace avoids card-shaped path material without relaxing user path guards', () => {
  const namespace = 'ctr-797d133b';
  const digest = createHash('sha256').update(namespace).digest('hex');
  expect(digest).toBe('75888a99b1bb430d24ec6e5252254e24cc576655375279564e8a22060a15fff8');
  const root = '/tmp/namespace-regression';
  const legacy = join(root, '.goodvibes', '.worktrees', 'ws-ns', digest, 'g1', 'u1', 'src', 'csv.ts');
  const oldBoundary = judgmentInputBoundary('read', { path: legacy }, root);
  expect(oldBoundary.passed).toBe(false);
  expect(oldBoundary.checks[0]?.detail).toBe('card-material');
  const generated = join(root, '.goodvibes', '.worktrees', itemWorktreeBranch('g1', 'u1', namespace), 'src', 'csv.ts');
  expect(judgmentInputBoundary('read', { path: generated }, root).passed).toBe(true);
  const syntheticCard = ['4111', '1111', '1111', '1111'].join('');
  const userPath = join(generated, '..', `${syntheticCard}.txt`);
  const userBoundary = judgmentInputBoundary('read', { path: userPath }, root);
  expect(userBoundary.passed).toBe(false);
  expect(userBoundary.checks[0]?.detail).toBe('card-material');
});


function legacyHexResource(root: string, namespace: string) {
  const branch = `ws-ns/${createHash('sha256').update(namespace).digest('hex')}/g1/u1`;
  const path = join(root, '.goodvibes', '.worktrees', branch);
  git(root, 'worktree', 'add', '-q', '-b', branch, path);
  return { path, branch };
}

test.each(['both', 'path-only', 'branch-only'] as const)('recorded hex namespace %s identity is retained without rename', async mode => {
  const root = repo(); const own = legacyHexResource(root, 'ctr-797d133b'); const resumed = stream();
  if (mode !== 'branch-only') resumed.items[0]!.worktreePath = own.path;
  if (mode !== 'path-only') resumed.items[0]!.worktreeBranch = own.branch;
  const recovering = manager(root, 'ctr-797d133b'); recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeBranch).toBe(own.branch);
  expect((await recovering.ensureWorktree(resumed, resumed.items[0]!)).path).toBe(own.path);
  // Keeping an old identity does not bypass the existing raw input guard.
  expect(judgmentInputBoundary('read', { path: join(own.path, 'seed.txt') }, root).passed).toBe(false);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false);
});

test('unrecorded hex recovery is exact-namespace scoped and preserves unrelated resources', async () => {
  const root = repo(); const own = legacyHexResource(root, 'contract-A'); const foreign = legacyHexResource(root, 'contract-B');
  const newForeignStream = stream(); const newForeign = await manager(root, 'contract-C').ensureWorktree(newForeignStream, newForeignStream.items[0]!);
  const legacyStream = stream(); const legacy = await manager(root).ensureWorktree(legacyStream, legacyStream.items[0]!);
  const resumed = stream(); const events: OrchestrationEvent[] = []; const recovering = manager(root, 'contract-A', events);
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeBranch).toBe(own.branch);
  expect(events.filter(event => event.type === 'orphan-worktree-reconciled')).toEqual([
    expect.objectContaining({ path: own.path, disposition: 'adopted' }),
  ]);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(foreign.path)).toBe(true);
  expect(existsSync(newForeign.path)).toBe(true); expect(existsSync(legacy.path)).toBe(true);
});

test('unrecorded hex custom-initializer orphan retains unknown readiness', async () => {
  const root = repo(); const own = legacyHexResource(root, 'contract-A'); const resumed = stream();
  const recovering = createWorktreeIsolationManager({ projectRoot: root, stateNamespace: 'contract-A', emit: () => undefined,
    initializeWorktree: worktree => worktree.create() });
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeInitialized).toBe(false);
  await expect(recovering.ensureWorktree(resumed, resumed.items[0]!)).rejects.toThrow('requires recovery');
  expect(existsSync(own.path)).toBe(true);
});

test('recorded hex resource wins over an unrecorded new spelling', async () => {
  const root = repo(); const own = legacyHexResource(root, 'contract-A'); const fresh = stream();
  const extra = await manager(root, 'contract-A').ensureWorktree(fresh, fresh.items[0]!);
  const resumed = stream(); Object.assign(resumed.items[0]!, { worktreePath: own.path, worktreeBranch: own.branch });
  const events: OrchestrationEvent[] = []; const recovering = manager(root, 'contract-A', events); recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBe(own.path); expect(resumed.items[0]!.worktreeBranch).toBe(own.branch);
  expect(events.filter(event => event.type === 'orphan-worktree-reconciled')).toEqual([
    expect.objectContaining({ path: extra.path, disposition: 'reported' }),
  ]);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(own.path)).toBe(false); expect(existsSync(extra.path)).toBe(true);
});

test('two unrecorded namespace spellings remain ambiguous and are never adopted by listing order', async () => {
  const root = repo(); const old = legacyHexResource(root, 'contract-A'); const fresh = stream();
  const next = await manager(root, 'contract-A').ensureWorktree(fresh, fresh.items[0]!);
  const resumed = stream(); const events: OrchestrationEvent[] = []; const recovering = manager(root, 'contract-A', events);
  recovering.reconcileOrphans(resumed);
  expect(resumed.items[0]!.worktreePath).toBeUndefined(); expect(resumed.items[0]!.worktreeBranch).toBeUndefined();
  expect(events.filter(event => event.type === 'orphan-worktree-reconciled').map(event => 'disposition' in event ? event.disposition : null)).toEqual(['reported', 'reported']);
  await recovering.cleanupTerminated(resumed, resumed.items[0]!); await recovering.join();
  expect(existsSync(old.path)).toBe(true); expect(existsSync(next.path)).toBe(true);
});

test('actual read owner allows encoded namespace but still denies card material and owner path rules', async () => {
  const root = repo(); const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.mode', 'custom'); config.set('permissions.tools.read', 'allow');
  const store = new UserPermissionRuleStore(':memory:');
  const permission = new PermissionManager(async () => { throw new Error('read access must not prompt'); },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, { isEnabled: () => true }, store);
  const path = join(root, '.goodvibes', '.worktrees', itemWorktreeBranch('g1', 'u1', 'ctr-797d133b'), 'src', 'csv.ts');
  expect(await permission.readAccess(path)).toBe('allow');
  const syntheticCard = ['4111', '1111', '1111', '1111'].join('');
  expect(await permission.readAccess(join(path, '..', `${syntheticCard}.txt`))).toBe('restricted');
  await store.add({ rule: { id: 'deny-encoded-member-source', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [path] },
    createdAt: Date.now(), tier: 'path', tool: 'read' });
  expect(await permission.readAccess(path)).toBe('restricted');
  expect(await permission.readAccess(join(path, '..', 'other.ts'))).toBe('allow');
});
