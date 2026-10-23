import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo } from './runner-support.js';
import { captureContractInput, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import { pinContractInputAdmission } from '../../sdk/src/platform/contract/input-authority.js';
import { admitPublicationInput } from '../../sdk/src/platform/contract/publication-input.js';
import { applyCapturedInputDelta } from '../../sdk/src/platform/contract/input-apply.js';
import { ContractPublicationConflictError } from '../../sdk/src/platform/contract/publication-conflict.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function fixture(readme?: string, attributes?: string) {
  const root = makeRepo();
  if (readme !== undefined) {
    writeFileSync(join(root, 'README.md'), readme);
    if (attributes !== undefined) writeFileSync(join(root, '.gitattributes'), attributes);
    git(root, 'add', 'README.md', ...(attributes === undefined ? [] : ['.gitattributes'])); git(root, 'commit', '-qm', 'original owner input');
  }
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

test('publication reviews the merged candidate and preserves independent owner and result edits in one file', async () => {
  const base = ['Original heading', ...Array.from({ length: 2 }, (_, index) => `Unchanged line ${index}`), 'Original ending', ''].join('\n');
  const setup = await fixture(base);
  try {
    writeFileSync(join(setup.root, 'README.md'), base.replace('Original heading', 'Later owner heading'));
    writeFileSync(join(setup.view, 'README.md'), base.replace('Original ending', 'Accepted result ending'));
    git(setup.view, 'add', 'README.md'); git(setup.view, 'commit', '-qm', 'accepted result edit');
    const index = readFileSync(join(setup.root, '.git/index'));
    const head = git(setup.root, 'rev-parse', 'HEAD'), result = git(setup.view, 'rev-parse', 'HEAD');
    const original = JSON.stringify(setup.contract.inputSnapshot);
    let reviewed = false;
    const admission = await admitPublicationInput(setup.contract, async () => true, setup.signal, async evidence => {
      const state = evidence as unknown as { ownerChange: { observations: { path: string; proposedPublication?: { text?: string }[] }[] } };
      const candidate = state.ownerChange.observations.find(item => item.path === 'README.md')?.proposedPublication?.[0]?.text;
      expect(candidate).toContain('Later owner heading');
      expect(candidate).toContain('Accepted result ending');
      reviewed = true;
      return () => {};
    });
    expect(reviewed).toBe(true);
    expect(admission).not.toBeNull();
    await applyCapturedInputDelta(setup.contract, async () => true, setup.signal, admission!);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe(base.replace('Original heading', 'Later owner heading').replace('Original ending', 'Accepted result ending'));
    expect(readFileSync(join(setup.root, '.git/index'))).toEqual(index);
    expect(git(setup.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(setup.view, 'rev-parse', 'HEAD')).toBe(result);
    expect(JSON.stringify(setup.contract.inputSnapshot)).toBe(original);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

test.each([false, true])('conflicting publication preserves both versions and never executes a repository merge driver (custom driver: %s)', async customDriver => {
  const setup = await fixture('Original heading\nUnchanged ending\n', customDriver ? 'README.md merge=owner-driver\n' : undefined);
  try {
    const marker = join(setup.root, 'merge-driver-was-executed');
    if (customDriver) git(setup.root, 'config', 'merge.owner-driver.driver', `touch ${marker}`);
    writeFileSync(join(setup.root, 'README.md'), 'Later owner heading\nUnchanged ending\n');
    writeFileSync(join(setup.view, 'README.md'), 'Accepted result heading\nUnchanged ending\n');
    git(setup.view, 'add', 'README.md'); git(setup.view, 'commit', '-qm', 'conflicting accepted edit');
    const index = readFileSync(join(setup.root, '.git/index'));
    const head = git(setup.root, 'rev-parse', 'HEAD'), result = git(setup.view, 'rev-parse', 'HEAD');
    let questions = 0;
    await expect(admitPublicationInput(setup.contract, async () => true, setup.signal, async () => { questions++; return () => {}; }))
      .rejects.toBeInstanceOf(ContractPublicationConflictError);
    expect(questions).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner heading\nUnchanged ending\n');
    expect(readFileSync(join(setup.view, 'README.md'), 'utf8')).toBe('Accepted result heading\nUnchanged ending\n');
    expect(readFileSync(join(setup.root, '.git/index'))).toEqual(index);
    expect(git(setup.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(setup.view, 'rev-parse', 'HEAD')).toBe(result);
    expect(existsSync(join(setup.root, 'review.md'))).toBe(false);
  } finally { rmSync(setup.root, { recursive: true, force: true }); }
});

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

test.each([false, true])('publication recognizes accepted files already present in the current owner (remaining delta: %s)', async remaining => {
  const setup = await fixture();
  try {
    writeFileSync(join(setup.root, 'review.md'), 'Accepted report.\n');
    if (remaining) {
      writeFileSync(join(setup.view, 'appendix.md'), 'Accepted supporting evidence.\n');
      git(setup.view, 'add', 'appendix.md'); git(setup.view, 'commit', '-qm', 'accepted appendix');
    }
    const head = git(setup.root, 'rev-parse', 'HEAD'), index = readFileSync(join(setup.root, '.git/index'));
    const original = JSON.stringify(setup.contract.inputSnapshot), authorized: string[] = [];
    const filter = async (path: string) => { authorized.push(path); return true; };
    let assessments = 0;
    const admission = await admitPublicationInput(setup.contract, filter, setup.signal, async () => { assessments++; return () => {}; });
    expect(admission).not.toBeNull();
    expect(await applyCapturedInputDelta(setup.contract, filter, setup.signal, admission!)).toBe(remaining ? 1 : 0);
    expect(readFileSync(join(setup.root, 'review.md'), 'utf8')).toBe('Accepted report.\n');
    expect(readFileSync(join(setup.root, 'README.md'), 'utf8')).toBe('Later owner note.\n');
    if (remaining) expect(readFileSync(join(setup.root, 'appendix.md'), 'utf8')).toBe('Accepted supporting evidence.\n');
    expect(readFileSync(join(setup.root, '.git/index'))).toEqual(index);
    expect(git(setup.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(JSON.stringify(setup.contract.inputSnapshot)).toBe(original);
    expect(assessments).toBe(1);
    expect(authorized.some(path => path.endsWith('/review.md'))).toBe(true);
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

test.each(['scope', 'result', 'answer', 'check'] as const)('a changed %s cannot reuse a pending publication assessment', async changed => {
  const setup = await fixture();
  try {
    await expect(admitPublicationInput(setup.contract, async () => true, setup.signal, async () => {
      if (changed === 'scope') setup.contract.goal = 'A different, unreviewed obligation.';
      else if (changed === 'answer') setup.contract.answer = 'An unreviewed final claim.';
      else if (changed === 'check') setup.contract.checks.push({ id: 'unreviewed-check' } as Contract['checks'][number]);
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

test.each(['answer', 'check'] as const)('changing the accepted %s after admission prevents publication', async changed => {
  const setup = await fixture();
  try {
    const admission = await admitPublicationInput(setup.contract, async () => true, setup.signal, async () => () => {});
    expect(admission).not.toBeNull();
    if (changed === 'answer') setup.contract.answer = 'An unreviewed final claim.';
    else setup.contract.checks.push({ id: 'unreviewed-check' } as Contract['checks'][number]);
    await expect(applyCapturedInputDelta(setup.contract, async () => true, setup.signal, admission!)).rejects.toThrow();
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
