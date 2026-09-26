import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

describe('version-sync', () => {
test('SDK baked version stays aligned with the engine package version', () => {
  // The engine manifest (packages/engine/package.json) is what version.ts reads.
  const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const versionSource = readFileSync(
    resolve(ROOT, 'sdk', 'src', 'platform', 'version.ts'),
    'utf8',
  );
  const match = versionSource.match(/\bversion\s*=\s*['"](\d+\.\d+\.\d+[^'"]*)['"]/);

  expect(match).not.toBeNull();
  expect(match?.[1]).toBe(rootPackage.version);
});
});
