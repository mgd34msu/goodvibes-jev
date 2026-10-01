import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const CHILD_CEILING_MS = 30_000;

async function runOwnedChild(command: string[], description: string): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  // Drain both pipes immediately; a full pipe must not prevent the child from
  // exiting. Cleanup owns both the bundler and the separate JS runtime.
  const stdout = new Response(child.stdout).text().catch(() => '');
  const stderr = new Response(child.stderr).text().catch(() => '');
  try {
    const exitCode = await withTestTimeout(child.exited, CHILD_CEILING_MS, `${description} did not finish within ${CHILD_CEILING_MS}ms`);
    const output = { stdout: await stdout, stderr: await stderr };
    expect(exitCode, `${description} exited ${exitCode}:\n${output.stdout}\n${output.stderr}`).toBe(0);
    return output;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    await child.exited.catch(() => undefined);
  }
}

test('a browser-target consumer can execute new themes and legacy presentation exports together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'theme-browser-consumer-'));
  try {
    const entry = join(root, 'consumer.ts');
    const presentation = resolve(import.meta.dir, '../sdk/src/platform/presentation/index.ts');
    writeFileSync(entry, `
      import { DIFF_TONES, TONE_TOKENS, getBundledTheme, listBundledThemes, resolveTheme, themeToTones } from ${JSON.stringify(presentation)};
      const resolved = resolveTheme(getBundledTheme('goodvibes').json, 'dark');
      const tones = themeToTones(resolved);
      if (listBundledThemes().length !== 11 || resolved.primary !== '#5ee0e6') throw new Error('Bundled theme lookup failed');
      if (tones.accent.brand !== resolved.primary || !DIFF_TONES.add || !TONE_TOKENS.fg.primary) throw new Error('Presentation bridge failed');
      console.log('theme browser consumer passed');
    `);
    const bundle = join(root, 'consumer.js');
    // Keep the bundler out of the shared test process, following the scoped
    // browser-entrypoint tests' bounded child-process isolation.
    await runOwnedChild([
      process.execPath, 'build', entry, '--target=browser', '--format=esm', `--outfile=${bundle}`,
    ], 'building the theme browser consumer');
    const javascript = readFileSync(bundle, 'utf-8');
    // A separate runtime executes the actual browser-target bundle, rather
    // than Bun's source loader masking a missing or unreachable export.
    const { stdout, stderr } = await runOwnedChild(
      ['node', '--input-type=module', '--eval', javascript], 'executing the theme browser consumer',
    );
    expect(stderr).toBe('');
    expect(stdout.trim()).toBe('theme browser consumer passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 2 * CHILD_CEILING_MS + 5_000);
