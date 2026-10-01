import { describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { resolveWorkspaceToolchain } from '../../../scripts/run-toolchain.ts';

function fixture() {
  const root = makeProjectTempDir('gv-private-launcher');
  mkdirSync(join(root, 'bin'));
  copyFileSync(resolve(import.meta.dir, '../../../bin/goodvibes'), join(root, 'bin/goodvibes'));
  return root;
}
async function launch(root: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, join(root, 'bin/goodvibes'), ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
describe('private workspace launch and build boundary', () => {
  test('missing build gives local guidance even when a legacy vendor payload exists', async () => {
    const root = fixture();
    mkdirSync(join(root, 'vendor'));
    const payload = join(root, 'vendor', `goodvibes-${process.platform}-${process.arch}`);
    writeFileSync(payload, '#!/bin/sh\necho LEGACY_PAYLOAD_EXECUTED\n'); chmodSync(payload, 0o755);
    const result = await launch(root, ['--help']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('private Jev workspace');
    expect(result.stdout).not.toContain('LEGACY_PAYLOAD_EXECUTED');
  });
  test('owned binary receives exact arguments and its exit code is preserved', async () => {
    const root = fixture(); mkdirSync(join(root, 'dist'));
    const binary = join(root, 'dist/goodvibes');
    writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 7\n'); chmodSync(binary, 0o755);
    const result = await launch(root, ['--prompt', 'one whole request']);
    expect(result.code).toBe(7);
    expect(result.stdout).toBe('--prompt\none whole request\n');
  });
  test('scripts-disabled build uses the engine declared CLI, with no downloaded fallback', () => {
    const root = fixture(); const engine = join(root, 'node_modules/@goodvibes-jev/engine'); mkdirSync(engine, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', exports: { './package.json': './package.json' }, bin: { 'goodvibes-build-binaries': './owned-cli.js' } }));
    expect(() => resolveWorkspaceToolchain(root, 'build')).toThrow('Build the workspace engine');
    writeFileSync(join(engine, 'owned-cli.js'), '');
    expect(resolveWorkspaceToolchain(root, 'build')).toBe(join(engine, 'owned-cli.js'));
    expect(() => resolveWorkspaceToolchain(root, 'unknown')).toThrow('Usage:');
  });
});
