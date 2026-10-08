import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '../errors/src/index.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { FileStateCache } from '../sdk/src/platform/state/file-cache.js';
import { FileUndoManager } from '../sdk/src/platform/state/file-undo.js';
import { createEditTool } from '../sdk/src/platform/tools/edit/index.js';
import { createCapturedAutoHealBackend } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import type { ValidatorRunner } from '../sdk/src/platform/tools/shared/validators.js';
import { withCapturedPublication } from '../sdk/src/platform/tools/shared/captured-publication.js';
import { toolReadingsPort } from './_helpers/tool-readings.js';

const roots: string[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const originals = ['first original\r\n\u03bb\r\n', 'second original\n\u2603\n'];
const edited = originals.map((value) => value.replace('original', 'edited'));
const repaired = 'first repaired\r\n\u03bb\r\n';
const edits = ['first.txt', 'second.txt'].map((path) => ({ path, find: 'original', replace: 'edited' }));
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
function install(port: JudgmentPort): void {
  const previous = installJudgmentPort(port);
  restorers.push(() => { installJudgmentPort(previous); });
}
async function fixture(onRead?: (path: string, root: string) => void | Promise<void>) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-edit-history-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  for (const [index, edit] of edits.entries()) writeFileSync(join(owner, edit.path), originals[index]!);
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const controller = new AbortController();
  const contract = { projectRoot: owner, inputSnapshot } as Contract;
  const authority = await createContractInputAuthority(contract, root, { mutable: true, branch, signal: controller.signal });
  let permitted = true;
  const filter = async (path: string) => { await onRead?.(path, root); return permitted; };
  const backend = createCapturedAutoHealBackend({ authority, root, readAccessFilter: filter, signal: controller.signal });
  const undo = new FileUndoManager();
  const config = { get: (() => true) as ConfigManager['get'], getWorkingDirectory: () => root };
  const failure: ValidatorRunner = async (validator) => ({ validator, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
  const edit = (validatorRunner = failure, chat = async () => repaired) => capturedInputTool(createEditTool(new FileStateCache(), {
    cwd: root, configManager: config, toolLLM: { chat }, validatorRunner, capturedAutoHeal: backend, fileUndoManager: undo,
  }), authority, root, filter, controller.signal);
  return { owner, root, authority, controller, contract, undo, edit, deny: () => { permitted = false; } };
}
function bytes(root: string, index: number): Buffer { return readFileSync(join(root, edits[index]!.path)); }
function roundTrip(f: Awaited<ReturnType<typeof fixture>>, expected: readonly string[]): void {
  expect(f.undo.undoDepth()).toBe(2);
  for (let index = 1; index >= 0; index--) {
    expect(bytes(f.root, index)).toEqual(Buffer.from(expected[index]!));
    expect(f.undo.peekUndo()).toMatchObject({ beforeContent: originals[index], afterContent: expected[index], tool: 'edit' });
    expect(f.undo.undo()?.path).toBe(join(f.root, edits[index]!.path));
    expect(bytes(f.root, index)).toEqual(Buffer.from(originals[index]!));
  }
  for (let index = 0; index < 2; index++) {
    expect(f.undo.redo()?.path).toBe(join(f.root, edits[index]!.path));
    expect(bytes(f.root, index)).toEqual(Buffer.from(expected[index]!));
    expect(bytes(f.owner, index)).toEqual(Buffer.from(originals[index]!));
  }
}
for (const mode of ['partial', 'none'] as const) {
  test(`captured ${mode} validator exception retains exact-byte undo and redo for both edits`, async () => {
    const f = await fixture();
    const result = await f.edit(async () => { throw new Error('Synthetic validator exception'); }).execute({ edits, validate: { after: ['build'] }, transaction: { mode } });
    expect(result.success).toBe(false); expect(result.error).toContain('Synthetic validator exception');
    roundTrip(f, edited);
  });
  test(`captured ${mode} terminal repair judgment records an earlier repair and the unhealed sibling`, async () => {
    const f = await fixture(); const base = toolReadingsPort([['', { fixesErrors: true, onlyTheFix: true }]]).port;
    let judgments = 0;
    install({ model: base.model, ask: async (request) => {
      if (++judgments === 2) throw new JudgmentError('unavailable', 'Synthetic terminal judgment');
      return base.ask(request);
    } });
    const result = await f.edit().execute({ edits, validate: { after: ['build'] }, transaction: { mode } });
    expect(result.success).toBe(false); expect(judgments).toBe(2); expect(result.error).toContain('Synthetic terminal judgment');
    roundTrip(f, [repaired, edited[1]!]);
  });
}

function preserveHistory(f: Awaited<ReturnType<typeof fixture>>): () => void {
  const path = join(f.owner, 'history.txt');
  f.undo.snapshot({ path, beforeContent: 'before', afterContent: 'intermediate', tool: 'write' });
  f.undo.snapshot({ path, beforeContent: 'intermediate', afterContent: 'after', tool: 'write' });
  f.undo.undo();
  const previous = f.undo.peekUndo();
  return () => {
    expect(f.undo.undoDepth()).toBe(1); expect(f.undo.redoDepth()).toBe(1); expect(f.undo.peekUndo()).toBe(previous);
    f.undo.redo(); expect(readFileSync(path, 'utf8')).toBe('after');
  };
}
for (const outcome of ['success', 'error return', 'exception'] as const) {
  for (const changed of [0, 1] as const) {
    test(`captured ${outcome} finalizes only the retained owned sibling of changed file ${changed + 1}`, async () => {
      const f = await fixture(); const other = changed === 0 ? 1 : 0;
      const newer = `newer ${changed} external bytes\r\n`;
      const result = await f.edit(async (validator) => {
        writeFileSync(join(f.root, edits[changed]!.path), newer);
        if (outcome === 'exception') throw new Error('Synthetic validator exception');
        return { validator, passed: outcome === 'success', exitCode: outcome === 'success' ? 0 : 1, stdout: '', stderr: 'Synthetic validation failure' };
      }, async () => '').execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
      expect(result.success).toBe(outcome === 'success');
      expect(bytes(f.root, changed)).toEqual(Buffer.from(newer));
      expect(f.undo.undoDepth()).toBe(1);
      expect(f.undo.peekUndo()).toMatchObject({ path: join(f.root, edits[other]!.path), beforeContent: originals[other], afterContent: edited[other] });
      f.undo.undo(); expect(bytes(f.root, other)).toEqual(Buffer.from(originals[other]!));
      expect(bytes(f.root, changed)).toEqual(Buffer.from(newer));
      f.undo.redo(); expect(bytes(f.root, other)).toEqual(Buffer.from(edited[other]!));
      expect(bytes(f.root, changed)).toEqual(Buffer.from(newer));
    });
  }
}

test('a same-byte replacement is a different revision and does not erase existing undo/redo history', async () => {
  const f = await fixture(); const historyUnchanged = preserveHistory(f);
  const result = await f.edit(async (validator) => {
    for (const [index, edit] of edits.entries()) {
      const path = join(f.root, edit.path);
      rmSync(path); writeFileSync(path, edited[index]!);
    }
    return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(true); historyUnchanged();
  for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(edited[index]!));
});

test('a partial publication failure records only the successfully written file', async () => {
  let reads = 0;
  const f = await fixture((path, root) => {
    if (path === join(root, 'second.txt') && ++reads === 3) writeFileSync(path, 'newer second bytes\n');
  });
  const result = await f.edit().execute({ edits, transaction: { mode: 'partial' } });
  expect(result.success).toBe(true); expect(result.output).toContain('Write failed');
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'first.txt'));
  f.undo.undo(); expect(bytes(f.root, 0)).toEqual(Buffer.from(originals[0]!));
  expect(bytes(f.root, 1).toString()).toBe('newer second bytes\n');
});

for (const mode of ['partial', 'none'] as const) {
  test(`captured ${mode} normal validation failure records each retained revision once`, async () => {
    const f = await fixture();
    const result = await f.edit(undefined, async () => '').execute({ edits, validate: { after: ['build'] }, transaction: { mode } });
    expect(result.success).toBe(false); expect(result.error).toContain('Post-edit validation failed');
    roundTrip(f, edited);
  });
}
for (const mode of ['atomic', undefined] as const) {
  test(`captured ${mode ?? 'default'} validation exception fully rolls back without changing undo/redo`, async () => {
    const f = await fixture(); const historyUnchanged = preserveHistory(f);
    const result = await f.edit(async () => { throw new Error('Synthetic validator exception'); }).execute({ edits, validate: { after: ['build'] }, ...(mode ? { transaction: { mode } } : {}) });
    expect(result.success).toBe(false); expect(result.error).toContain('edits rolled back'); historyUnchanged();
    for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(originals[index]!));
  });
}

