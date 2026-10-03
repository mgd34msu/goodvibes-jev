/**
 * `/owner-profile`, read, trace, correct and delete what the platform knows
 * about him, from inside a session.
 *
 * A thin wrapper over the same `handleOwnerProfileCommand` the top-level CLI
 * runs, in the shape `compat-runtime.ts` already uses: parse, build a
 * `CliCommandRuntime`, print the result. One implementation, so the shell and
 * the shell-less binary can never answer differently, which matters more here
 * than usual, because "what do you know about me" and "where did you get that"
 * have to mean the same thing wherever he asks them.
 *
 * Named `owner-profile` rather than `profile` for the reason the CLI command is:
 * `profile` already means the isolated Agent profile homes, and breaking a
 * working command to win a name is a bad trade.
 *
 * This command's output lands in the transcript, which is model context, so it
 * asks the handler for the counted rendering of the People section rather than
 * the listed one (§10); `person <name>` is the way through. The same handler run
 * from a shell prints his full list, because nothing there reaches a model.
 */

import type { CliCommandRuntime } from '../../cli/management.ts';
import { handleOwnerProfileCommand } from '../../cli/owner-profile-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

export function registerOwnerProfileRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'owner-profile',
    aliases: ['about-me'],
    description: 'Your profile: read it, see where a fact came from, correct one, or forget one',
    usage: '[read|get <fieldId>|person <name>|provenance <fieldId>|set <fieldId> <value> --yes|forget <fieldId> --yes|status]',
    argsHint: 'read|get|person|provenance|set|forget|status',
    async handler(args, ctx) {
      const cli = parseGoodVibesCli(['owner-profile', ...args], 'goodvibes-agent');
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
      // Stated rather than defaulted, because it is true of THIS call site for a
      // concrete reason: ctx.print puts the output in the session transcript,
      // which a later turn can compose from. The default is the same answer, so
      // forgetting this line would be safe, saying it makes the reason legible.
      const result = await handleOwnerProfileCommand(runtime, { outputEntersModelContext: true });
      ctx.print(result.output);
    },
  });
}
