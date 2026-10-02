import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { McpConfigScope, McpReloadResult, McpServerConfig } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { requireMcpApi, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';
import { quoteSlashCommandArg } from '../slash-command-parser.ts';

const MCP_ROLES = ['general', 'docs', 'filesystem', 'git', 'database', 'browser', 'automation', 'ops', 'remote'] as const;
const MCP_TRUST_MODES = ['constrained', 'ask-on-risk', 'allow-all', 'blocked'] as const;
const MCP_COMMAND_TRUST_MODES = ['constrained', 'ask-on-risk', 'blocked'] as const;
const MCP_ADD_COMMAND_USAGE = '/mcp add <name> <command> ... --yes; options: --scope project|global, --role <role>, --trust constrained|ask-on-risk|blocked, --env KEY=VALUE, --path <path>, --host <host>';
const MCP_TRUST_COMMAND_USAGE = '/mcp trust <server> <constrained|ask-on-risk|blocked> --yes';
const MCP_ROLE_COMMAND_USAGE = '/mcp role <server> <general|docs|filesystem|git|database|browser|automation|ops|remote> --yes';

interface ParsedMcpAddArgs {
  readonly scope: McpConfigScope;
  readonly server: McpServerConfig;
}

type McpSecurityServer = ReturnType<NonNullable<NonNullable<CommandContext['clients']>['mcpApi']>['listServerSecurity']>[number];
type McpDisplayTrustMode = NonNullable<McpServerConfig['trustMode']> | McpSecurityServer['trustMode'];
type McpDisplayRole = NonNullable<McpServerConfig['role']> | McpSecurityServer['role'];
type McpDisplayFreshness = McpSecurityServer['schemaFreshness'];

function isMcpRole(value: string): value is NonNullable<McpServerConfig['role']> {
  return MCP_ROLES.includes(value as NonNullable<McpServerConfig['role']>);
}

function isMcpTrustMode(value: string): value is NonNullable<McpServerConfig['trustMode']> {
  return MCP_TRUST_MODES.includes(value as NonNullable<McpServerConfig['trustMode']>);
}

function isMcpCommandTrustMode(value: string): value is Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'> {
  return MCP_COMMAND_TRUST_MODES.includes(value as Exclude<NonNullable<McpServerConfig['trustMode']>, 'allow-all'>);
}

function isMcpScope(value: string): value is McpConfigScope {
  return value === 'project' || value === 'global';
}

function stripMcpAddYesFlag(args: readonly string[]): { readonly rest: readonly string[]; readonly yes: boolean } {
  const rest: string[] = [];
  let yes = false;
  let passthrough = false;
  for (const token of args) {
    if (passthrough) {
      rest.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      rest.push(token);
      continue;
    }
    if (token === '--yes') {
      yes = true;
      continue;
    }
    rest.push(token);
  }
  return { rest, yes };
}

function formatMcpTrustMode(mode: McpDisplayTrustMode): string {
  if (mode === 'ask-on-risk') return 'ask on risky actions';
  if (mode === 'allow-all') return 'allow all actions';
  return mode.replace(/[_-]+/g, ' ');
}

function formatMcpFreshness(value: McpDisplayFreshness): string {
  if (value === 'quarantined') return 'needs review';
  return value.replace(/[_-]+/g, ' ');
}

function formatMcpRole(value: McpDisplayRole): string {
  return value.replace(/[_-]+/g, ' ');
}

function validateServerName(name: string): string | null {
  if (!name.trim()) return 'MCP server name is required.';
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return 'MCP server names may contain letters, numbers, dot, underscore, and dash only.';
  }
  return null;
}

function readFlagValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index + 1];
  if (!value) {
    throw new Error(`Missing value after ${flag}.`);
  }
  return value;
}

