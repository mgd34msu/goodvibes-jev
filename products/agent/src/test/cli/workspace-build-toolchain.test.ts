import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentBuildToolchain } from '../../../scripts/build.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test('Agent resolves the installed engine declared CLI without a generated bin shim', () => {
  const root = makeProjectTempDir('agent-build-launcher');
  const engine = join(root, 'node_modules', '@goodvibes-jev', 'engine');
  mkdirSync(join(engine, 'toolchain', 'dist', 'bin'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' }, bin: { 'goodvibes-build-binaries': './toolchain/dist/bin/build-binaries.js' } }));
  expect(() => resolveAgentBuildToolchain(root)).toThrow('Build the workspace engine');
  const cli = join(engine, 'toolchain', 'dist', 'bin', 'build-binaries.js');
  writeFileSync(cli, '// synthetic CLI');
  expect(resolveAgentBuildToolchain(root)).toBe(cli);
});

test('Agent refuses an installed engine with no declared build CLI', () => {
  const root = makeProjectTempDir('agent-build-no-cli');
  const engine = join(root, 'node_modules', '@goodvibes-jev', 'engine');
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' } }));
  expect(() => resolveAgentBuildToolchain(root)).toThrow('does not declare');
});
