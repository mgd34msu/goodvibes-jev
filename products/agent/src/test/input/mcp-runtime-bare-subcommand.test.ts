import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMcpRuntimeCommands } from '../../input/commands/mcp-runtime.ts';
import { loadMcpEffectiveConfig } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeShellPaths(root: string) {
  return {
    workingDirectory: root,
    homeDirectory: root,
    resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveUserPath: (...parts: string[]) => join(root, '.goodvibes', ...parts),
    resolveWorkspacePath: (...parts: string[]) => join(root, ...parts),
    isWithinWorkingDirectory: (path: string) => path.startsWith(root),
  };
}

function makeContext(root: string, out: string[]): CommandContext {
  const shellPaths = makeShellPaths(root);
  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {
      mcpApi: {
        getEffectiveConfig: () => loadMcpEffectiveConfig(shellPaths),
        reload: async () => ({ added: 0, changed: 0, removed: 0, unchanged: 0, servers: [] }),
        upsertServerConfig: async () => { throw new Error('should not be called'); },
        removeServerConfig: async () => { throw new Error('should not be called'); },
        listServerSecurity: () => [],
        listAllTools: async () => [],
        listServers: () => [],
        listServerNames: () => [],
        listSandboxBindings: () => [],
        listRecentSecurityDecisions: () => [],
        setServerTrustMode: () => {},
        setServerRole: () => {},
        quarantineSchema: () => {},
        approveSchemaQuarantine: () => {},
      },
    } as never,
    print: (text: string) => out.push(text),
    exit: () => {},
  } as unknown as CommandContext;
}

describe('/mcp bare subcommand usage', () => {
  test('/mcp trust with no args prints usage instead of falling through to server list', async () => {
    const root = makeProjectTempDir('gv-mcp-bare');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler(['trust'], ctx);

      const text = out.join('\n');
      expect(text).toContain('/mcp trust');
      expect(text).not.toContain('MCP Servers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('/mcp role with no args prints usage instead of falling through to server list', async () => {
    const root = makeProjectTempDir('gv-mcp-bare');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler(['role'], ctx);

      const text = out.join('\n');
      expect(text).toContain('/mcp role');
      expect(text).not.toContain('MCP Servers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
