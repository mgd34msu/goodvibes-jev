import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const child = join(import.meta.dir, 'fixtures/async-account-registry-fifo-child.ts');

function run(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'account-fifo-')); roots.push(root);
  const path = join(root, 'accounts.json');
  if (mode.startsWith('initial-')) {
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
  }
  // This deadline lives outside the affected event loop. A blocking open must
  // fail/reap here, not leave the suite or a child alive indefinitely.
  const result = spawnSync(process.execPath, [child, mode, path], {
    encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL',
  });
  expect(result.error?.message ?? null).toBeNull();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  const evidence = JSON.parse(result.stdout.trim()) as { rejected: boolean; reason: string; reads: number; fifo: boolean; files: string[] };
  return { evidence, root, path };
}

describe.skipIf(process.platform === 'win32')('account registry rejects POSIX FIFOs without blocking', () => {
  for (const mode of ['initial-list', 'initial-record', 'replace-list', 'replace-record']) {
    test(mode, () => {
      const { evidence, root, path } = run(mode);
      expect(evidence.rejected).toBe(true);
      expect(evidence.reason).toBe('The account registry is not a regular file');
      expect(evidence.fifo).toBe(true);
      expect(lstatSync(path).isFIFO()).toBe(true);
      expect(readdirSync(root)).toEqual(['accounts.json']);
      expect(evidence.files).toEqual(['accounts.json']);
      if (mode.startsWith('initial-')) expect(evidence.reads).toBe(0);
      else expect(evidence.reads).toBeGreaterThan(0);
    });
  }

  test('cancellation during a pending reading leaves the replacement FIFO untouched', () => {
    const { evidence, root, path } = run('replace-cancel');
    expect(evidence.rejected).toBe(true);
    expect(evidence.reason).toBe('fixture cancelled while reading');
    expect(lstatSync(path).isFIFO()).toBe(true);
    expect(readdirSync(root)).toEqual(['accounts.json']);
  });

  test('ordinary account files still disclose only after their safety readings', () => {
    const { evidence, path } = run('regular');
    expect(evidence.rejected).toBe(false);
    expect(evidence.reads).toBeGreaterThan(0);
    expect(evidence.fifo).toBe(false);
    expect(lstatSync(path).isFile()).toBe(true);
  });
});
