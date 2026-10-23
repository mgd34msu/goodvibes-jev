import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildWithGrammarRecovery, probeInstalledNativeGrammars } from '../../../scripts/build-native-ci.ts';

const require = createRequire(resolve(import.meta.dir, '../../../../../packages/engine/package.json'));
const grammars = ['tree-sitter-typescript.wasm', 'tree-sitter-tsx.wasm'];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-grammar-recovery-')); roots.push(root);
  const engine = join(root, 'packages/engine'), modules = join(engine, 'node_modules');
  const grammar = join(modules, 'tree-sitter-typescript'); mkdirSync(grammar, { recursive: true });
  writeFileSync(join(engine, 'package.json'), '{"name":"owned-grammar-fixture","type":"module"}');
  writeFileSync(join(grammar, 'package.json'), '{"name":"tree-sitter-typescript","version":"0.23.2"}');
  symlinkSync(dirname(require.resolve('web-tree-sitter/web-tree-sitter.wasm')), join(modules, 'web-tree-sitter'), 'dir');
  const entry = join(engine, 'entry.ts');
  const program = `import ts from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import tsx from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
export const embedded = [ts, tsx];`;
  writeFileSync(entry, program);
  let builds = 0, installs = 0;
  const restore = () => { for (const file of grammars) copyFileSync(require.resolve(`tree-sitter-typescript/${file}`), join(grammar, file)); };
  const build = async () => {
    builds++;
    const result = spawnSync(process.execPath, ['build', entry, '--target=bun', '--outdir', join(root, 'output')], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    if (result.signal || result.status === null) throw new Error('Fixture compiler was interrupted');
    return { exitCode: result.status, output: `${result.stdout}\n${result.stderr}` };
  };
  const effects = {
    build, probe: () => probeInstalledNativeGrammars(root),
    install: async () => { installs++; restore(); }, report: (_message: string) => {},
  };
  return { root, grammar, entry, program, restore, build, effects, counts: () => ({ builds, installs }) };
}

test('a successful real grammar bundle needs no reinstall or second build', async () => {
  const f = fixture(); f.restore();
  await buildWithGrammarRecovery(f.effects);
  await probeInstalledNativeGrammars(f.root);
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

test('missing grammar assets receive one repair, actual TS/TSX parsing, and a successful fresh bundle', async () => {
  const f = fixture();
  await buildWithGrammarRecovery(f.effects);
  expect(f.counts()).toEqual({ builds: 2, installs: 1 });
});

test('grammars that become readable after failure are validated without reinstalling', async () => {
  const f = fixture();
  await buildWithGrammarRecovery({ ...f.effects, build: async () => {
    const result = await f.build(); if (f.counts().builds === 1) f.restore(); return result;
  } });
  expect(f.counts()).toEqual({ builds: 2, installs: 0 });
});

test('real syntax errors never trigger dependency repair or a repeated build', async () => {
  const f = fixture(); f.restore(); writeFileSync(f.entry, 'export const = ;');
  await expect(buildWithGrammarRecovery(f.effects)).rejects.toThrow('without a recoverable grammar error');
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

test('a grammar resolution error cannot conceal a different unresolved dependency', async () => {
  const f = fixture(); writeFileSync(f.entry, `${f.program}\nimport './unavailable.ts';`);
  await expect(buildWithGrammarRecovery(f.effects)).rejects.toThrow('without a recoverable grammar error');
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

test('replacement files that are not real grammars cannot authorize another build', async () => {
  const f = fixture();
  await expect(buildWithGrammarRecovery({ ...f.effects, install: async () => {
    await f.effects.install(); for (const file of grammars) writeFileSync(join(f.grammar, file), 'not wasm');
  } })).rejects.toThrow();
  expect(f.counts()).toEqual({ builds: 1, installs: 1 });
});

test('a repeated real resolution failure stops after the single recovery attempt', async () => {
  const f = fixture();
  await expect(buildWithGrammarRecovery({ ...f.effects, build: async () => {
    if (f.counts().builds === 1) rmSync(join(f.grammar, grammars[0]!));
    return f.build();
  } })).rejects.toThrow('single recovery attempt');
  expect(f.counts()).toEqual({ builds: 2, installs: 1 });
});
