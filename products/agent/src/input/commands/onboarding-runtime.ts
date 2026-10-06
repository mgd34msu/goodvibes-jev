import { previewAgentHostPairing } from '../../runtime/agent-host-pairing.ts';
import { formatSetupPairing } from '../../runtime/setup-pairing-presentation.ts';
import { isDirectOwnerCommandContext, type CommandRegistry } from '../command-registry.ts';

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['onboarding'],
    description: 'Open the Agent workspace',
    hidden: true,
    usage: '',
    async handler(args, ctx) {
      if (args[0] === 'pair') {
        let apply = false;
        let name = 'GoodVibes Agent';
        let named = false;
        for (let index = 1; index < args.length; index++) {
          const arg = args[index];
          if (arg === '--apply' && !apply) { apply = true; continue; }
          if (arg === '--name' && !named && args[index + 1] && !args[index + 1]!.startsWith('--')) {
            named = true; name = args[++index]!; continue;
          }
          ctx.print('Usage: /setup pair [--name <device-name>] [--apply]. --yes and inline confirmation are unsupported; apply requires fresh owner-terminal confirmation.');
          return;
        }
        if (apply && (!isDirectOwnerCommandContext(ctx, 'setup') || !ctx.beginSetupPairing)) {
          ctx.print('Pairing --apply requires the owner to type /setup pair --apply in the live Agent terminal. Model, harness and nested commands cannot grant persistent administrative access.');
          return;
        }
        if (isDirectOwnerCommandContext(ctx, 'setup') && ctx.beginSetupPairing) {
          await ctx.beginSetupPairing({ apply, name });
          return;
        }
        const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
        if (!homeDirectory) { ctx.print('Pairing preview is unavailable without an Agent home.'); return; }
        const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory }, name);
        ctx.print(`${formatSetupPairing(preview.result)}\n  Preview only. The owner can type /setup pair --apply in the live Agent terminal to review and confirm.`);
        return;
      }
      if (ctx.executeCommand && await ctx.executeCommand('agent', [])) return;
      if (!ctx.openAgentWorkspace) {
        ctx.print('Agent workspace is not available in this runtime.');
        return;
      }
      ctx.openAgentWorkspace();
    },
  });
}
