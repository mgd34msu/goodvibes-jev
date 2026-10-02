/** Bound complete file processes without shortening their declared long tests. */
export const DEFAULT_TEST_FILE_CEILING_MS = 120_000;

// Reviewed source declarations, not source-code parsing. Keep these with the
// named tests when their budgets change. The extra minute covers loading,
// teardown and ordinary cases; the compile file also has one ordinary test.
// The shared owner's existing per-invocation ceiling still wins if earlier.
const DECLARED_FILE_CEILINGS: Readonly<Record<string, { fileMs: number; stallMs: number }>> = {
  'src/test/cli/launch-auto-update-endtoend.test.ts': { fileMs: 4 * 180_000 + 60_000, stallMs: 180_000 + 60_000 },
  'src/test/runtime/session-spine-daemon-integration.test.ts': { fileMs: 4 * 120_000 + 60_000, stallMs: 120_000 + 60_000 },
  'src/test/runtime/memory-spine-daemon-integration.test.ts': { fileMs: 7 * 120_000 + 60_000, stallMs: 120_000 + 60_000 },
  'src/test/scripts/compiled-html-extraction.test.ts': { fileMs: 360_000 + 60_000 + 60_000, stallMs: 360_000 + 60_000 },
};

export function testFileCeilingMs(relativePath: string, override: string | undefined): number {
  const value = Number(override);
  if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  return DECLARED_FILE_CEILINGS[relativePath.replaceAll('\\', '/')]?.fileMs ?? DEFAULT_TEST_FILE_CEILING_MS;
}

/** Allow the longest declared test to finish before calling it stalled. */
export function testFileStallMs(relativePath: string): number | undefined {
  return DECLARED_FILE_CEILINGS[relativePath.replaceAll('\\', '/')]?.stallMs;
}
