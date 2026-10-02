import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleCompatCommand } from '../../cli/agent-knowledge-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

export function registerCompatRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'compat',
    aliases: ['compatibility'],
    description: 'Inspect connected-host compatibility and Agent Knowledge route readiness',
    hidden: true,
    usage: '[--json]',
    argsHint: '[--json]',
    async handler(args, ctx) {
      const cli = parseGoodVibesCli(['compat', ...args], 'goodvibes-agent');
      if (cli.errors.length > 0) {
        ctx.print(cli.errors.join('\n'));
        return;
      }

      const shellPaths = requireShellPaths(ctx);
      const runtime: CliCommandRuntime = {
        cli,
        configManager: ctx.platform.configManager,
        workingDirectory: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      };
      const result = await handleCompatCommand(runtime);
      ctx.print(result.output);
    },
  });
}
