import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { assertContractInputReadAccess, authorizeContractInputPath, createContractInputAuthority, withContractInputReadBatch } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'captured-read-sweep-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  for (let index = 0; index < 16; index++) writeFileSync(join(root, `file${index}.ts`), `export const value = ${index};\n`);
  git('add', '.'); git('commit', '-qm', 'fixture');
  const snapshot = await captureContractInput(root);
  const view = contractInputPath(snapshot);
  git('worktree', 'add', '--no-checkout', '-b', 'captured-fixture', view, snapshot.inputCommit);
  await materializeContractInput(snapshot, view);
  const contract = { projectRoot: root, inputSnapshot: snapshot } as Contract;
  const authority = await createContractInputAuthority(contract, view);
  return { root, view, authority, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('provider read sweeps overlap bounded checks and re-read current deny rules', async () => {
  const f = await fixture();
  try {
    const paths = Array.from({ length: 16 }, (_, index) => join(f.view, `file${index}.ts`));
    await withContractInputReadBatch(f.authority, async () => {
      for (const path of paths) await authorizeContractInputPath(f.authority, path, async () => true);
    });
    let active = 0, peak = 0, calls = 0;
    const filter = async () => {
      calls++; active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, 2)); return true; }
      finally { active--; }
    };
    await assertContractInputReadAccess(f.authority, filter);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(calls).toBe(32); // Both the original-owner and captured paths.
    expect(active).toBe(0);
    await expect(assertContractInputReadAccess(f.authority, async path => !path.endsWith('file0.ts'))).rejects.toThrow('restricted');
    calls = 0;
    await assertContractInputReadAccess(f.authority, filter);
    expect(calls).toBe(32); // No read grant survived the preceding sweep.
  } finally { f.dispose(); }
});

test('a read discovered during the final batch is checked before provider delivery', async () => {
  const f = await fixture();
  try {
    await authorizeContractInputPath(f.authority, join(f.view, 'file0.ts'), async () => true);
    let added = false;
    const seen: string[] = [];
    await assertContractInputReadAccess(f.authority, async path => {
      seen.push(path);
      if (!added) {
        added = true;
        await authorizeContractInputPath(f.authority, join(f.view, 'file1.ts'), async () => true);
      }
      return true;
    });
    expect(seen).toContain(join(f.root, 'file1.ts'));
    expect(seen).toContain(join(f.view, 'file1.ts'));
  } finally { f.dispose(); }
});
