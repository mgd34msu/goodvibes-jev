import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMcpRuntimeCommands } from '../../input/commands/mcp-runtime.ts';
import {
  loadMcpEffectiveConfig,
  removeMcpServerConfig,
  upsertMcpServerConfig,
} from '@goodvibes-jev/engine/sdk/platform/mcp';
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

interface McpCommandCallLog {
  reloads: number;
  upserts: number;
  removes: number;
  trustChanges: number;
  roleChanges: number;
  quarantines: number;
  quarantineApprovals: number;
}

function makeCallLog(): McpCommandCallLog {
  return {
    reloads: 0,
    upserts: 0,
    removes: 0,
    trustChanges: 0,
    roleChanges: 0,
    quarantines: 0,
    quarantineApprovals: 0,
  };
}

function makeContext(root: string, out: string[], callLog = makeCallLog()): CommandContext {
  const shellPaths = makeShellPaths(root);
  let connectedNames: string[] = [];
  const reload = async () => {
    callLog.reloads += 1;
    const effective = loadMcpEffectiveConfig(shellPaths);
    connectedNames = effective.servers.map((entry) => entry.server.name);
    return {
      added: connectedNames.length,
      changed: 0,
      removed: 0,
      unchanged: 0,
      servers: connectedNames.map((name) => ({ name, action: 'added' as const, connected: true })),
    };
  };
  const mcpApi = {
    getEffectiveConfig: () => loadMcpEffectiveConfig(shellPaths),
    reload,
    async upsertServerConfig(_roots: unknown, scope: 'project' | 'global', server: Parameters<typeof upsertMcpServerConfig>[2]) {
      callLog.upserts += 1;
      const result = upsertMcpServerConfig(shellPaths, scope, server);
      return { path: result.path, reload: await reload() };
    },
    async removeServerConfig(_roots: unknown, scope: 'project' | 'global', serverName: string) {
      callLog.removes += 1;
      const result = removeMcpServerConfig(shellPaths, scope, serverName);
      return { path: result.path, removed: result.removed, reload: await reload() };
    },
    listServerSecurity: () => loadMcpEffectiveConfig(shellPaths).servers
      .filter((entry) => connectedNames.includes(entry.server.name))
      .map((entry) => ({
        name: entry.server.name,
        connected: true,
        role: entry.server.role ?? 'general',
        trustMode: entry.server.trustMode ?? 'constrained',
        allowedPaths: entry.server.allowedPaths ?? [],
        allowedHosts: entry.server.allowedHosts ?? [],
        schemaFreshness: 'fresh' as const,
      })),
    listAllTools: async () => [],
    listServers: () => [],
    listServerNames: () => connectedNames,
    listSandboxBindings: () => [],
    listRecentSecurityDecisions: () => [],
    setServerTrustMode: () => {
      callLog.trustChanges += 1;
    },
    setServerRole: () => {
      callLog.roleChanges += 1;
    },
    quarantineSchema: () => {
      callLog.quarantines += 1;
    },
    approveSchemaQuarantine: () => {
      callLog.quarantineApprovals += 1;
    },
  };

  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    clients: { mcpApi } as never,
    renderRequest: () => {},
    print: (text: string) => out.push(text),
    exit: () => {},
  } as CommandContext;
}

