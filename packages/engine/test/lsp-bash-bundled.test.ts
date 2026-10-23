import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

import { LspService } from '../sdk/src/platform/intelligence/lsp/service.ts';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.ts';

describe('bundled Bash LSP', () => {
  test('the native Node runtime preserves nested formatting defaults and validates ShellCheck diagnostics', () => {
    const require = createRequire(new URL('../package.json', import.meta.url));
    const manifest = require.resolve('bash-language-server/package.json');
    const output = execFileSync('node', ['-e', `
      const { createRequire } = require('node:module');
      const bash = createRequire(process.argv[1]);
      const { ConfigSchema, getDefaultConfiguration } = bash('./out/config.js');
      const { ShellCheckResultSchema } = bash('./out/shellcheck/types.js');
      const diagnostic = { file: 'fixture.sh', line: 1, endLine: 1, column: 1, endColumn: 5,
        level: 'warning', code: 2086, message: 'Quote the expansion', fix: null };
      console.log(JSON.stringify({ defaults: getDefaultConfiguration(),
        configured: ConfigSchema.parse({ shfmt: { languageDialect: 'posix' }, shellcheckArguments: ' --external-sources  --severity=warning ' }),
        invalidConfigAccepted: ConfigSchema.safeParse({ backgroundAnalysisMaxFiles: -1 }).success,
        diagnostics: ShellCheckResultSchema.parse({ comments: [diagnostic] }),
        invalidDiagnosticAccepted: ShellCheckResultSchema.safeParse({ comments: [{ ...diagnostic, level: 'unsupported' }] }).success }));
    `, manifest], { encoding: 'utf8' });
    const result = JSON.parse(output);
    expect(result.defaults.shfmt).toMatchObject({ path: 'shfmt', languageDialect: 'auto', ignoreEditorconfig: false });
    expect(result.configured.shfmt).toMatchObject({ path: 'shfmt', languageDialect: 'posix', ignoreEditorconfig: false });
    expect(result.configured.shellcheckArguments).toEqual(['--external-sources', '--severity=warning']);
    expect(result.diagnostics.comments[0]).toMatchObject({ code: 2086, level: 'warning', fix: null });
    expect(result.invalidConfigAccepted).toBe(false);
    expect(result.invalidDiagnosticAccepted).toBe(false);
  });

  test('does not substitute embedded Bash for a different missing command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-bash-lsp-other-'));
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const service = new LspService(paths);
    try {
      service.registerServer('other', { command: 'goodvibes-fixture-absent-lsp', args: [] });
      expect(await service.isAvailable('other')).toBe(false);
    } finally {
      await service.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('resolves and starts bash-language-server from the SDK package install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-bash-lsp-'));
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const service = new LspService(paths);

    try {
      service.registerServer('bash', { command: 'bash-language-server', args: ['start'] });

      expect(await service.isAvailable('bash')).toBe(true);
      const client = await service.getClient('bash');
      expect(client?.isRunning).toBe(true);
    } finally {
      await service.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
