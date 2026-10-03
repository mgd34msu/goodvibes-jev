import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePackManifest } from './helpers/pack-manifest-output.ts';

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'goodvibes-pack-manifest-output-')); });
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

test('captures every file in a pack JSON document larger than the default subprocess buffer', () => {
  const files = Array.from({ length: 8_000 }, (_, index) => ({
    path: `sdk/dist/synthetic/${String(index).padStart(5, '0')}/${'component-'.repeat(18)}index.js`,
    size: index + 1,
    mode: 420,
  }));
  const manifest = [{ filename: 'synthetic-engine.tgz', files }];
  const document = JSON.stringify(manifest);
  expect(Buffer.byteLength(document)).toBeGreaterThan(1024 * 1024);
  const input = join(root, 'large-pack.json');
  writeFileSync(input, document);
  const result = capturePackManifest('node', ['-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', input], {
    cwd: root, timeout: 5_000,
  });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(result.stdout).toBe(document);
  expect(JSON.parse(result.stdout)).toEqual(manifest);
});

test('retains a finite 32 MiB ceiling instead of accepting unbounded output', () => {
  const result = capturePackManifest('node', ['-e', 'process.stdout.write(Buffer.alloc(32 * 1024 * 1024 + 1024, 120))'], {
    cwd: root, timeout: 5_000,
  });
  expect(result.error).toBeDefined();
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOBUFS');
  expect(result.status).not.toBe(0);
});
