import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertContractInputObjects, assertContractInputView, captureContractInput, contractInputPath, createContractInputViewAssertion, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { assertContractInputReadAccess, authorizeContractInputPath, createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import type { ReadAccessFilter } from '../sdk/src/platform/tools/shared/read-access.js';

const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  const results = await Promise.allSettled([...cleanups].map(cleanup => cleanup()));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'manifest fixture cleanup failed');
});

async function fixture(options: { count?: number; custom?: boolean; symlink?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'input-manifest-proof-'));
  const stop = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const restorers: (() => void)[] = [];
  const extraRoots: string[] = [];
  let token: Awaited<ReturnType<typeof createContractInputAuthority>> | undefined;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    stop.abort(new Error('manifest fixture disposed'));
    await Promise.allSettled([...pending]);
    const errors: unknown[] = [];
    for (const restore of restorers.splice(0).reverse()) try { restore(); } catch (error) { errors.push(error); }
    try { if (token) revokeContractInputAuthority(token); } catch (error) { errors.push(error); }
    for (const path of [root, ...extraRoots]) try { rmSync(path, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    cleanups.delete(cleanup);
    if (errors.length) throw new AggregateError(errors, 'manifest fixture cleanup failed');
  };
  cleanups.add(cleanup);
  const own = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  try {
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args]);
      expect(result.status, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    const files = options.count ? Array.from({ length: options.count }, (_, i) => `file-${String(i).padStart(3, '0')}.txt`) : ['a.txt', 'b.txt', 'unrelated.txt'];
    for (const file of files) writeFileSync(join(root, file), `${file}\n`.padEnd(4096, 'x'));
    if (options.symlink) symlinkSync(files[0]!, join(root, 'alias.txt'));
    git('add', '.'); git('commit', '-qm', 'manifest proof inputs');
    const receipt = await own(captureContractInput(root, { signal: stop.signal }));
    const view = contractInputPath(receipt);
    git('worktree', 'add', '--no-checkout', '-b', 'manifest-view', view, receipt.inputCommit);
    await own(materializeContractInput(receipt, view, stop.signal));
    const contract = { inputSnapshot: receipt, projectRoot: root } as Contract;
    const custom = { calls: 0, rejectAt: Number.POSITIVE_INFINITY };
    token = await own(createContractInputAuthority(contract, view, { signal: stop.signal,
      ...(options.custom ? { assertView: async () => {
        custom.calls++;
        if (custom.calls === custom.rejectAt) throw new Error('custom view callback refused');
        await assertContractInputView(receipt, stop.signal, view);
      } } : {}),
    }));
    const authority = token;
    return { root, view, files, receipt, contract, stop, custom, git, cleanup, extraRoots, restorers, own,
      authorize: (file: string, filter: ReadAccessFilter = async () => true) => own(authorizeContractInputPath(authority, join(view, file), filter, stop.signal)),
      deliver: (filter: ReadAccessFilter = async () => true) => own(assertContractInputReadAccess(authority, filter, stop.signal)),
    };
  } catch (error) { await cleanup(); throw error; }
}

for (const count of [16, 32]) test(`owned immutable manifest eliminates repeated expected-table preparation (${count} paths)`, async () => {
  const f = await fixture({ count });
  let sorts = 0; let indexes = 0;
  const present = f.receipt.files.filter(file => file.kind !== 'missing');
  const expectedPaths = new Set(present.map(file => file.path));
  try {
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = new Proxy(originalSort, { apply(sort, receiver, args) {
      if (Array.isArray(receiver) && receiver.length === present.length && receiver.every(row => typeof row === 'string' && /^\d+ blob [a-f0-9]+\t/.test(row))) sorts++;
      return Reflect.apply(sort, receiver, args) as ReturnType<typeof originalSort>;
    } });
    f.restorers.push(() => { Array.prototype.sort = originalSort; });
    const OriginalMap = globalThis.Map;
    globalThis.Map = new Proxy(OriginalMap, { construct(MapClass, args, newTarget) {
      const entries: unknown = args[0];
      if (Array.isArray(entries) && entries.length === present.length && entries.every((entry: unknown) => {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !expectedPaths.has(entry[0])) return false;
        const value: unknown = entry[1];
        return value !== null && typeof value === 'object' && 'path' in value && value.path === entry[0] && 'kind' in value;
      })) indexes++;
      return Reflect.construct(MapClass, args, newTarget) as object;
    } });
    f.restorers.push(() => { globalThis.Map = OriginalMap; });
    let policies = 0;
    const filter = async () => { policies++; await Promise.resolve(); return true; };
    for (const file of f.files) await f.authorize(file, filter);
    const admission = { policies, sorts, indexes };
    sorts = 0; indexes = 0; policies = 0;
    await f.deliver(filter);
    const delivery = { policies, sorts, indexes };
    console.log(JSON.stringify({ count, admission, delivery }));
    for (const phase of [admission, delivery]) {
      expect(phase.policies).toBe(2 * count);
      // Actual Git output is still freshly sorted at both live validation points.
      expect(phase.sorts).toBe(2 * count); expect(phase.indexes).toBe(0);
    }
    // Standalone callers retain fresh receipt-derived expectations.
    sorts = 0; indexes = 0;
    assertContractInputObjects(f.receipt, f.root);
    expect(sorts).toBe(2); expect(indexes).toBe(1);
  } finally { await f.cleanup(); }
}, 30_000);

