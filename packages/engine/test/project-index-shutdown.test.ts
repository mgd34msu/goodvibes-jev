import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../sdk/src/platform/state/project-index.js';

test('index disposal flushes accepted changes once and makes later writes terminal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'index-shutdown-')); const index = new ProjectIndex(root);
  try {
    index.upsertFile('src/file.ts', 27);
    const closing = index.dispose(); expect(index.dispose()).toBe(closing); await closing;
    expect(JSON.parse(readFileSync(join(root, '.goodvibes/project-index.json'), 'utf8')).tree['src/']['file.ts']).toBe(27);
    rmSync(root, { recursive: true, force: true });
    expect(() => index.upsertFile('late.ts', 1)).toThrow('disposed');
    expect(() => index.touchFile('src/file.ts')).toThrow('disposed');
    expect(() => index.removeFile('src/file.ts')).toThrow('disposed');
    await expect(index.forceFlush()).rejects.toThrow('disposed');
    await expect(index.load()).rejects.toThrow('disposed');
    await index.dispose(); expect(existsSync(root)).toBe(false);
  } finally { await index.dispose(); rmSync(root, { recursive: true, force: true }); }
});
test('reroot admitted before close cannot resume into a new path after disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'index-reroot-close-')); const target = join(root, 'new-root');
  const index = new ProjectIndex(root);
  try {
    index.upsertFile('first.ts', 1);
    const rerooting = index.reroot(target);
    await index.dispose();
    await expect(rerooting).rejects.toThrow('disposed');
    expect(index.baseDir).toBe(root); expect(existsSync(target)).toBe(false);
  } finally { await index.dispose(); rmSync(root, { recursive: true, force: true }); }
});
test('a failed final flush remains observable and cannot reopen the retired index', async () => {
  const root = mkdtempSync(join(tmpdir(), 'index-close-failure-'));
  const invalidRoot = join(root, 'file-instead-of-directory'); writeFileSync(invalidRoot, 'fixture');
  const index = new ProjectIndex(invalidRoot);
  try {
    index.upsertFile('pending.ts', 5);
    const closing = index.dispose();
    await expect(closing).rejects.toThrow();
    expect(index.dispose()).toBe(closing);
    await expect(index.dispose()).rejects.toThrow();
    expect(() => index.upsertFile('late.ts', 1)).toThrow('disposed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