function parseAddServerArgs(args: string[]): ParsedMcpAddArgs {
  const name = args[1]?.trim();
  const command = args[2]?.trim();
  if (!name || !command) {
    throw new Error(`Usage: ${MCP_ADD_COMMAND_USAGE}`);
  }
  const nameError = validateServerName(name);
  if (nameError) throw new Error(nameError);

  const serverArgs: string[] = [];
  const env: Record<string, string> = {};
  const allowedPaths: string[] = [];
  const allowedHosts: string[] = [];
  let role: McpServerConfig['role'];
  let trustMode: McpServerConfig['trustMode'];
  let scope: McpConfigScope = 'project';
  let passthrough = false;
  const tokens = args.slice(3);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (passthrough) {
      serverArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (token === '--role') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpRole(value)) throw new Error(`Invalid MCP role "${value}". Expected one of ${MCP_ROLES.join(', ')}.`);
      role = value;
      index += 1;
      continue;
    }
    if (token === '--scope') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpScope(value)) throw new Error(`Invalid MCP scope "${value}". Expected project or global.`);
      scope = value;
      index += 1;
      continue;
    }
    if (token === '--trust') {
      const value = readFlagValue(tokens, index, token);
      if (!isMcpTrustMode(value)) throw new Error(`Invalid MCP trust mode "${value}". Expected one of ${MCP_TRUST_MODES.join(', ')}.`);
      if (!isMcpCommandTrustMode(value)) {
        throw new Error(`Use /settings -> MCP to explicitly enable allow-all.\nUsage: ${MCP_ADD_COMMAND_USAGE}`);
      }
      trustMode = value;
      index += 1;
      continue;
    }
    if (token === '--env') {
      const value = readFlagValue(tokens, index, token);
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error('MCP env entries must use KEY=VALUE.');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      index += 1;
      continue;
    }
    if (token === '--path') {
      allowedPaths.push(readFlagValue(tokens, index, token));
      index += 1;
      continue;
    }
    if (token === '--host') {
      allowedHosts.push(readFlagValue(tokens, index, token));
      index += 1;
      continue;
    }
    serverArgs.push(token);
  }

  return {
    scope,
    server: {
      name,
      command,
      ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(role ? { role } : {}),
      ...(trustMode ? { trustMode } : {}),
      ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    },
  };
}

async function reloadMcpRuntime(ctx: CommandContext): Promise<McpReloadResult> {
  const result = await requireMcpApi(ctx).reload(requireShellPaths(ctx));
  ctx.renderRequest();
  return result;
}

