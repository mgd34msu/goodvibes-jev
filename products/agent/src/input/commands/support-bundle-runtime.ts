import type { CommandRegistry } from '../command-registry.ts';
import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleBundleCommand } from '../../cli/bundle-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { requireShellPaths } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

function bundleUsageFor(subcommand: string | undefined): string {
  if (subcommand === 'export') return '/bundle export [path] --yes';
  if (subcommand === 'import') return '/bundle import <path> --yes';
  if (subcommand === 'inspect') return '/bundle inspect <path>';
  return '/bundle [export [path] --yes|inspect <path>|import <path> --yes]';
}

function bundleActionFor(subcommand: string): string | null {
  if (subcommand === 'export') return 'export Agent support bundle';
  if (subcommand === 'import') return 'import Agent support bundle';
  return null;
}

export function registerSupportBundleRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'bundle',
    description: 'Export, inspect, or import redacted Agent support bundles from the TUI',
    hidden: true,
    usage: '[export [path] --yes|inspect <path>|import <path> --yes]',
    argsHint: 'export|inspect|import',
    async handler(args, ctx) {
      const confirmation = stripYesFlag(args);
      const cli = parseGoodVibesCli(['bundle', ...confirmation.rest], 'goodvibes-agent');
      if (cli.errors.length > 0) {
        ctx.print(cli.errors.join('\n'));
        return;
      }

      const subcommand = cli.commandArgs[0] ?? 'inspect';
      const guardedAction = bundleActionFor(subcommand);
      if (guardedAction !== null && !confirmation.yes) {
        requireYesFlag(ctx, guardedAction, bundleUsageFor(subcommand));
        return;
      }

      const shellPaths = requireShellPaths(ctx);
      const runtime: CliCommandRuntime = {
        cli,
        configManager: ctx.platform.configManager,
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      };
      let result;
      try {
        result = await handleBundleCommand(runtime);
      } catch (error) {
        ctx.print(`Could not complete bundle operation: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      ctx.print(result.output);
    },
  });
}
