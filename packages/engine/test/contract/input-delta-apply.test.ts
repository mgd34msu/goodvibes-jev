import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeEventOfNotice } from '../../sdk/src/platform/runtime/bootstrap-runtime-events.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { finishes, git, terminal } from './steps-support.js';
import { plannerOutput } from './plan-support.js';

let harness: Harness | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

for (const autoCommit of [false, true]) {
  test(`dirty owner delta is delivered with truthful uncommitted receipt (autoCommit=${autoCommit})`, async () => {
    const h = (harness = makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'worktree', autoCommit },
      scripts: { u1: finishes('export const parse = 42;') },
    }));
    git(h.root, 'config', 'diff.noprefix', 'true');
    git(h.root, 'config', 'color.diff', 'always');
    writeFileSync(join(h.root, 'README.md'), 'owner staged text\n');
    git(h.root, 'add', 'README.md');
    writeFileSync(join(h.root, 'README.md'), 'owner unstaged text\n');
    writeFileSync(join(h.root, 'notes.txt'), 'owner untracked text\n');
    const index = readFileSync(join(h.root, '.git/index'));
    const head = git(h.root, 'rev-parse', 'HEAD');
    const staged = git(h.root, 'diff', '--cached', '--binary');
    const { contract } = startContract(h);
    await waitFor(() => terminal(h, contract.id), 'dirty input delivery', 15_000);
    const done = h.store.get(contract.id)!;
    expect(done.commit?.status).toBe('applied');
    expect(done.commit?.hash).toBeUndefined();
    expect(done.commit?.note).toContain('uncommitted');
    expect(done.commit?.note.includes('automatic commit deferred')).toBe(autoCommit);
    expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf8')).toBe('export const parse = 42;\n');
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('owner unstaged text\n');
    expect(readFileSync(join(h.root, 'notes.txt'), 'utf8')).toBe('owner untracked text\n');
    expect(readFileSync(join(h.root, '.git/index'))).toEqual(index);
    expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(h.root, 'diff', '--cached', '--binary')).toBe(staged);
    const event = h.events.find((item) => item.type === 'CONTRACT_COMMITTED');
    expect(event).toMatchObject({ status: 'applied', note: done.commit!.note });
    expect(event && 'hash' in event ? event.hash : undefined).toBeUndefined();
    expect(runtimeEventOfNotice(`[Contract] Commit applied for ${done.id}: ${done.commit!.note}`)?.title).toBe(
      'Changes applied',
    );
    expect(h.manager.getStatus(done.ownerAgentId)?.progress).toBe(done.statusLine);
    expect(done.statusLine).toContain('uncommitted');
  }, 20_000);
}

test('conflicting later owner edit retains both owner and contract result without staging or history changes', async () => {
  const plan = oneUnitPlan(1);
  const h = (harness = makeHarness({
    plan,
    contract: { isolation: 'worktree' },
    scripts: { u1: finishes('contract replacement') },
    planner: {
      async run() {
        writeFileSync(join(h.root, 'src/csv.ts'), 'owner later replacement\n');
        return { status: 'completed', output: plannerOutput(plan), elapsedMs: 0 };
      },
    },
  }));
  mkdirSync(join(h.root, 'src'), { recursive: true });
  writeFileSync(join(h.root, 'src/csv.ts'), 'owner admitted dirty version\n');
  const index = readFileSync(join(h.root, '.git/index'));
  const head = git(h.root, 'rev-parse', 'HEAD');
  const { contract } = startContract(h);
  await waitFor(() => terminal(h, contract.id), 'conflicting dirty input hold', 15_000);
  const done = h.store.get(contract.id)!;
  expect(done.commit?.status).toBe('failed');
  expect(done.commit?.note).toContain('not applied:');
  expect(done.commit?.note).toContain('owner changed');
  expect(readFileSync(join(h.root, 'src/csv.ts'), 'utf8')).toBe('owner later replacement\n');
  expect(readFileSync(join(done.worktreePath!, 'src/csv.ts'), 'utf8')).toBe('contract replacement\n');
  expect(readFileSync(join(h.root, '.git/index'))).toEqual(index);
  expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
  expect(existsSync(join(h.root, '.git/MERGE_HEAD'))).toBe(false);
}, 20_000);

for (const boundary of ['restricted', 'cancelled'] as const) {
  test(`dirty apply checks ${boundary} original authority before changing owner files`, async () => {
    let armed = false;
    let contractId = '';
    const h = (harness = makeHarness({
      plan: oneUnitPlan(1),
      contract: { isolation: 'worktree' },
      scripts: {
        u1: () => {
          armed = true;
          return [{ files: { 'src/csv.ts': 'contract output\n' }, text: 'contract output' }];
        },
      },
      readAccessFilter: async (path) => {
        if (armed && path === join(h.root, 'src/csv.ts')) {
          if (boundary === 'cancelled') h.runner.cancel(contractId, 'owned apply cancellation');
          await Promise.resolve();
          return boundary !== 'restricted';
        }
        return true;
      },
    }));
    writeFileSync(join(h.root, 'README.md'), 'owner dirty context\n');
    const index = readFileSync(join(h.root, '.git/index'));
    const head = git(h.root, 'rev-parse', 'HEAD');
    contractId = startContract(h).contract.id;
    await waitFor(() => terminal(h, contractId), 'authority hold', 15_000);
    await h.runner.join(contractId);
    expect(existsSync(join(h.root, 'src/csv.ts'))).toBe(false);
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('owner dirty context\n');
    expect(readFileSync(join(h.root, '.git/index'))).toEqual(index);
    expect(git(h.root, 'rev-parse', 'HEAD')).toBe(head);
    const done = h.store.get(contractId)!;
    if (boundary === 'restricted') expect(done.commit?.note).toContain('access-restricted');
    else expect(done.status).toBe('cancelled');
  }, 20_000);
}
