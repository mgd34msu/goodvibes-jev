import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureContractInput,
  contractInputPath,
  materializeContractInput,
} from '../sdk/src/platform/contract/input-snapshot.js';
import {
  createContractInputAuthority,
  revokeContractInputAuthority,
} from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';

for (const kind of ['snapshot', 'member'] as const) {
  test(`retained ${kind} remains protected in a fresh ordinary Agent process`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'retained-input-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', root, ...args]);
      expect(result.status, result.stderr.toString()).toBe(0);
    };
    try {
      git('init', '-q');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
      writeFileSync(join(root, 'private.ts'), 'export const SYNTHETIC_PRIVATE_MARKER = 1;\n');
      writeFileSync(join(root, 'allowed.ts'), 'export const SYNTHETIC_ALLOWED_MARKER = 1;\n');
      git('add', '.');
      git('commit', '-qm', 'fixture');
      const snapshot = await captureContractInput(root);
      const view =
        kind === 'snapshot'
          ? contractInputPath(snapshot)
          : join(root, '.goodvibes', '.worktrees', 'contract', 'member-fixture');
      const branch = `${kind}-fixture`;
      git('worktree', 'add', '--no-checkout', '-b', branch, view, snapshot.inputCommit);
      await materializeContractInput(snapshot, view);
      const authority = await createContractInputAuthority(
        { inputSnapshot: snapshot, projectRoot: root } as Contract,
        view,
        { mutable: kind === 'member', branch },
      );
      revokeContractInputAuthority(authority);
      const alias = join(root, 'view-alias');
      symlinkSync(view, alias, 'dir');
      const reader = fileURLToPath(new URL('./fixtures/contract-input/retained-reader.ts', import.meta.url));
      const result = spawnSync(process.execPath, [reader, root, view, alias], {
        encoding: 'utf8',
        timeout: 20_000,
        env: process.env,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('ordinary allowed content delivered');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
