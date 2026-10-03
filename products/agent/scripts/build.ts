#!/usr/bin/env bun
/** Build through the CLI declared by this private workspace's installed engine. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveAgentBuildToolchain(productRoot: string): string {
  const require = createRequire(resolve(productRoot, 'package.json'));
  const manifestPath = require.resolve('@goodvibes-jev/engine/package.json');
  const manifest: { bin?: Record<string, unknown> } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = manifest.bin?.['goodvibes-build-binaries'];
  if (typeof entry !== 'string') throw new Error('The workspace engine does not declare goodvibes-build-binaries.');
  const path = resolve(dirname(manifestPath), entry);
  if (!existsSync(path)) throw new Error(`Build the workspace engine before packaging Agent. Missing declared CLI: ${path}`);
  return path;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const cli = resolveAgentBuildToolchain(root);
    const child = Bun.spawn([process.execPath, cli, ...process.argv.slice(2)], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exit(await child.exited);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
