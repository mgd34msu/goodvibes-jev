import { previewAgentHostPairing } from '../../runtime/agent-host-pairing.ts';
import { formatSetupPairing } from '../../cli/setup-pair-command.ts';
import type { CommandRegistry } from '../command-registry.ts';

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['onboarding'],
    description: 'Open the Agent workspace',
    hidden: true,
    usage: '',
    async handler(args, ctx) {
      if (args[0] === 'pair') {
        const homeDirectory = ctx.workspace?.shellPaths?.homeDirectory;
        if (!homeDirectory) { ctx.print('Pairing preview is unavailable without an Agent home.'); return; }
        const preview = await previewAgentHostPairing({ configManager: ctx.platform.configManager, homeDirectory });
        ctx.print(`${formatSetupPairing(preview.result)}\n  Interactive /setup pair is preview-only. To confirm persistent administrative access, run goodvibes-agent setup pair --apply in a terminal.`);
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
