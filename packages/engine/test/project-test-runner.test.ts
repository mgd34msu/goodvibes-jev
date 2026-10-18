import { expect, test } from 'bun:test';
import { declaredTestRunner } from '../sdk/src/platform/utils/project-test-runner.js';

test('declared scripts override unrelated installed runners and follow literal script delegation', () => {
  expect(declaredTestRunner({ scripts: { test: 'cross-env NODE_ENV=test pnpm run test:unit', 'test:unit': 'npx --no-install vitest run' }, devDependencies: { jest: '1' } })).toBe('vitest');
  expect(declaredTestRunner({ scripts: { test: 'node --test test/a.js' } })).toBe('node:test');
  expect(declaredTestRunner({ scripts: { test: 'bun test' } })).toBe('bun:test');
});
test('mixed shells, custom executors, cycles and malformed literals do not become declarations', () => {
  for (const scripts of [
    { test: 'jest && vitest run' }, { test: 'node scripts/tests.js' }, { test: 'echo jest' },
    { test: 'npm run unit', unit: 'npm run test' }, { test: '"jest' }, { test: '$RUNNER test' },
    { test: 'node script.js --test' }, { test: 'playwright --version' },
  ]) expect(declaredTestRunner({ scripts, dependencies: { jest: '1' } })).toBeUndefined();
});
