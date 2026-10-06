import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTuiHostCommand } from '../../cli/host-pair-command.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const terminal = (lines: string[]) => ({ interactive: false, write: (line: string) => lines.push(line), question: async () => { throw new Error('No owner terminal'); } });

test('standalone missing inspection does not create a shared config, private store or workspace state', async () => {
  const home = makeProjectTempDir('host-preview-home'); const workspace = makeProjectTempDir('host-preview-work'); const lines: string[] = [];
  expect(await runTuiHostCommand(['pair', '--url', 'http://127.0.0.1:1'], { homeDirectory: home, defaultWorkingDirectory: workspace }, terminal(lines))).toBe(1);
  expect(lines.join('\n')).toContain('No TUI credential'); expect(readdirSync(home)).toEqual([]); expect(readdirSync(workspace)).toEqual([]);
});

test('standalone inspection loads migratable settings without rewriting or creating receipts', async () => {
  const home = makeProjectTempDir('host-preview-migration'); mkdirSync(join(home, '.goodvibes', 'tui'), { recursive: true });
  const path = join(home, '.goodvibes', 'tui', 'settings.json'); const source = JSON.stringify({ danger: { daemon: false }, daemon: { enabled: true }, controlPlane: { host: '127.0.0.1', port: 1 } }); writeFileSync(path, source);
  const lines: string[] = [];
  await runTuiHostCommand(['pair'], { homeDirectory: home, defaultWorkingDirectory: home }, terminal(lines));
  expect(readFileSync(path, 'utf8')).toBe(source); expect(readdirSync(join(home, '.goodvibes'))).toEqual(['tui']); expect(readdirSync(join(home, '.goodvibes', 'tui'))).toEqual(['settings.json']);
});

test('unsafe symlink ancestry is not repaired and cannot write configuration through the link', async () => {
  const home = makeProjectTempDir('host-preview-symlink'); const target = makeProjectTempDir('host-preview-target'); symlinkSync(target, join(home, '.goodvibes'));
  const lines: string[] = [];
  expect(await runTuiHostCommand(['pair', '--url', 'http://127.0.0.1:1', '--bootstrap-shared'], { homeDirectory: home, defaultWorkingDirectory: home }, terminal(lines))).toBe(1);
  expect(readdirSync(target)).toEqual([]); expect(lines.join('\n')).toContain('could not be verified');
});

for (const args of [['pair', '--yes'], ['pair', '--token', 'synthetic-secret'], ['pair', '--apply'], ['pair', '--url', 'http://127.0.0.1:1/path'], ['pair', '--name', 'one', '--name', 'two']]) test(`unsupported or nonterminal apply performs no state changes: ${args[1]}`, async () => {
  const home = makeProjectTempDir('host-options'); const lines: string[] = [];
  expect(await runTuiHostCommand(args, { homeDirectory: home, defaultWorkingDirectory: home }, terminal(lines))).toBe(2);
  expect(existsSync(join(home, '.goodvibes'))).toBe(false); expect(lines.join('\n')).not.toContain('synthetic-secret');
});
