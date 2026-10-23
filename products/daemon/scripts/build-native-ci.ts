#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BuildResult { readonly exitCode: number; readonly output: string; }
interface GrammarBuildEffects {
  readonly build: () => Promise<BuildResult>;
  readonly probe: () => Promise<void>;
  readonly install: () => Promise<void>;
  readonly report: (message: string) => void;
}

function onlyGrammarResolutionFailed(output: string): boolean {
  const errors = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => line.startsWith('error:'));
  const grammar = /^error: Could not resolve: ["']tree-sitter-typescript\/tree-sitter-(?:typescript|tsx)\.wasm["'](?:\. Maybe you need to "bun install"\?)?$/;
  return errors.some(line => grammar.test(line))
    && errors.every(line => grammar.test(line) || /^error: script "build:binary" exited with code [1-9][0-9]*$/.test(line));
}

/** Recover only the observed dependency-resolution failure, never general compiler errors. */
export async function buildWithGrammarRecovery(effects: GrammarBuildEffects): Promise<void> {
  const first = await effects.build();
  if (first.exitCode === 0) return;
  if (!onlyGrammarResolutionFailed(first.output)) throw new Error(`Native compilation failed without a recoverable grammar error:\n${first.output}`);
  effects.report('Native grammar resolution failed; validating installed TypeScript and TSX before one fresh compilation.');
  try { await effects.probe(); }
  catch {
    effects.report('Installed grammars are incomplete; performing one forced frozen-lockfile install.');
    await effects.install();
    await effects.probe();
  }
  const recovered = await effects.build();
  if (recovered.exitCode !== 0) throw new Error(`Native compilation still failed after its single recovery attempt:\n${recovered.output}`);
}

/** Exercise both actual languages; the presence of a file alone is insufficient. */
export async function probeInstalledNativeGrammars(repository: string): Promise<void> {
  // A failed lookup can remain cached in Bun after a package is repaired.
  // Each probe must observe the actual current installation in a fresh process.
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--probe', repository], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.signal || child.status !== 0) throw new Error(`Installed grammar validation failed: ${child.stderr.trim()}`);
}

async function parseInstalledNativeGrammars(repository: string): Promise<void> {
  const require = createRequire(resolve(repository, 'packages/engine/package.json'));
  const { Parser, Language } = await import(require.resolve('web-tree-sitter'));
  await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/web-tree-sitter.wasm') });
  for (const [file, code] of [
    ['tree-sitter-typescript.wasm', 'type Item = { value: string };'],
    ['tree-sitter-tsx.wasm', 'const item = <div>{value}</div>;'],
  ] as const) {
    const language = await Language.load(require.resolve(`tree-sitter-typescript/${file}`));
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(code);
      if (!tree) throw new Error(`Installed ${file} did not produce a syntax tree`);
      try { if (tree.rootNode.hasError) throw new Error(`Installed ${file} could not parse its language`); }
      finally { tree.delete(); }
    } finally { parser.delete(); }
  }
}

if (import.meta.main) {
  const repository = resolve(import.meta.dir, '../../..');
  const [target, ...extra] = process.argv.slice(2);
  const execute = (args: string[], timeout = 300_000): BuildResult => {
    const child = spawnSync(process.execPath, args, { cwd: repository, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error) throw child.error;
    if (child.signal || child.status === null) throw new Error(`Native build command interrupted: ${child.signal ?? 'unknown'}`);
    return { exitCode: child.status, output: `${child.stdout}\n${child.stderr}` };
  };
  try {
    if (target === '--probe' && extra.length === 1) {
      await parseInstalledNativeGrammars(resolve(extra[0]!));
      process.exit(0);
    }
    if (!target || extra.length || !['linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(target)) throw new Error('Expected one native producer target');
    await buildWithGrammarRecovery({
      build: async () => execute(['run', '--cwd', 'products/daemon', 'build:binary', '--target', target]),
      probe: () => probeInstalledNativeGrammars(repository),
      install: async () => { if (execute(['install', '--frozen-lockfile', '--force'], 120_000).exitCode !== 0) throw new Error('Frozen dependency repair failed'); },
      report: message => console.error(message),
    });
  } catch (error) { console.error(error); process.exitCode = 1; }
}
