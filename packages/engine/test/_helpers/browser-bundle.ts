import { expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withTestTimeout } from './test-timeout.ts';

const SDK_ROOT = resolve(import.meta.dir, '../..');
const BUNDLE_CEILING_MS = 30_000;

/** Keep each browser bundle out of the shared test runtime and own its cleanup. */
export async function bundleBrowserEntrypoint(entrypoint: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'gv-browser-bundle-'));
  const output = join(outDir, 'bundle.js');
  try {
    const child = Bun.spawn([
      process.execPath, 'build', entrypoint, '--target=browser', '--format=esm', `--outfile=${output}`,
    ], { cwd: SDK_ROOT, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    // Drain both pipes immediately so a full pipe cannot stall the child.
    const stdout = new Response(child.stdout).text().catch(() => '');
    const stderr = new Response(child.stderr).text().catch(() => '');
    try {
      const exitCode = await withTestTimeout(
        child.exited,
        BUNDLE_CEILING_MS,
        `bundling ${entrypoint} did not finish within ${BUNDLE_CEILING_MS}ms`,
      );
      const diagnostics = `${await stdout}\n${await stderr}`.trim();
      expect(exitCode, `bun build ${entrypoint} exited ${exitCode}:\n${diagnostics}`).toBe(0);
      const bundled = readFileSync(output, 'utf8');
      // Empty output must not satisfy every forbidden-symbol assertion.
      expect(bundled.length, `bun build ${entrypoint} produced an empty bundle`).toBeGreaterThan(0);
      return bundled;
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
