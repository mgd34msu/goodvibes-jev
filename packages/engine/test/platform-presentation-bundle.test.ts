import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
    const result = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', outdir: root });
    expect(result.success).toBe(true);
    const bundle = result.outputs.find((output) => output.kind === 'entry-point');
    if (!bundle) throw new Error('Browser build produced no entry point');
    const javascript = await bundle.text();
    // A separate runtime executes the actual browser-target bundle, rather
    // than Bun's source loader masking a missing or unreachable export.
    const process = Bun.spawn(['node', '--input-type=module', '--eval', javascript], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('theme browser consumer passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
