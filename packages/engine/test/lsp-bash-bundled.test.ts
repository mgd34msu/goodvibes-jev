import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LspService } from '../sdk/src/platform/intelligence/lsp/service.ts';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.ts';

describe('bundled Bash LSP', () => {
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
