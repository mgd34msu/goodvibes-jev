import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './runner-support.js';
import { captureContractInput, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import { pinContractInputAdmission } from '../../sdk/src/platform/contract/input-authority.js';
import { admitPublicationInput } from '../../sdk/src/platform/contract/publication-input.js';
import { applyCapturedInputDelta } from '../../sdk/src/platform/contract/input-apply.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture() {
  const root = makeRepo();
  const snapshot = await captureContractInput(root);
  const view = join(root, '.goodvibes/.worktrees/contract/publication');
  mkdirSync(join(root, '.goodvibes/.worktrees/contract'), { recursive: true });
  git(root, 'worktree', 'add', '--no-checkout', '-b', 'publication-result', view, snapshot.inputCommit);
  await materializeContractInput(snapshot, view);
  writeFileSync(join(view, 'review.md'), 'Accepted report.\n');
  git(view, 'add', 'review.md'); git(view, 'commit', '-qm', 'accepted report');
  const contract = { id: 'publication', projectRoot: root, inputSnapshot: snapshot, worktreePath: view,
    branch: 'publication-result', ask: 'Deliver review.md.', goal: 'Deliver the completed report.', criteria: [],
    units: [], checks: [], answer: 'The completed report is in review.md.' } as unknown as Contract;
  pinContractInputAdmission(contract);
  writeFileSync(join(root, 'README.md'), 'Later owner note.\n');
  return { root, view, contract, signal: new AbortController().signal };
}

test('publication admission preserves later owner edits, staging, history and original input and rejects serialized replay', async () => {
  const setup = await fixture();
  try {
    const original = JSON.stringify(setup.contract.inputSnapshot), index = readFileSync(join(setup.root, '.git/index'));
    const head = git(setup.root, 'rev-parse', 'HEAD');
    const admission = await admitPublicationInput(setup.contract, async () => true, setup.signal, async evidence => {
      expect(JSON.stringify(evidence)).toContain('Later owner note.');
      return () => {};
    });
    expect(admission).not.toBeNull();
    await expect(applyCapturedInputDelta(setup.contract, async () => true, setup.signal, JSON.parse(JSON.stringify(admission)))).rejects.toThrow();
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
    expect(await applyCapturedInputDelta(setup.contract, async () => true, setup.signal, admission!)).toBe(1);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner note.\n');
    expect(readFileSync(join(setup.root, 'review.md'), 'utf8')).toBe('Accepted report.\n');
    expect(readFileSync(join(setup.root, '.git/index'))).toEqual(index);
    expect(git(setup.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(JSON.stringify(setup.contract.inputSnapshot)).toBe(original);
    await expect(applyCapturedInputDelta(setup.contract, async () => true, setup.signal, admission!)).rejects.toThrow();
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('a declined compatibility assessment never admits or applies the pending result', async () => {
  const setup = await fixture();
  try {
    expect(await admitPublicationInput(setup.contract, async () => true, setup.signal, async () => null)).toBeNull();
    await expect(applyCapturedInputDelta(setup.contract, async () => true, setup.signal)).rejects.toThrow();
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner note.\n');
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('owner mutation during compatibility checking invalidates its pending admission', async () => {
  const setup = await fixture();
  try {
    await expect(admitPublicationInput(setup.contract, async () => true, setup.signal, async () => {
      writeFileSync(join(setup.root, 'README.md'), 'Newest owner note.\n');
      return () => {};
    })).rejects.toThrow();
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Newest owner note.\n');
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('permission revocation after compatibility approval still prevents owner publication', async () => {
  const setup = await fixture();
  try {
    const admission = await admitPublicationInput(setup.contract, async () => true, setup.signal, async () => () => {});
    expect(admission).not.toBeNull();
    await expect(applyCapturedInputDelta(setup.contract, async () => false, setup.signal, admission!)).rejects.toThrow();
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner note.\n');
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test.each(['scope', 'result'] as const)('a changed %s cannot reuse a pending publication assessment', async changed => {
  const setup = await fixture();
  try {
    await expect(admitPublicationInput(setup.contract, async () => true, setup.signal, async () => {
      if (changed === 'scope') setup.contract.goal = 'A different, unreviewed obligation.';
      else {
        writeFileSync(join(setup.view, 'review.md'), 'A different result.\n');
        git(setup.view, 'add', 'review.md'); git(setup.view, 'commit', '-qm', 'changed result');
      }
      return () => {};
    })).rejects.toThrow();
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner note.\n');
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test('retiring the native assessment authority prevents a later publication', async () => {
  const setup = await fixture();
  let active = true;
  try {
    const admission = await admitPublicationInput(setup.contract, async () => true, setup.signal, async () => () => {
      if (!active) throw new Error('Native assessment authority retired.');
    });
    expect(admission).not.toBeNull();
    active = false;
    await expect(applyCapturedInputDelta(setup.contract, async () => true, setup.signal, admission!)).rejects.toThrow('Native assessment authority retired.');
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});
