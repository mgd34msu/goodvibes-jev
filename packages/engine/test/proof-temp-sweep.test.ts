import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sweepStaleTmpDirs } from '../scripts/stale-tmp-sweep.ts';
import { PROOF_RETAINED_MARKER, STALE_PROOF_TMP_MS, retainProofOutput } from '../scripts/proof-temp.ts';

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
    expect(source).toContain(`sweepStaleTmpDirs(tmpdir(), '${name}-proof-scratch-', STALE_PROOF_TMP_MS, { preserveMarker: PROOF_RETAINED_MARKER })`);
    expect(source).toContain(`retainProofOutput(${name === 'contract' ? 'root' : 'workspace'})`);
  }
});
