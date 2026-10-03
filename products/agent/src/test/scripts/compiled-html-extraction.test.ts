import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bunCompileCompatibilityFiles } from '../../../scripts/bun-compile-compat.ts';

const root = resolve(import.meta.dir, '../../..');

test('the production compile driver embeds installed HTML parsing through the real lazy loader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-compiled-html-'));
  const binary = join(dir, 'html-extraction');
  const files = bunCompileCompatibilityFiles(root);
  const before = new Map(Object.keys(files).map((file) => [file, readFileSync(file)]));
  try {
    const target = `bun-${process.platform}-${process.arch}`;
    const built = spawnSync(process.execPath, ['scripts/compile.ts', 'src/test/fixtures/compiled-html-extraction.ts', '--compile', `--target=${target}`, '--outfile', binary], {
      cwd: root, encoding: 'utf8', timeout: 300_000,
    });
    expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: '' });
    // No node_modules, ambient secrets, provider configuration or working-tree
    // paths are available to the executable at runtime.
    const run = spawnSync(binary, [], { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: dir }, encoding: 'utf8', timeout: 30_000 });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    const { result, requests } = JSON.parse(run.stdout);
    expect(result.extractorId).toBe('html-readability');
    expect(result.metadata.extractionPath).toBe('readability');
    expect(result.metadata.warnings).toBeUndefined();
    expect(result.metadata.byline).toBe('Synthetic Writer');
    expect(result.title).toBe('Compiled DOM proof');
    expect(result.structure.searchText).toContain('Parsed content & 電圧 100 V.');
    expect(result.links).toEqual(['/guide']);
    expect(requests).toEqual(['engine.knowledge.html-main-content', 'engine.knowledge.html-document-title']);
    for (const [file, bytes] of before) expect(readFileSync(file).equals(bytes)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 360_000);