test('captured atomic incomplete rollback neither records a newer conflicting file nor restored siblings', async () => {
  const f = await fixture(); const historyUnchanged = preserveHistory(f);
  const result = await f.edit(async () => {
    writeFileSync(join(f.root, 'second.txt'), 'newer second bytes\n');
    throw new Error('Synthetic validator exception');
  }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false); expect(result.error).toContain('rollback incomplete'); historyUnchanged();
  expect(bytes(f.root, 0)).toEqual(Buffer.from(originals[0]!)); expect(bytes(f.root, 1).toString()).toBe('newer second bytes\n');
});

for (const change of ['cancel', 'revoke', 'deny', 'admission'] as const) {
  test(`captured ${change} after publication preserves bytes and existing history without new undo authority`, async () => {
    const f = await fixture(); const historyUnchanged = preserveHistory(f);
    const result = await f.edit(async () => {
      if (change === 'cancel') f.controller.abort();
      else if (change === 'revoke') revokeContractInputAuthority(f.authority);
      else if (change === 'deny') f.deny();
      else f.contract.inputSnapshot = { ...f.contract.inputSnapshot!, id: 'changed-admission' };
      throw new Error('Synthetic validator exception');
    }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
    expect(result.success).toBe(false); expect(result.output).toBeUndefined(); expect(result.error).toContain('Output withheld'); historyUnchanged();
    for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(edited[index]!));
  });
}

