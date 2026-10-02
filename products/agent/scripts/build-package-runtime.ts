#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { patchBunCompileCompatibility } from './bun-compile-compat.ts';

const root = process.cwd();
const outDir = join(root, 'dist', 'package');
const entry = join(outDir, 'main.js');

rmSync(outDir, { recursive: true, force: true });
patchBunCompileCompatibility(root);

execFileSync('bun', ['build', 'src/main.ts', '--target=bun', '--outdir', outDir], {
  cwd: root,
  stdio: 'inherit',
});

if (!existsSync(entry)) {
  throw new Error(`package runtime build did not create ${entry}`);
}

const source = readFileSync(entry, 'utf-8');
const forbiddenRuntimeFragments = [
  'node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css',
  '../../../browser/default-stylesheet.css',
  'require.resolve("./xhr-sync-worker.js")',
] as const;
for (const fragment of forbiddenRuntimeFragments) {
  if (source.includes(fragment)) {
    throw new Error(`package runtime build leaked a build-machine dependency path: ${fragment}`);
  }
}

const size = statSync(entry).size;
if (size <= 0) {
  throw new Error(`package runtime build created an empty entrypoint: ${entry}`);
}

console.log(`package runtime built (${Math.round(size / 1024 / 1024)} MiB entrypoint)`);