test('an intermediate unrelated-file mutation holds before a later callback can restore it', async () => {
  const f = await fixture();
  try {
    await f.authorize('a.txt'); await f.authorize('b.txt');
    let restored = 0;
    await expect(f.deliver(async path => {
      if (path === join(f.root, 'a.txt')) writeFileSync(join(f.view, 'unrelated.txt'), 'changed between permission callbacks');
      if (path === join(f.root, 'b.txt')) { restored++; writeFileSync(join(f.view, 'unrelated.txt'), 'unrelated.txt\n'.padEnd(4096, 'x')); }
      await Promise.resolve();
      return true;
    })).rejects.toThrow('view changed');
    expect(restored).toBe(0);
  } finally { await f.cleanup(); }
});

for (const scenario of ['unrelated-before', 'target', 'extra-path', 'removed-path', 'original-alias', 'view-alias', 'source-root', 'view-root', 'receipt-replaced', 'receipt-mutated', 'cancel-owner', 'cancel-view', 'deny-owner', 'deny-view', 'callback-failure', 'final-file-change'] as const)
  test(`prepared immutable validation retains ${scenario} hold`, async () => {
    const f = await fixture();
    try {
      await f.authorize('a.txt'); await f.authorize('b.txt');
      if (scenario === 'unrelated-before') writeFileSync(join(f.view, 'unrelated.txt'), 'changed before delivery');
      if (scenario === 'receipt-replaced') f.contract.inputSnapshot = structuredClone(f.receipt);
      if (scenario === 'receipt-mutated') (f.receipt as { inputTree: string }).inputTree = '0'.repeat(40);
      let calls = 0;
      const policy: ReadAccessFilter = async path => {
        calls++;
        await Promise.resolve();
        const owner = path === join(f.root, 'a.txt');
        const actual = path === join(f.view, 'a.txt');
        if (owner && scenario === 'target') writeFileSync(join(f.view, 'a.txt'), 'changed target');
        if (owner && scenario === 'extra-path') writeFileSync(join(f.view, 'extra.txt'), 'not in the receipt');
        if (owner && scenario === 'removed-path') unlinkSync(join(f.view, 'unrelated.txt'));
        if (owner && scenario === 'original-alias') { unlinkSync(join(f.root, 'a.txt')); symlinkSync(join(f.root, 'b.txt'), join(f.root, 'a.txt')); }
        if (owner && scenario === 'view-alias') { unlinkSync(join(f.view, 'a.txt')); symlinkSync('b.txt', join(f.view, 'a.txt')); }
        if (owner && scenario === 'source-root') { const moved = `${f.root}-moved`; renameSync(f.root, moved); f.extraRoots.push(moved); mkdirSync(f.root); }
        if (owner && scenario === 'view-root') { const moved = `${f.view}-moved`; renameSync(f.view, moved); f.extraRoots.push(moved); mkdirSync(f.view); }
        if ((owner && scenario === 'cancel-owner') || (actual && scenario === 'cancel-view')) f.stop.abort(new Error('cancelled during permission await'));
        if ((owner && scenario === 'deny-owner') || (actual && scenario === 'deny-view')) return false;
        if (owner && scenario === 'callback-failure') throw new Error('policy callback failed');
        if (path === join(f.view, 'b.txt') && scenario === 'final-file-change') writeFileSync(join(f.view, 'unrelated.txt'), 'changed at final validation');
        return true;
      };
      await expect(f.deliver(policy)).rejects.toThrow();
      if (['unrelated-before', 'receipt-replaced', 'receipt-mutated'].includes(scenario)) expect(calls).toBe(0);
      else if (['cancel-owner', 'deny-owner', 'callback-failure'].includes(scenario)) expect(calls).toBe(1);
      else if (scenario === 'final-file-change') expect(calls).toBe(4);
      else expect(calls).toBe(2);
    } finally { await f.cleanup(); }
  });

test('owned manifest clones expectations while authority still watches the original receipt', async () => {
  const f = await fixture();
  try {
    const borrowed = structuredClone(f.receipt);
    const validate = createContractInputViewAssertion(borrowed, f.stop.signal, f.view);
    (borrowed as { inputTree: string }).inputTree = '0'.repeat(40);
    await f.own(validate());
    await expect(f.own(assertContractInputView(borrowed, f.stop.signal, f.view))).rejects.toThrow();
    (f.receipt as { inputTree: string }).inputTree = '0'.repeat(40);
    await expect(f.authorize('a.txt')).rejects.toThrow('receipt changed');
  } finally { await f.cleanup(); }
});

test('prepared symlink membership keeps exact live link validation and alias refusal', async () => {
  const f = await fixture({ symlink: true });
  try {
    await f.authorize('a.txt');
    await expect(f.authorize('alias.txt')).rejects.toThrow('symlink');
    unlinkSync(join(f.view, 'alias.txt')); symlinkSync('b.txt', join(f.view, 'alias.txt'));
    await expect(f.deliver()).rejects.toThrow('view changed');
  } finally { await f.cleanup(); }
});

test('custom corrective-view callbacks keep every pre-access and after-await invocation', async () => {
  const f = await fixture({ custom: true });
  try {
    await f.authorize('a.txt'); await f.authorize('b.txt');
    const before = f.custom.calls;
    await f.deliver();
    expect(f.custom.calls - before).toBe(4);
    f.custom.rejectAt = f.custom.calls + 2;
    let callbacks = 0;
    await expect(f.deliver(async () => { callbacks++; await Promise.resolve(); return true; })).rejects.toThrow('custom view callback refused');
    expect(callbacks).toBe(2);
  } finally { await f.cleanup(); }
});
