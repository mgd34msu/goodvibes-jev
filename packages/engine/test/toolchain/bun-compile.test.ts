import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { parseBunCompileArgs } from '@goodvibes-jev/engine/toolchain';

test('shared compilation preserves every Agent/TUI target, including Windows beta', () => {
  for (const target of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64']) {
    expect(parseBunCompileArgs(['entry.ts', '--compile', `--target=${target}`, '--outfile', 'dist/artifact']).target).toBe(target);
  }
});

test('the public toolchain stays importable from Node without loading Bun', () => {
  const child = spawnSync('node', ['--input-type=module', '-e', `import { parseBunCompileArgs } from '@goodvibes-jev/engine/toolchain'; console.log(parseBunCompileArgs(['entry.ts', '--compile', '--target=bun-windows-x64', '--outfile', 'dist/artifact.exe']).target);`], { cwd: import.meta.dir + '/../..', encoding: 'utf8' });
  expect({ status: child.status, stdout: child.stdout.trim(), stderr: child.stderr }).toEqual({ status: 0, stdout: 'bun-windows-x64', stderr: '' });
});