test('captured denied initial admission leaves files and undo/redo unchanged', async () => {
  const f = await fixture(); const historyUnchanged = preserveHistory(f); f.deny();
  let validators = 0;
  const result = await f.edit(async () => { validators++; throw new Error('must not run'); }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(false); expect(result.error).toContain('access-restricted'); expect(result.output).toBeUndefined(); expect(validators).toBe(0); historyUnchanged();
  for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(originals[index]!));
});


test('captured finalization finishes inside its original lease before a queued publication can run', async () => {
  let finalizing = false; let held = false;
  let started!: () => void; const waiting = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (path, root) => {
    if (finalizing && !held && path === join(root, 'first.txt')) {
      held = true; started(); await released;
    }
  });
  const pending = f.edit(async (validator) => {
    finalizing = true;
    return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  await waiting;
  expect(f.undo.undoDepth()).toBe(0);
  let successorRan = false;
  const successor = withCapturedPublication(f.authority, async () => {
    successorRan = true;
    expect(f.undo.undoDepth()).toBe(2);
  });
  await Promise.resolve(); expect(successorRan).toBe(false);
  release();
  expect((await pending).success).toBe(true); await successor; expect(successorRan).toBe(true);
  roundTrip(f, edited);
});

test('a later finalization admission cannot leave undo for an earlier newly conflicting revision', async () => {
  let finalizing = false; let changed = false;
  const f = await fixture((path, root) => {
    if (finalizing && !changed && path === join(root, 'second.txt')) {
      changed = true;
      writeFileSync(join(root, 'first.txt'), 'newer bytes during finalization\n');
    }
  });
  const result = await f.edit(async (validator) => {
    finalizing = true;
    return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(true); expect(changed).toBe(true);
  expect(f.undo.undoDepth()).toBe(1); expect(f.undo.peekUndo()?.path).toBe(join(f.root, 'second.txt'));
  f.undo.undo(); expect(bytes(f.root, 1)).toEqual(Buffer.from(originals[1]!));
  expect(bytes(f.root, 0).toString()).toBe('newer bytes during finalization\n');
});

for (const mode of ['atomic', undefined] as const) {
  test(`captured ${mode ?? 'default'} successful edits retain normal exact-byte undo/redo`, async () => {
    const f = await fixture();
    const result = await f.edit().execute({ edits, ...(mode ? { transaction: { mode } } : {}) });
    expect(result.success).toBe(true); roundTrip(f, edited);
  });
}

test('captured atomic terminal repair exception restores an earlier repair and preserves prior history', async () => {
  const f = await fixture(); const historyUnchanged = preserveHistory(f);
  const base = toolReadingsPort([['', { fixesErrors: true, onlyTheFix: true }]]).port;
  let judgments = 0;
  install({ model: base.model, ask: async (request) => {
    if (++judgments === 2) throw new JudgmentError('unavailable', 'Synthetic terminal judgment');
    return base.ask(request);
  } });
  const result = await f.edit().execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'atomic' } });
  expect(result.success).toBe(false); expect(judgments).toBe(2); expect(result.error).toContain('edits rolled back'); historyUnchanged();
  for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(originals[index]!));
});

test('captured dry-run preserves files and undo/redo without validation or repair', async () => {
  const f = await fixture(); const historyUnchanged = preserveHistory(f);
  let validators = 0;
  const result = await f.edit(async () => { validators++; throw new Error('must not run'); }).execute({ edits, dry_run: true, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(true); expect(validators).toBe(0); historyUnchanged();
  for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(originals[index]!));
});

test('a later finalization denial withholds the whole new history batch and preserves prior undo/redo', async () => {
  let finalizing = false;
  const f = await fixture((path, root) => {
    if (finalizing && path === join(root, 'second.txt')) f.deny();
  });
  const historyUnchanged = preserveHistory(f);
  const result = await f.edit(async (validator) => {
    finalizing = true;
    return { validator, passed: true, exitCode: 0, stdout: '', stderr: '' };
  }).execute({ edits, validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(false); expect(result.error).toContain('Output withheld'); expect(result.output).toBeUndefined();
  historyUnchanged();
  for (let index = 0; index < 2; index++) expect(bytes(f.root, index)).toEqual(Buffer.from(edited[index]!));
});
