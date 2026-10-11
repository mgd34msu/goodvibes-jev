import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// B20 must stay loadable in a browser, even though Node hosts supply its spawn.
// This verifies retained code and transitive imports, not just a source regex.
describe('browser-safe recorder semantic capture', () => {
  test('bundles the actual source opener without Node admission or full judgment transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-recorder-browser-'));
    try {
      const entry = join(dir, 'consumer.ts');
      const source = resolve(import.meta.dir, '../sdk/src/platform/voice/capture/recorder-source.ts');
      writeFileSync(entry, `import { createRecorderCaptureOpener } from ${JSON.stringify(source)}; globalThis.recorder = createRecorderCaptureOpener;`);
      const output = join(dir, 'consumer.js'); const metadata = join(dir, 'meta.json');
      const child = Bun.spawn([process.execPath, 'build', entry, '--target=browser', '--conditions=bun', '--format=iife',
        `--outfile=${output}`, `--metafile=${metadata}`], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const stdout = new Response(child.stdout).text(); const stderr = new Response(child.stderr).text();
      expect(await child.exited, `${await stdout}\n${await stderr}`).toBe(0);
      const graph = JSON.parse(readFileSync(metadata, 'utf8')) as { inputs: Record<string, { imports: Array<{ path: string }> }> };
      const paths = Object.keys(graph.inputs).map(path => path.replaceAll('\\', '/'));
      const edges = Object.values(graph.inputs).flatMap(input => input.imports.map(item => item.path));
      expect(paths.some(path => path.endsWith('/voice/capture/recorder-failure-reading.ts'))).toBe(true);
      expect(paths.some(path => path.endsWith('/gate/failure-input-snapshot.ts'))).toBe(true);
      expect([...paths, ...edges].filter(path => /(?:^|\/)(?:node:|bun:)|\/gate\/failure-input\.(?:ts|js)|judgment\/(?:src|dist)\/(?:index\.|log\/|port\/(?:client|transport|failover))/.test(path))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
