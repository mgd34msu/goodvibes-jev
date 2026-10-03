import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metadataCliResult } from '../../cli/metadata.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp } from '../../cli/help.ts';

test('metadata commands retain parser precedence and normal commands continue to runtime', () => {
  expect(metadataCliResult(['--help'])?.stdout).toBe(renderGoodVibesHelp());
  expect(metadataCliResult(['profiles', '--help'])?.stdout).toBe(renderGoodVibesCommandHelp('profiles'));
  expect(metadataCliResult(['help', 'profiles'])?.stdout).toBe(renderGoodVibesCommandHelp('profiles'));
  expect(metadataCliResult(['--version'])?.stdout).toBe('goodvibes-agent 2.1.0');
  expect(metadataCliResult(['--not-an-option'])?.exitCode).toBe(2);
  expect(metadataCliResult(['status'])).toBeNull();
  expect(metadataCliResult(['--prompt', 'ordinary prompt'])).toBeNull();
});

test('source and package launchers run metadata commands without creating Agent runtime state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-agent-cli-'));
  try {
    for (const [entry, args, expected, exitCode] of [
      ['../../main.ts', ['--help'], 'Usage: goodvibes-agent', 0],
      ['../../../bin/goodvibes-agent.ts', ['--version'], 'goodvibes-agent 2.1.0', 0],
      ['../../main.ts', ['completion', 'bash'], 'complete ', 0],
      ['../../main.ts', ['--not-an-option'], 'Usage: goodvibes-agent', 2],
    ] as const) {
      const process = Bun.spawn([Bun.which('bun')!, new URL(entry, import.meta.url).pathname, ...args], {
        cwd: root,
        env: { PATH: globalThis.process.env.PATH, HOME: root, GOODVIBES_AGENT_HOME: root },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      expect(code).toBe(exitCode);
      expect(stdout + stderr).toContain(expected);
      // Bun may create its own .bun transpiler cache under an isolated HOME.
      expect(readdirSync(root)).not.toContain('.goodvibes');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
