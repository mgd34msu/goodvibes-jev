/** Real runner/manager/engine admission and conservative apply-back over temporary Git repositories. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contractInputPath } from '../../sdk/src/platform/contract/input-snapshot.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { plannerOutput } from './plan-support.js';
import { finishes, git, terminal } from './steps-support.js';

const extraRoots: string[] = [];
let harness: Harness | undefined;
afterEach(() => { harness?.dispose(); harness = undefined; for (const root of extraRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const stale of [false, true]) {
  test(`${stale ? 'stale clean' : 'dirty'} owner input is retained with zero automatic apply/index/history writes`, async () => {
    let ownerAtApply = '';
    let indexAtApply: Buffer<ArrayBuffer>;
    let headAtApply = '';
    const plan = oneUnitPlan(1);
    const h = harness = makeHarness({ plan, contract: { isolation: 'worktree' }, scripts: { u1: finishes('export const parse = 10;') }, planner: {
      async run(request) {
        if (stale) writeFileSync(join(h.root, 'README.md'), 'owner edited after capture\n');
        ownerAtApply = readFileSync(join(h.root, 'README.md'), 'utf8'); indexAtApply = readFileSync(join(h.root, '.git/index')); headAtApply = git(h.root, 'rev-parse', 'HEAD');
        expect(readFileSync(join(request.workingDir, 'README.md'), 'utf8')).toBe(stale ? '# demo\n' : 'dirty owner input\n');
        return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
      },
    } });
    if (!stale) writeFileSync(join(h.root, 'README.md'), 'dirty owner input\n');
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'retained result', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.status).toBe('passed'); expect(done.commit?.status).toBe('failed'); expect(done.commit?.note).toStartWith('not applied:');
    expect(done.commit?.note).toContain(stale ? 'owner changed' : 'pre-existing owner changes');
    expect(done.statusLine).toContain('; not applied:');
    expect(h.manager.getStatus(done.ownerAgentId)?.progress).toBe(done.statusLine);
    expect(h.events.find((event) => event.type === 'CONTRACT_COMMITTED')).toMatchObject({ status: 'failed', note: done.commit!.note });
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe(ownerAtApply);
    expect(readFileSync(join(h.root, '.git/index'))).toEqual(indexAtApply!); expect(git(h.root, 'rev-parse', 'HEAD')).toBe(headAtApply);
    expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(false);
    expect(readFileSync(join(done.worktreePath!, 'src/csv.ts'), 'utf8')).toBe('export const parse = 10;\n');
    expect(existsSync(contractInputPath(done.inputSnapshot!))).toBe(true);
  }, 20_000);
}

test('map, planner and member share captured dirty bytes after owner changes; cancellation retains receipt and both views', async () => {
  const original = 'dirty admitted input\n';
  const observed: string[] = [];
  const plan = oneUnitPlan(1);
  const h = harness = makeHarness({ plan, contract: { isolation: 'worktree' },
    repositoryMap: async (root) => { observed.push(readFileSync(join(root, 'README.md'), 'utf8')); writeFileSync(join(h.root, 'README.md'), 'later owner edit\n'); return 'captured map'; },
    planner: { async run(request) { observed.push(readFileSync(join(request.workingDir, 'README.md'), 'utf8')); return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 }; } },
    scripts: { u1: (record) => { observed.push(readFileSync(join(record.workingDirectory!, 'README.md'), 'utf8')); return [{ text: 'hold', stop: { kind: 'hang' } }]; } },
  });
  writeFileSync(join(h.root, 'README.md'), original);
  const { contract } = startContract(h);
  await waitFor(() => observed.length === 3, 'member admission', 15_000);
  const before = h.store.get(contract.id)!; const receipt = structuredClone(before.inputSnapshot!);
  expect(observed).toEqual([original, original, original]);
  expect(readFileSync(join(before.worktreePath!, 'README.md'), 'utf8')).toBe(original);
  h.runner.cancel(contract.id, 'test cancellation'); h.store.write(contract.id);
  expect(h.store.load(contract.id)?.inputSnapshot).toEqual(receipt);
  expect(existsSync(before.worktreePath!)).toBe(true); expect(existsSync(contractInputPath(receipt))).toBe(true);
  expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('later owner edit\n');
}, 20_000);

test('cancel during capture starts no map, shape/planner or member', async () => {
  let calls = 0;
  const h = harness = makeHarness({ contract: { isolation: 'worktree' }, scripts: {}, repositoryMap: async () => { calls++; return ''; }, planner: { async run() { calls++; return { status: 'failed', output: '', elapsedMs: 0 }; } } });
  const { contract } = startContract(h);
  h.runner.cancel(contract.id, 'cancel admission');
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.store.get(contract.id)?.status).toBe('cancelled'); expect(calls).toBe(0); expect(h.agentsOf('u1')).toEqual([]);
  expect(h.events.some((event) => event.type === 'CONTRACT_SHAPED')).toBe(false);
});


test('restart during planning reuses the recorded generation despite later owner edits', async () => {
  const root = makeRepo(); extraRoots.push(root);
  let plannerStarted = false;
  const plan = oneUnitPlan(1);
  const first = makeHarness({ root, plan, contract: { isolation: 'worktree' }, scripts: {}, planner: { run: async () => { plannerStarted = true; return new Promise(() => undefined); } } });
  const { contract } = startContract(first);
  await waitFor(() => plannerStarted, 'first planner', 15_000);
  const receipt = structuredClone(first.store.get(contract.id)!.inputSnapshot!);
  first.store.write(contract.id); first.dispose();
  writeFileSync(join(root, 'README.md'), 'owner changed during restart\n');
  const seen: string[] = [];
  const second = harness = makeHarness({ root, plan, contract: { isolation: 'worktree' }, scripts: { u1: finishes('export const parse = 12;') }, planner: {
    async run(request) { seen.push(readFileSync(join(request.workingDir, 'README.md'), 'utf8')); return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 }; },
  } });
  const report = await second.runner.resumeAll();
  expect(report.resumed).toEqual([{ contractId: contract.id, step: 'plan' }]);
  await waitFor(() => terminal(second, contract.id), 'resumed result', 15_000);
  const done = second.store.get(contract.id)!;
  expect(seen).toEqual(['# demo\n']); expect(done.inputSnapshot).toEqual(receipt);
  expect(done.commit?.note).toStartWith('not applied:'); expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('owner changed during restart\n');
}, 20_000);

test('legacy worktree records do not invent a receipt or silently capture current source', async () => {
  const { findZombieCause } = await import('../../sdk/src/platform/contract/resume.js');
  const { makeContract } = await import('./fixtures.js');
  expect(findZombieCause(makeContract({ schemaVersion: 1, isolation: 'worktree', status: 'planning' }))).toContain('no recorded input receipt');
  expect(findZombieCause(makeContract({ schemaVersion: 2, isolation: 'worktree', status: 'planning' }))).toContain('no recorded input receipt');
});

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']) {
  test(`active owner ${marker} holds capture and is never removed`, async () => {
    let calls = 0;
    const h = harness = makeHarness({ contract: { isolation: 'worktree' }, scripts: {}, planner: { async run() { calls++; return { status: 'failed', output: '', elapsedMs: 0 }; } } });
    const path = join(h.root, '.git', marker);
    writeFileSync(path, 'synthetic owner operation\n');
    const index = readFileSync(join(h.root, '.git/index')); const head = git(h.root, 'rev-parse', 'HEAD');
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'held admission');
    expect(h.store.get(contract.id)?.error).toContain('active owner Git operation');
    expect(calls).toBe(0); expect(readFileSync(path, 'utf8')).toBe('synthetic owner operation\n');
    expect(readFileSync(join(h.root, '.git/index'))).toEqual(index); expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
  });
}

test('a real pending empty owner merge after capture is held without aborting the owner operation', async () => {
  const plan = oneUnitPlan(1); let mergeHead = ''; let index: Buffer<ArrayBuffer>;
  const h = harness = makeHarness({ plan, contract: { isolation: 'worktree' }, scripts: { u1: finishes('export const parse = 10;') }, planner: {
    async run() {
      const tree = git(h.root, 'rev-parse', 'HEAD^{tree}').trim();
      mergeHead = git(h.root, 'commit-tree', tree, '-p', 'HEAD', '-m', 'synthetic owner empty commit').trim();
      git(h.root, 'merge', '--no-commit', '--no-ff', mergeHead);
      expect(readFileSync(join(h.root, '.git/MERGE_HEAD'), 'utf8').trim()).toBe(mergeHead);
      index = readFileSync(join(h.root, '.git/index'));
      return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
    },
  } });
  const head = git(h.root, 'rev-parse', 'HEAD');
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'held apply', 15_000);
  const done = h.store.get(contract.id)!;
  expect(readFileSync(join(h.root, '.git/MERGE_HEAD'), 'utf8').trim()).toBe(mergeHead);
  expect(done.commit?.status).toBe('failed'); expect(done.commit?.note).toContain('not applied: active owner Git operation');
  expect(readFileSync(join(h.root, '.git/index'))).toEqual(index!); expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(done.worktreePath!)).toBe(true); expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(false);
}, 20_000);



test('a failed merge after the final check retains concurrent owner writes and its Git state for inspection', async () => {
  const h = harness = makeHarness({ plan: oneUnitPlan(1), contract: { isolation: 'worktree' }, scripts: { u1: finishes('export const parse = 10;') } });
  const hook = join(h.root, '.git/hooks/pre-merge-commit');
  // Member integration can fast-forward. The owner's no-ff commit reaches this real hook after the readset check.
  writeFileSync(hook, '#!/bin/sh\nprintf "%s\\n" "owner write during final merge" > README.md\nexit 1\n');
  chmodSync(hook, 0o755);
  const head = git(h.root, 'rev-parse', 'HEAD');
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'failed merge without owner rollback', 15_000);
  const done = h.store.get(contract.id)!;
  expect(done.status).toBe('passed'); expect(done.commit?.status).toBe('failed');
  expect(existsSync(join(h.root, '.git/MERGE_HEAD'))).toBe(true);
  expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('owner write during final merge\n');
  expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(done.commit?.note).toContain('inspect owner Git state'); expect(existsSync(done.worktreePath!)).toBe(true);
}, 20_000);

test('an owner index lock created after capture holds apply without deleting the lock or changing the index', async () => {
  const plan = oneUnitPlan(1); let index: Buffer<ArrayBuffer>;
  const h = harness = makeHarness({ plan, contract: { isolation: 'worktree', autoCommit: false }, scripts: { u1: finishes('export const parse = 10;') }, planner: {
    async run() {
      writeFileSync(join(h.root, '.git/index.lock'), 'owner lock\n'); index = readFileSync(join(h.root, '.git/index'));
      return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
    },
  } });
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'held apply', 15_000);
  const done = h.store.get(contract.id)!;
  expect(done.commit?.note).toContain('not applied: active owner Git operation index.lock');
  expect(readFileSync(join(h.root, '.git/index.lock'), 'utf8')).toBe('owner lock\n');
  expect(readFileSync(join(h.root, '.git/index'))).toEqual(index!);
  expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(false); expect(existsSync(done.worktreePath!)).toBe(true);
}, 20_000);
