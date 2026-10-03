import { describe, expect, test } from 'bun:test';
import { testFileCeilingMs, testFileStallMs } from '../../../scripts/test-file-ceiling.ts';

describe('source test file process ceilings', () => {
  test('ordinary files retain the bounded two-minute default', () => {
    expect(testFileCeilingMs('src/test/input/example.test.ts', undefined)).toBe(120_000);
    expect(testFileStallMs('src/test/input/example.test.ts')).toBeUndefined();
  });

  test.each([
    ['src/test/cli/launch-auto-update-endtoend.test.ts', 780_000, 240_000],
    ['src/test/runtime/session-spine-daemon-integration.test.ts', 540_000, 180_000],
    ['src/test/runtime/memory-spine-daemon-integration.test.ts', 900_000, 180_000],
    ['src/test/scripts/compiled-html-extraction.test.ts', 480_000, 420_000],
  ] as const)('%s accounts for its existing sequential test declarations', (file, expected, stall) => {
    expect(testFileCeilingMs(file, undefined)).toBe(expected);
    expect(testFileCeilingMs(file.replaceAll('/', '\\'), undefined)).toBe(expected);
    expect(testFileStallMs(file)).toBe(stall);
  });

  test('an explicit fixture cap wins, and invalid caps cannot disable the ceiling', () => {
    expect(testFileCeilingMs('src/test/scripts/compiled-html-extraction.test.ts', '250')).toBe(250);
    for (const invalid of ['', '0', '-1', 'Infinity', 'NaN']) {
      expect(testFileCeilingMs('src/test/input/example.test.ts', invalid)).toBe(120_000);
    }
  });
});
