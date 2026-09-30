import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sweepStaleTmpDirs } from '../scripts/stale-tmp-sweep.ts';
import { PROOF_RETAINED_MARKER, STALE_PROOF_TMP_MS, prepareObserveProofWorkspace, retainProofOutput } from '../scripts/proof-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test.each(['contract-proof-scratch-', 'contract-proof-home-', 'observe-proof-scratch-'])('reclaims old abandoned %s scratch but preserves live runs, retained evidence and unrelated files', (prefix) => {
  const root = mkdtempSync(join(tmpdir(), 'proof-sweep-test-'));
  roots.push(root);
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000);
  const create = (name: string, stale: boolean, keep = false) => {
    const path = join(root, name);
    mkdirSync(path);
    if (keep) retainProofOutput(path);
    if (stale) utimesSync(path, old, old);
    return path;
  };
  const abandoned = create(`${prefix}abandoned`, true);
  const kept = create(`${prefix}retained`, true, true);
  const fresh = create(`${prefix}running`, false);
  const unrelated = create('other-tool-output', true);
  const legacy = create(prefix.startsWith('contract') ? 'contract-proof-legacy' : 'observe-proof-legacy', true);
  sweepStaleTmpDirs(root, prefix, STALE_PROOF_TMP_MS, { preserveMarker: PROOF_RETAINED_MARKER });
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
  expect(existsSync(legacy)).toBe(true);
});

test('both live proof entry points call the real sweep and mark intentionally retained output', () => {
  for (const name of ['contract', 'observe']) {
    const source = readFileSync(resolve(import.meta.dir, `../scripts/${name}-proof.ts`), 'utf8');
    expect(source).toContain(name === 'contract'
      ? "sweepStaleTmpDirs(tmpdir(), 'contract-proof-scratch-', STALE_PROOF_TMP_MS, { preserveMarker: PROOF_RETAINED_MARKER })"
      : 'prepareObserveProofWorkspace(values.workspace)');
    expect(source).toContain(`retainProofOutput(${name === 'contract' ? 'root' : 'workspace'})`);
  }
});

test('selecting an old unmarked explicit observe workspace preserves its existing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const workspace = join(root, 'observe-proof-scratch-explicit'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'decisions.log'), 'existing evidence');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(workspace, old, old);
  expect(prepareObserveProofWorkspace(workspace, root)).toBe(workspace);
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('existing evidence');
  expect(existsSync(join(workspace, PROOF_RETAINED_MARKER))).toBe(true);
});

test('completed explicit observe output survives a later default workspace sweep', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const workspace = join(root, 'observe-proof-scratch-completed'); mkdirSync(workspace);
  prepareObserveProofWorkspace(workspace, root);
  writeFileSync(join(workspace, 'decisions.log'), 'completed evidence');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(workspace, old, old);
  const fresh = prepareObserveProofWorkspace(undefined, root);
  expect(fresh).not.toBe(workspace);
  expect(existsSync(fresh)).toBe(true);
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('completed evidence');
});

test('an explicit workspace nested under managed scratch retains the swept ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const ancestor = join(root, 'observe-proof-scratch-parent');
  const workspace = join(ancestor, 'selected'); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'decisions.log'), 'nested evidence');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(ancestor, old, old);
  prepareObserveProofWorkspace(workspace, root);
  utimesSync(ancestor, old, old);
  prepareObserveProofWorkspace(undefined, root);
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('nested evidence');
  expect(existsSync(join(ancestor, PROOF_RETAINED_MARKER))).toBe(true);
});

test('an explicit symlink under managed scratch keeps its lexical parent and selected target', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const outside = mkdtempSync(join(tmpdir(), 'proof-target-test-')); roots.push(outside);
  const ancestor = join(root, 'observe-proof-scratch-alias'); mkdirSync(ancestor);
  const workspace = join(ancestor, 'selected'); symlinkSync(outside, workspace, 'junction');
  writeFileSync(join(outside, 'decisions.log'), 'selected evidence');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(ancestor, old, old);
  expect(prepareObserveProofWorkspace(workspace, root)).toBe(workspace);
  expect(realpathSync(workspace)).toBe(realpathSync(outside));
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('selected evidence');
  expect(existsSync(join(ancestor, PROOF_RETAINED_MARKER))).toBe(true);
});

test('an explicit workspace remains usable when the unrelated sweep root does not exist', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(workspace);
  const missing = join(workspace, 'missing-sweep-root');
  writeFileSync(join(workspace, 'decisions.log'), 'existing evidence');
  expect(prepareObserveProofWorkspace(workspace, missing)).toBe(workspace);
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('existing evidence');
  expect(existsSync(missing)).toBe(false);
});

