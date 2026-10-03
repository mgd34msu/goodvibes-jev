/**
 * TUI slash commands for the connected host's CI-watch, principal registry,
 * and per-channel profile admin families: /ci, /principals, /channel-profiles.
 *
 * These are thin bridges onto the exact same CLI handlers the terminal
 * commands use (src/cli/ci-command.ts, principals-command.ts,
 * channel-profiles-command.ts): the TUI handler re-parses the invocation
 * through the real CLI parser and hands the result to the CLI handler, so
 * subcommand grammar, --yes confirmation gates, per-job CI conclusion
 * rendering, and connected-host failure classification can never drift
 * between the two surfaces. Output prints into the transcript verbatim.
 */
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { CliCommandOutput } from '../../cli/types.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleCiCommand } from '../../cli/ci-command.ts';
import { handlePrincipalsCommand } from '../../cli/principals-command.ts';
import { handleChannelProfilesCommand } from '../../cli/channel-profiles-command.ts';
import { requireShellPaths } from './runtime-services.ts';

function buildCliRuntime(ctx: CommandContext, command: string, args: readonly string[]): CliCommandRuntime {
  const shellPaths = requireShellPaths(ctx);
  return {
    cli: parseGoodVibesCli([command, ...args]),
    configManager: ctx.platform.configManager,
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
  };
}

async function runBridgedCliCommand(
  ctx: CommandContext,
  command: string,
  args: readonly string[],
  handler: (runtime: CliCommandRuntime) => Promise<CliCommandOutput>,
): Promise<void> {
  const result = await handler(buildCliRuntime(ctx, command, args));
  ctx.print(result.output);
}

export function registerConnectedHostAdminCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'ci',
    description: 'Check a repo/PR CI status with per-job conclusions and manage standing CI watches on the connected host',
    hidden: true,
    usage: 'status <repo> [--ref <ref>] [--pr <number>] | watches list | watches create <repo> --delivery-channel <channel> [--trigger-fix-session] --yes | watches run <watch-id> | watches delete <watch-id> --yes',
    argsHint: 'status <repo> | watches list',
    async handler(args, ctx) {
      await runBridgedCliCommand(ctx, 'ci', args, handleCiCommand);
    },
  });
  registry.register({
    name: 'principals',
    aliases: ['principal'],
    description: 'Manage the connected host cross-channel principal identity registry',
    hidden: true,
    usage: 'list | get <id> | resolve --channel <channel> --value <value> | create --name <name> --kind <user|bot|service|token> [--identity channel:value] --yes | update <id> [...] --yes | delete <id> --yes',
    argsHint: 'list | resolve --channel slack --value U123',
    async handler(args, ctx) {
      await runBridgedCliCommand(ctx, 'principals', args, handlePrincipalsCommand);
    },
  });
  registry.register({
    name: 'channel-profiles',
    aliases: ['channel-profile'],
    description: 'Manage per-channel session profile bindings (model, provider, permission mode) on the connected host',
    hidden: true,
    usage: 'list | get <surface-kind> [--channel-id <id>] | set <surface-kind> [--model <model>] [--provider <provider>] [--permission-mode <mode>] --yes | delete <surface-kind> --yes',
    argsHint: 'list | get slack',
    async handler(args, ctx) {
      await runBridgedCliCommand(ctx, 'channel-profiles', args, handleChannelProfilesCommand);
    },
  });
}