export function registerMcpRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'Manage MCP servers and their tools',
    hidden: true,
    usage: '[servers|review|tools [<server>]|config|add|remove|reload|auth-review|repair [server]]',
    argsHint: '[servers|review|tools|config|add --yes|remove --yes]',
    async handler(args, ctx) {
      const mcpApi = requireMcpApi(ctx);
      const listServerSecurity = () => mcpApi.listServerSecurity();
      const confirmation = args[0] === 'add' ? stripMcpAddYesFlag(args) : stripYesFlag(args);
      const commandArgs = [...confirmation.rest];
      const subcommand = commandArgs[0];
      if (!subcommand && ctx.openMcpWorkspace) {
        ctx.openMcpWorkspace();
        return;
      }
      if (subcommand === 'review') {
        const servers = listServerSecurity();
        const authRequired = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
        ctx.print([
          'MCP Review',
          `  servers: ${servers.length}`,
          `  connected: ${servers.filter((server) => server.connected).length}`,
          `  auth or repair attention: ${authRequired.length}`,
          ...servers.map((server) => `  ${server.name}  trust=${formatMcpTrustMode(server.trustMode)}  role=${formatMcpRole(server.role)}  status=${formatMcpFreshness(server.schemaFreshness)}  connected=${server.connected ? 'yes' : 'no'}`),
          '  next: /mcp auth-review',
          '  next: /mcp repair <server>',
        ].join('\n'));
        return;
      }
      if (subcommand === 'servers') {
        const servers = listServerSecurity();
        if (servers.length === 0) {
          ctx.print(
            'No MCP servers configured.\n'
            + 'Add servers to one of these locations (scanned in order):\n'
            + '  ~/.config/mcp/mcp.json               (global XDG)\n'
            + '  ~/.mcp/mcp.json                      (global dotdir)\n'
            + '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n'
            + '  .mcp/mcp.json                        (project-local)\n'
            + '  .goodvibes/mcp.json                  (goodvibes project)\n'
            + '\nOpen /mcp and choose Add or update server, or use Agent Workspace -> Tools & MCP -> Add MCP server.'
          );
          return;
        }
        ctx.print(formatMcpServerList(servers));
        return;
      }
      if (subcommand === 'tools') {
        const filterServer = commandArgs[1];
        ctx.print('Fetching MCP tool list...');
        let allTools;
        try {
          allTools = await mcpApi.listAllTools();
        } catch (e) {
          ctx.print(`Error listing tools: ${summarizeError(e)}`);
          return;
        }
        const tools = filterServer ? allTools.filter(t => t.serverName === filterServer) : allTools;
        if (tools.length === 0) {
          ctx.print(filterServer
            ? `No tools found for server "${filterServer}". Is it connected? Run /mcp to see server status.`
            : 'No MCP tools available. Configure servers in .goodvibes/mcp.json or ~/.config/mcp/mcp.json.');
          return;
        }
        const lines: string[] = [`MCP Tools (${tools.length} total):`];
        let lastServer = '';
        for (const tool of tools) {
          if (tool.serverName !== lastServer) {
            lines.push(`\n  [${tool.serverName}]`);
            lastServer = tool.serverName;
          }
          lines.push(`    ${tool.toolName}${tool.description ? `: ${tool.description}` : ''}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'auth-review') {
        const servers = listServerSecurity();
        const needingAttention = servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined');
        ctx.print(needingAttention.length > 0
          ? [
              'MCP Auth Review',
              ...needingAttention.map((server) => (
                `  ${server.name}  connected ${server.connected ? 'yes' : 'no'}  status ${formatMcpFreshness(server.schemaFreshness)}  trust ${formatMcpTrustMode(server.trustMode)}`
              )),
              '  next: /auth review',
              '  next: /mcp repair <server>',
            ].join('\n')
          : 'MCP Auth Review\n  No MCP servers currently need auth or quarantine recovery.');
        return;
      }

      if (subcommand === 'repair') {
        const serverName = commandArgs[1];
        const servers = listServerSecurity();
        const selected = serverName ? servers.find((server) => server.name === serverName) : servers.find((server) => !server.connected || server.schemaFreshness === 'quarantined');
        if (!selected) {
          ctx.print(serverName
            ? `Unknown MCP server ${serverName}`
            : 'MCP Repair\n  No MCP server currently needs repair.');
          return;
        }
        const nextSteps = [
          selected.schemaFreshness === 'quarantined'
            ? `/mcp quarantine ${quoteSlashCommandArg(selected.name)} approve operator --yes`
            : null,
          !selected.connected ? '/auth review' : null,
          '/mcp review',
          '/health review',
        ].filter((entry): entry is string => entry !== null);
        ctx.print([
          `MCP Repair: ${selected.name}`,
          `  connected: ${selected.connected ? 'yes' : 'no'}`,
          `  trust: ${formatMcpTrustMode(selected.trustMode)}`,
          `  role: ${formatMcpRole(selected.role)}`,
          `  status: ${formatMcpFreshness(selected.schemaFreshness)}`,
          ...(selected.quarantineReason ? [`  quarantine: ${selected.quarantineReason}`] : []),
          ...(selected.quarantineDetail ? [`  detail: ${selected.quarantineDetail}`] : []),
          '  next:',
          ...nextSteps.map((step) => `    ${step}`),
        ].join('\n'));
        return;
      }

      if (subcommand === 'trust') {
        const serverName = commandArgs[1];
        const requestedMode = commandArgs[2];
        if (serverName && requestedMode) {
          if (!isMcpTrustMode(requestedMode)) {
            ctx.print(`Invalid MCP trust mode "${requestedMode}". Expected constrained, ask-on-risk, blocked, or allow-all.\nUsage: ${MCP_TRUST_COMMAND_USAGE}\nUse /settings -> MCP to explicitly enable allow-all.`);
            return;
          }
          const mode = requestedMode;
          if (mode === 'allow-all') {
            ctx.print(`Use /settings → MCP to explicitly enable allow-all for ${serverName}. Direct command escalation is blocked.`);
            ctx.openSettingsModal?.();
            return;
          }
          if (!confirmation.yes) {
            requireYesFlag(ctx, `change MCP trust mode for ${serverName}`, MCP_TRUST_COMMAND_USAGE);
            return;
          }
          mcpApi.setServerTrustMode(serverName, mode);
          ctx.print(`Updated MCP trust mode for ${serverName} to ${formatMcpTrustMode(mode)}.`);
          return;
        }
        if (serverName || requestedMode) {
          ctx.print(`Usage: ${MCP_TRUST_COMMAND_USAGE}\nUse /settings -> MCP to explicitly enable allow-all.`);
          return;
        } else {
          ctx.print(`Usage: ${MCP_TRUST_COMMAND_USAGE}\nUse /settings -> MCP to explicitly enable allow-all.`);
          return;
        }
      }

      if (subcommand === 'role') {
        const serverName = commandArgs[1];
        const requestedRole = commandArgs[2];
        if (serverName && requestedRole) {
          if (!isMcpRole(requestedRole)) {
            ctx.print(`Invalid MCP role "${requestedRole}". Expected one of ${MCP_ROLES.join(', ')}.\nUsage: ${MCP_ROLE_COMMAND_USAGE}`);
            return;
          }
          const role = requestedRole;
          if (!confirmation.yes) {
            requireYesFlag(ctx, `change MCP role for ${serverName}`, MCP_ROLE_COMMAND_USAGE);
            return;
          }
          mcpApi.setServerRole(serverName, role);
          ctx.print(`Updated MCP role for ${serverName} to ${formatMcpRole(role)}.`);
          return;
        }
        if (serverName || requestedRole) {
          ctx.print(`Usage: ${MCP_ROLE_COMMAND_USAGE}`);
          return;
        } else {
          ctx.print(`Usage: ${MCP_ROLE_COMMAND_USAGE}`);
          return;
        }
      }

      if (subcommand === 'add') {
        if (!confirmation.yes) {
          requireYesFlag(ctx, 'add or update an MCP server config', MCP_ADD_COMMAND_USAGE);
          return;
        }
        let parsedAdd: ParsedMcpAddArgs;
        try {
          parsedAdd = parseAddServerArgs(commandArgs);
        } catch (error) {
          ctx.print(summarizeError(error));
          return;
        }
        const shellPaths = requireShellPaths(ctx);
        try {
          const result = await mcpApi.upsertServerConfig(shellPaths, parsedAdd.scope, parsedAdd.server);
          const connected = listServerSecurity().find((entry) => entry.name === parsedAdd.server.name)?.connected ?? false;
          ctx.print([
            `MCP server "${parsedAdd.server.name}" saved`,
            `  scope ${parsedAdd.scope}`,
            `  path ${result.path}`,
            ...(parsedAdd.scope === 'global' ? ['  global config'] : []),
            `  Runtime reload: ${connected ? 'connected' : 'server saved; connection needs attention'} (+${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged})`,
            `  command ${parsedAdd.server.command}${parsedAdd.server.args?.length ? ` ${parsedAdd.server.args.join(' ')}` : ''}`,
            '  next /mcp tools',
          ].join('\n'));
        } catch (error) {
          ctx.print(`MCP add failed ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'remove') {
        const serverName = commandArgs[1]?.trim();
        if (!serverName) {
          ctx.print('Usage: /mcp remove <server> [--scope project|global] --yes');
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(ctx, `remove MCP server ${serverName}`, '/mcp remove <server> [--scope project|global] --yes');
          return;
        }
        let scope: McpConfigScope = 'project';
        try {
          for (let index = 2; index < commandArgs.length; index += 1) {
            if (commandArgs[index] === '--scope') {
              const value = readFlagValue(commandArgs, index, '--scope');
              if (!isMcpScope(value)) {
                ctx.print(`Invalid MCP scope "${value}". Expected project or global.`);
                return;
              }
              scope = value;
              index += 1;
            }
          }
        } catch (error) {
          ctx.print(summarizeError(error));
          return;
        }
        const shellPaths = requireShellPaths(ctx);
        try {
          const result = await mcpApi.removeServerConfig(shellPaths, scope, serverName);
          ctx.print(result.removed
            ? `Removed MCP server "${serverName}" from ${scope} config ${result.path}. Reload +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`
            : `No ${scope} MCP server named "${serverName}" exists in ${result.path}.\nIf it still appears, it is coming from another config scope or external MCP config.`);
        } catch (error) {
          ctx.print(`MCP remove failed ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'reload') {
        if (!confirmation.yes) {
          requireYesFlag(ctx, 'reload the MCP runtime from config', '/mcp reload --yes');
          return;
        }
        try {
          const result = await reloadMcpRuntime(ctx);
          const servers = listServerSecurity();
          ctx.print(`Reloaded MCP runtime from config. ${servers.filter((server) => server.connected).length}/${servers.length} server(s) connected. Result +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`);
        } catch (error) {
          ctx.print(`MCP reload failed ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'config') {
        const shellPaths = requireShellPaths(ctx);
        try {
          const effective = mcpApi.getEffectiveConfig(shellPaths);
          ctx.print([
            'MCP Config',
            '  locations',
            ...effective.locations.map((location) => `    ${location.scope}/${location.kind}${location.writable ? ' writable' : ' read-only'}  ${location.path}`),
            `  effective servers ${effective.servers.length}`,
            ...effective.servers.map((entry) => {
              const server = entry.server;
              const envKeys = Object.keys(server.env ?? {});
              return `  - ${server.name}: ${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}  origin ${entry.source.scope}/${entry.source.kind}${envKeys.length ? ` envKeys=${envKeys.join(',')}` : ''}`;
            }),
            '',
            'Add or update from inside Agent with explicit confirmation',
            '  Open /mcp and choose Add or update server, or use Agent Workspace -> Tools & MCP -> Add MCP server.',
            '  Use Settings -> MCP for allow-all decisions.',
            '  Use -- before server args that look like Agent flags.',
            'Automation equivalent',
            `  ${MCP_ADD_COMMAND_USAGE}`,
          ].join('\n'));
        } catch (error) {
          ctx.print(`MCP config read failed ${summarizeError(error)}`);
        }
        return;
      }

      if (subcommand === 'quarantine') {
        const serverName = commandArgs[1];
        const action = commandArgs[2];
        if (!serverName) {
          ctx.print('Usage: /mcp quarantine <server> [detail] --yes\n       /mcp quarantine <server> approve [operatorId] --yes');
          return;
        }
        if (action === 'approve') {
          if (!confirmation.yes) {
            requireYesFlag(ctx, `approve MCP tool-definition quarantine override for ${serverName}`, '/mcp quarantine <server> approve [operatorId] --yes');
            return;
          }
          const operatorId = commandArgs[3] || 'operator';
          mcpApi.approveSchemaQuarantine(serverName, operatorId);
          ctx.print(`Approved MCP tool-definition quarantine override for ${serverName} as ${operatorId}. Refresh is still recommended.`);
          return;
        }
        if (!confirmation.yes) {
          requireYesFlag(ctx, `quarantine MCP server ${serverName}`, '/mcp quarantine <server> [detail] --yes');
          return;
        }
        const detail = commandArgs.slice(2).join(' ') || 'quarantined by operator';
        mcpApi.quarantineSchema(serverName, 'operator_flagged', detail);
        ctx.print(`Quarantined MCP tool definitions for ${serverName}.\nReason: ${detail}`);
        return;
      }

      const servers = listServerSecurity();
      if (servers.length === 0) {
        ctx.print(
          'No MCP servers configured.\n'
          + 'Add servers to one of these locations (scanned in order):\n'
          + '  ~/.config/mcp/mcp.json               (global XDG)\n'
          + '  ~/.mcp/mcp.json                      (global dotdir)\n'
          + '  ~/.config/claude/claude_desktop_config.json  (Claude Desktop)\n'
          + '  .mcp/mcp.json                        (project-local)\n'
          + '  .goodvibes/mcp.json                  (goodvibes project)\n'
          + '\nOpen /mcp and choose Add or update server, or use Agent Workspace -> Tools & MCP -> Add MCP server.\n'
          + '\nFormat: { "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }] }'
        );
        return;
      }

      ctx.print(formatMcpServerList(servers));
    },
  });
}

function formatMcpServerList(servers: readonly McpSecurityServer[]): string {
  const connected = servers.filter(s => s.connected);
  const disconnected = servers.filter(s => !s.connected);
  const lines: string[] = [`MCP Servers (${connected.length}/${servers.length} connected):`];
  for (const s of servers) {
    const pathScope = s.allowedPaths.length > 0 ? ` paths ${s.allowedPaths.length}` : '';
    const hostScope = s.allowedHosts.length > 0 ? ` hosts ${s.allowedHosts.length}` : '';
    const freshness = ` status ${formatMcpFreshness(s.schemaFreshness)}`;
    const quarantine = s.schemaFreshness === 'quarantined' ? ` review reason ${s.quarantineReason ?? 'unknown'}` : '';
    lines.push(`  ${s.connected ? '[connected]   ' : '[disconnected]'}  ${s.name}  trust=${formatMcpTrustMode(s.trustMode)}  role=${formatMcpRole(s.role)}${freshness}${quarantine}${pathScope}${hostScope}`);
  }
  if (connected.length > 0) {
    lines.push('');
    lines.push('Open "/mcp" for the fullscreen MCP workspace with server status, tools, config paths, and confirmed add/remove/reload actions.');
    lines.push('Use "/mcp tools" for a compact tool list, or "/mcp tools <server>" for one server.');
    lines.push('Use Settings -> MCP for allow-all decisions; trust, role, and quarantine command actions still require explicit --yes confirmation.');
    lines.push('Use /settings -> MCP to explicitly enable allow-all for a server.');
  }
  if (disconnected.length > 0) {
    lines.push('');
    lines.push(`${disconnected.length} server(s) failed to connect. Check server command and args in your config.`);
  }
  return lines.join('\n');
}