test('a selected multi-hop alias retains each managed ancestor in its resolution chain', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const paths = ['first', 'middle', 'target'].map((name) => join(root, `observe-proof-scratch-${name}`));
  const [first, middle, target] = paths as [string, string, string];
  for (const path of paths) mkdirSync(path);
  symlinkSync(target, join(middle, 'hop'), 'junction');
  const workspace = join(first, 'selected'); symlinkSync(join(middle, 'hop'), workspace, 'junction');
  writeFileSync(join(target, 'decisions.log'), 'selected evidence');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000);
  for (const path of paths) utimesSync(path, old, old);
  prepareObserveProofWorkspace(workspace, root);
  for (const path of paths) utimesSync(path, old, old);
  prepareObserveProofWorkspace(undefined, root);
  expect(realpathSync(workspace)).toBe(realpathSync(target));
  expect(readFileSync(join(workspace, 'decisions.log'), 'utf8')).toBe('selected evidence');
  for (const path of paths) expect(existsSync(path)).toBe(true);
});

test('a selected alias reached through another spelling of the temp root remains intact', () => {
  const outer = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(outer);
  const root = join(outer, 'real-temp'); mkdirSync(root);
  const rootAlias = join(outer, 'temp-alias'); symlinkSync(root, rootAlias, 'junction');
  const outside = join(outer, 'selected-target'); mkdirSync(outside);
  const ancestor = join(root, 'observe-proof-scratch-parent'); mkdirSync(ancestor);
  symlinkSync(outside, join(ancestor, 'selected'), 'junction');
  const workspace = join(rootAlias, 'observe-proof-scratch-parent', 'selected');
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(ancestor, old, old);
  expect(prepareObserveProofWorkspace(workspace, root)).toBe(workspace);
  expect(realpathSync(workspace)).toBe(realpathSync(outside));
  expect(existsSync(ancestor)).toBe(true);
});

test('native symlink parent traversal preserves the actual selected evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const [first, middle, target] = ['A', 'B', 'D'].map((name) => join(root, `observe-proof-scratch-${name}`)) as [string, string, string];
  for (const path of [first, middle, target]) mkdirSync(path);
  mkdirSync(join(target, 'sub')); mkdirSync(join(target, 'selected')); mkdirSync(join(middle, 'selected'));
  symlinkSync(join(target, 'sub'), join(middle, 'hop'), 'junction');
  const workspace = join(first, 'chosen');
  symlinkSync('../observe-proof-scratch-B/hop/../selected', workspace, 'junction');
  writeFileSync(join(target, 'selected', 'evidence'), 'native target');
  writeFileSync(join(middle, 'selected', 'evidence'), 'normalized neighbor');
  const selectedTarget = realpathSync(workspace);
  const selectedEvidence = readFileSync(join(workspace, 'evidence'), 'utf8');
  const abandoned = join(root, 'observe-proof-scratch-abandoned'); mkdirSync(abandoned);
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000);
  for (const path of [first, middle, target, abandoned]) utimesSync(path, old, old);
  prepareObserveProofWorkspace(workspace, root);
  expect(realpathSync(workspace)).toBe(selectedTarget);
  expect(readFileSync(join(workspace, 'evidence'), 'utf8')).toBe(selectedEvidence);
  expect(existsSync(abandoned)).toBe(false);
});

test('default observe sweeps preserve root symlinks and trees beyond the inspection budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const outside = mkdtempSync(join(tmpdir(), 'proof-target-test-')); roots.push(outside);
  const alias = join(root, 'observe-proof-scratch-alias'); symlinkSync(outside, alias, 'junction');
  const large = join(root, 'observe-proof-scratch-large'); mkdirSync(large);
  for (let index = 0; index < 1024; index++) writeFileSync(join(large, `file-${index}`), 'retained');
  const abandoned = join(root, 'observe-proof-scratch-abandoned'); mkdirSync(abandoned);
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000);
  for (const path of [outside, large, abandoned]) utimesSync(path, old, old);
  prepareObserveProofWorkspace(undefined, root);
  expect(existsSync(alias)).toBe(true);
  expect(readFileSync(join(large, 'file-1023'), 'utf8')).toBe('retained');
  expect(existsSync(abandoned)).toBe(false);
});

test('a failed preservation inspection refuses deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-explicit-test-')); roots.push(root);
  const workspace = join(root, 'observe-proof-scratch-unknown'); mkdirSync(workspace);
  const old = new Date(Date.now() - STALE_PROOF_TMP_MS - 60_000); utimesSync(workspace, old, old);
  sweepStaleTmpDirs(root, 'observe-proof-scratch-', STALE_PROOF_TMP_MS, { preserve() { throw new Error('cannot inspect'); } });
  expect(existsSync(workspace)).toBe(true);
});
