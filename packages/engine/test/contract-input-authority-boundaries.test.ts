import type { Contract } from '../sdk/src/platform/contract/types.js';
import type { ContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captureContractInput,
  materializeContractInput,
  contractInputPath,
} from '../sdk/src/platform/contract/input-snapshot.js';
import {
  createContractInputAuthority,
  authorizeContractInputPath,
  bindContractInputAuthority,
  getContractInputAuthority,
  revokeContractInputAuthority,
  assertContractInputAuthority,
} from '../sdk/src/platform/contract/input-authority.js';
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status) throw Error(r.stderr.toString());
}
async function fixture(
  fn: (context: {
    root: string;
    view: string;
    contract: Contract;
    abort: AbortController;
    token: ContractInputAuthority;
  }) => Promise<void>,
  mutable = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'pr56-independent-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    writeFileSync(join(root, 'a.txt'), 'synthetic-owned');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const receipt = await captureContractInput(root);
    const view = contractInputPath(receipt);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'fixture-view', view, receipt.inputCommit);
    await materializeContractInput(receipt, view);
    const contract = { inputSnapshot: receipt, projectRoot: root } as Contract;
    const abort = new AbortController();
    const token = await createContractInputAuthority(contract, view, {
      signal: abort.signal,
      mutable,
      branch: 'fixture-view',
    });
    await fn({ root, view, contract, abort, token });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('independent opaque binding and dual-path allow/deny', async () =>
  fixture(async ({ root, view, token }) => {
    const obj = {};
    bindContractInputAuthority(obj, token);
    expect(getContractInputAuthority(obj)).toBe(token);
    expect(getContractInputAuthority({ ...obj })).toBeUndefined();
    expect(() => bindContractInputAuthority({}, JSON.parse(JSON.stringify(token)))).toThrow();
    const seen: string[] = [];
    expect(
      await authorizeContractInputPath(token, 'a.txt', async (p) => {
        seen.push(p);
        return true;
      }),
    ).toBe(join(view, 'a.txt'));
    expect(seen).toEqual([join(root, 'a.txt'), join(view, 'a.txt')]);
    await expect(authorizeContractInputPath(token, 'a.txt', async (p) => p !== join(root, 'a.txt'))).rejects.toThrow();
    await expect(authorizeContractInputPath(token, 'a.txt', undefined)).rejects.toThrow();
  }));
test('independent revocation and cancellation during awaited permission', async () =>
  fixture(async ({ token, abort }) => {
    await expect(
      authorizeContractInputPath(token, 'a.txt', async () => {
        await Promise.resolve();
        abort.abort();
        return true;
      }),
    ).rejects.toThrow();
  }));
test('independent revoked token rejects delivery', async () =>
  fixture(async ({ token }) => {
    await expect(
      authorizeContractInputPath(token, 'a.txt', async () => {
        revokeContractInputAuthority(token);
        return true;
      }),
    ).rejects.toThrow();
  }));
test('independent outside/excluded/root mismatch hold', async () =>
  fixture(async ({ root, token }) => {
    for (const path of ['../a.txt', '.git/config', '.goodvibes/private.txt'])
      await expect(authorizeContractInputPath(token, path, async () => true)).rejects.toThrow();
    await expect(assertContractInputAuthority(token, root)).rejects.toThrow();
  }));
test('independent original symlink cannot borrow copied permission', async () =>
  fixture(async ({ root, token }) => {
    writeFileSync(join(root, 'other.txt'), 'synthetic alias');
    rmSync(join(root, 'a.txt'));
    symlinkSync('other.txt', join(root, 'a.txt'));
    await expect(authorizeContractInputPath(token, 'a.txt', async () => true)).rejects.toThrow();
  }));
test('independent cloned receipt is not the admitted generation', async () =>
  fixture(async ({ contract, token }) => {
    contract.inputSnapshot = structuredClone(contract.inputSnapshot);
    await expect(assertContractInputAuthority(token)).rejects.toThrow();
  }));
import { capturedInputTool, capturedInputReadFilter } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { ReadTool } from '../sdk/src/platform/tools/read/index.js';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';
test('independent tool argument mutation during permission await stays held', async () =>
  fixture(async ({ root, view, token }) => {
    const args = { files: [{ path: 'a.txt' }] };
    let changed = false;
    const filter = async (p: string) => {
      if (!changed && p === join(root, 'a.txt')) {
        args.files[0]!.path = '.gitignore';
        changed = true;
      }
      return p !== join(root, '.gitignore');
    };
    const delivered = new Set<string>();
    const guarded = capturedInputReadFilter(token, view, filter, undefined, delivered);
    const index = new ProjectIndex(view);
    try {
      const tool = capturedInputTool(
        new ReadTool(index, undefined, undefined, guarded),
        token,
        view,
        filter,
        undefined,
      );
      const result = await tool.execute(args);
      expect(result.success).toBe(true);
      expect(result.output).toContain('synthetic-owned');
      expect(result.output ? JSON.parse(result.output).files?.[0]?.content : '').not.toContain('.goodvibes/');
    } finally {
      await index.dispose();
    }
  }));
import { createWriteTool } from '../sdk/src/platform/tools/write/index.js';
test('independent write args remain pinned through permission callbacks', async () =>
  fixture(async ({ root, view, token }) => {
    const args = { files: [{ path: 'a.txt', content: 'synthetic authorized write', mode: 'overwrite' }] };
    let changed = false;
    const filter = async (p: string) => {
      if (!changed && p === join(root, 'a.txt')) {
        args.files[0]!.path = '.gitignore';
        changed = true;
      }
      return p !== join(root, '.gitignore');
    };
    const guarded = capturedInputReadFilter(token, view, filter, undefined, new Set<string>());
    const tool = capturedInputTool(
      createWriteTool({ projectRoot: view, capturedReadAccess: guarded }),
      token,
      view,
      filter,
      undefined,
    );
    const result = await tool.execute(args);
    expect(result.success).toBe(true);
    expect(readFileSync(join(view, '.gitignore'), 'utf8')).toBe('.goodvibes/\n');
    expect(readFileSync(join(view, 'a.txt'), 'utf8')).toBe('synthetic authorized write');
  }, true));
test('same-root mutable leases keep their own cancellation signals', async () =>
  fixture(async ({ contract, view, token }) => {
    const secondStop = new AbortController();
    const second = await createContractInputAuthority(contract, view, {
      signal: secondStop.signal,
      mutable: true,
      branch: 'fixture-view',
    });
    secondStop.abort();
    await expect(assertContractInputAuthority(second)).rejects.toThrow();
    await expect(authorizeContractInputPath(token, 'a.txt', async () => true)).resolves.toBe(join(view, 'a.txt'));
  }, true));