describe('/mcp runtime config commands', () => {
  test('opens fullscreen MCP workspace when invoked without a subcommand', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      let opened = 0;
      const ctx = {
        ...makeContext(root, out),
        openMcpWorkspace: () => {
          opened += 1;
        },
      } as CommandContext;

      await registry.get('mcp')!.handler([], ctx);

      expect(opened).toBe(1);
      expect(out).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('/mcp servers prints read-only server readiness without opening workspace or mutating config', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      let opened = 0;
      const ctx = {
        ...makeContext(root, out, callLog),
        openMcpWorkspace: () => {
          opened += 1;
        },
      } as CommandContext;

      await registry.get('mcp')!.handler(['add', 'browser-tools', 'node', 'browser-server.js', '--role', 'browser', '--yes'], ctx);
      out.length = 0;
      callLog.reloads = 0;
      callLog.upserts = 0;

      await registry.get('mcp')!.handler(['servers'], ctx);

      const output = out.join('\n');
      expect(opened).toBe(0);
      expect(callLog.reloads).toBe(0);
      expect(callLog.upserts).toBe(0);
      expect(output).toContain('MCP Servers (1/1 connected):');
      expect(output).toContain('browser-tools');
      expect(output).toContain('role=browser');
      expect(output).toContain('/mcp tools');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses MCP config mutation without explicit --yes', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      const ctx = makeContext(root, out, callLog);

      await registry.get('mcp')!.handler(['add', 'docs', 'node', 'server.js'], ctx);

      expect(callLog.upserts).toBe(0);
      expect(callLog.reloads).toBe(0);
      expect(out.join('\n')).toContain('Refusing to add or update an MCP server config without --yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses direct MCP allow-all trust through add command', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      const ctx = makeContext(root, out, callLog);

      await registry.get('mcp')!.handler(['add', 'docs', 'node', 'server.js', '--trust', 'allow-all', '--yes'], ctx);

      const output = out.join('\n');
      expect(callLog.upserts).toBe(0);
      expect(callLog.reloads).toBe(0);
      expect(existsSync(join(root, '.goodvibes', 'mcp.json'))).toBe(false);
      expect(output).toContain('Use /settings -> MCP to explicitly enable allow-all.');
      expect(output).toContain('--trust constrained|ask-on-risk|blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves passthrough --yes as an MCP server argument', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      const ctx = makeContext(root, out, callLog);

      await registry.get('mcp')!.handler(['add', 'cli', 'node', 'server.js', '--', '--yes'], ctx);

      expect(callLog.upserts).toBe(0);
      expect(callLog.reloads).toBe(0);
      expect(out.join('\n')).toContain('Refusing to add or update an MCP server config without --yes');
      out.length = 0;

      await registry.get('mcp')!.handler(['add', 'cli', 'node', 'server.js', '--role', 'docs', '--yes', '--', '--yes', '--profile', 'local'], ctx);

      const config = JSON.parse(readFileSync(join(root, '.goodvibes', 'mcp.json'), 'utf-8')) as {
        servers: Array<{ name: string; command: string; args?: string[]; role?: string }>;
      };
      expect(callLog.upserts).toBe(1);
      expect(config.servers[0]).toMatchObject({
        name: 'cli',
        command: 'node',
        args: ['server.js', '--yes', '--profile', 'local'],
        role: 'docs',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('adds project-local MCP server and reloads runtime registry', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler([
        'add',
        'filesystem',
        'npx',
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '.',
        '--role',
        'filesystem',
        '--trust',
        'constrained',
        '--env',
        'FOO=bar',
        '--yes',
      ], ctx);

      const config = JSON.parse(readFileSync(join(root, '.goodvibes', 'mcp.json'), 'utf-8')) as {
        servers: Array<{ name: string; command: string; args?: string[]; role?: string; trustMode?: string; env?: Record<string, string> }>;
      };
      expect(config.servers).toHaveLength(1);
      expect(config.servers[0]).toMatchObject({
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
        role: 'filesystem',
        trustMode: 'constrained',
        env: { FOO: 'bar' },
      });
      expect(out.join('\n')).toContain('Runtime reload: connected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes project-local MCP server and reloads runtime registry', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler(['add', 'docs', 'node', 'server.js', '--yes'], ctx);
      await registry.get('mcp')!.handler(['remove', 'docs', '--yes'], ctx);

      const config = JSON.parse(readFileSync(join(root, '.goodvibes', 'mcp.json'), 'utf-8')) as { servers: unknown[] };
      expect(config.servers).toEqual([]);
      expect(out.join('\n')).toContain('Removed MCP server "docs"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('adds global MCP server when scope is selected', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);

      await registry.get('mcp')!.handler([
        'add',
        'docs',
        'node',
        'server.js',
        '--scope',
        'global',
        '--env',
        'SECRET=hidden',
        '--yes',
      ], ctx);
      await registry.get('mcp')!.handler(['config'], ctx);

      const config = JSON.parse(readFileSync(join(root, '.config', 'mcp', 'mcp.json'), 'utf-8')) as {
        servers: Array<{ name: string; command: string; env?: Record<string, string> }>;
      };
      expect(config.servers[0]).toMatchObject({ name: 'docs', command: 'node', env: { SECRET: 'hidden' } });
      expect(out.join('\n')).toContain('global config');
      expect(out.join('\n')).toContain('envKeys=SECRET');
      expect(out.join('\n')).not.toContain('hidden');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses MCP trust, role, reload, and quarantine mutation without --yes', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      const ctx = makeContext(root, out, callLog);

      await registry.get('mcp')!.handler(['trust', 'docs', 'blocked'], ctx);
      await registry.get('mcp')!.handler(['role', 'docs', 'docs'], ctx);
      await registry.get('mcp')!.handler(['reload'], ctx);
      await registry.get('mcp')!.handler(['quarantine', 'docs', 'review'], ctx);
      await registry.get('mcp')!.handler(['quarantine', 'docs', 'approve', 'operator'], ctx);

      expect(callLog.trustChanges).toBe(0);
      expect(callLog.roleChanges).toBe(0);
      expect(callLog.reloads).toBe(0);
      expect(callLog.quarantines).toBe(0);
      expect(callLog.quarantineApprovals).toBe(0);
      expect(out.join('\n')).toContain('without --yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('MCP trust and role usage include confirmation and invalid values fail closed', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const callLog = makeCallLog();
      const ctx = makeContext(root, out, callLog);

      await registry.get('mcp')!.handler(['trust', 'docs'], ctx);
      await registry.get('mcp')!.handler(['role', 'docs'], ctx);
      await registry.get('mcp')!.handler(['trust', 'docs', 'god-mode', '--yes'], ctx);
      await registry.get('mcp')!.handler(['role', 'docs', 'superuser', '--yes'], ctx);

      const output = out.join('\n');
      expect(callLog.trustChanges).toBe(0);
      expect(callLog.roleChanges).toBe(0);
      expect(output).toContain('Usage: /mcp trust <server> <constrained|ask-on-risk|blocked> --yes');
      expect(output).toContain('Usage: /mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote> --yes');
      expect(output).toContain('Invalid MCP trust mode "god-mode"');
      expect(output).toContain('Invalid MCP role "superuser"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('/mcp repair quotes quarantined server names in next-step commands', async () => {
    const root = makeProjectTempDir('gv-mcp-command');
    try {
      const registry = new CommandRegistry();
      registerMcpRuntimeCommands(registry);
      const out: string[] = [];
      const ctx = makeContext(root, out);
      const mcpApi = ctx.clients!.mcpApi!;
      (ctx.clients as Record<string, unknown>)['mcpApi'] = {
        ...mcpApi,
        listServerSecurity: () => [{
          name: 'imported docs server',
          connected: true,
          role: 'docs',
          trustMode: 'constrained',
          allowedPaths: [],
          allowedHosts: [],
          schemaFreshness: 'quarantined',
          quarantineReason: 'operator_review',
          quarantineDetail: 'Imported config needs review.',
        }],
      } as unknown as typeof mcpApi;

      await registry.get('mcp')!.handler(['repair'], ctx);

      expect(out.join('\n')).toContain('/mcp quarantine "imported docs server" approve operator --yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
