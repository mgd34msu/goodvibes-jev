import type { CommandRegistry } from '../command-registry.ts';

export function registerOnboardingRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'setup',
    aliases: ['onboarding'],
    description: 'Open the Agent workspace',
    hidden: true,
    usage: '',
    async handler(_args, ctx) {
      if (ctx.executeCommand && await ctx.executeCommand('agent', [])) return;
      if (!ctx.openAgentWorkspace) {
        ctx.print('Agent workspace is not available in this runtime.');
        return;
      }
      ctx.openAgentWorkspace();
    },
  });
}
