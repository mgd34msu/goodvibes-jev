import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uptime } from 'node:os';
import { captureContractInput, contractInputPath, materializeContractInput, restoreContractInputDevice, type ContractInputSnapshot } from '../../sdk/src/platform/contract/input-snapshot.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function capturedBeforeBoot() {
  const root = makeRepo(); roots.push(root);
  const actual = await captureContractInput(root);
  const view = contractInputPath(actual);
  mkdirSync(join(root, '.goodvibes/.worktrees/contract-input'), { recursive: true });
  git(root, 'worktree', 'add', '--no-checkout', '-b', `contract-input/${actual.id}`, view, actual.inputCommit);
  await materializeContractInput(actual, view);
  const device = actual.sourceIdentity.split(':')[0]!;
  const previousDevice = String(BigInt(device) + 100000n);
  const replace = (value: string) => value.startsWith(`${device}:`) ? previousDevice + value.slice(device.length) : value;
  const saved: ContractInputSnapshot = {
    ...actual,
    capturedAt: Date.now() - uptime() * 1000 - 60000,
    sourceIdentity: replace(actual.sourceIdentity),
    gitIdentity: actual.gitIdentity.split('|').map(replace).join('|'),
    files: actual.files.map(file => file.identity === undefined ? file : { ...file, identity: replace(file.identity) }),
  };
  return { root, actual, saved, view };
}

test('device renumbering after boot retains the exact generation after full source and view verification', async () => {
  const f = await capturedBeforeBoot();
  const index = readFileSync(join(f.root, '.git/index'));
  const restored = await restoreContractInputDevice(f.saved);
  expect(restored).toEqual({ ...f.actual, capturedAt: f.saved.capturedAt });
  expect(f.saved.sourceIdentity).not.toBe(restored.sourceIdentity);
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
});

test('an unchanged root keeps its existing receipt without recapturing later owner edits', async () => {
  const f = await capturedBeforeBoot();
  writeFileSync(join(f.root, 'README.md'), 'owner edit after capture\n');
  expect(await restoreContractInputDevice(f.actual)).toBe(f.actual);
});

for (const mutation of ['source', 'view', 'root-inode', 'git-inode', 'same-boot'] as const) {
  test(`device recovery refuses ${mutation} changes`, async () => {
    const f = await capturedBeforeBoot();
    let saved = f.saved;
    if (mutation === 'source') writeFileSync(join(f.root, 'README.md'), 'different source\n');
    if (mutation === 'view') writeFileSync(join(f.view, 'README.md'), 'different captured view\n');
    if (mutation === 'root-inode') saved = { ...saved, sourceIdentity: saved.sourceIdentity.replace(/:\d+$/, ':999999999999') };
    if (mutation === 'git-inode') saved = { ...saved, gitIdentity: saved.gitIdentity.replace(/:\d+(?=\||$)/g, ':999999999999') };
    if (mutation === 'same-boot') saved = { ...saved, capturedAt: Date.now() };
    await expect(restoreContractInputDevice(saved)).rejects.toThrow();
  });
}
