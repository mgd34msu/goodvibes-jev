import type { CommandRegistry } from '../command-registry.ts';

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'welcome',
    aliases: ['guide'],
    description: 'Open the Agent workspace',
    usage: '[open|print]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        if (ctx.executeCommand && await ctx.executeCommand('agent', [])) return;
        if (ctx.openAgentWorkspace) {
          ctx.openAgentWorkspace();
          return;
        }
        ctx.print('Use /agent to open the Agent workspace.');
        return;
      }
      if (sub === 'print') {
        ctx.print([
          'Welcome To GoodVibes Agent',
          '  /setup              - open the Agent workspace',
          '  /agent              - open the Agent operator workspace',
          '  /knowledge          - inspect isolated Agent Knowledge status, ask/search, libraries, map, connectors, and ingest paths',
          '  /memory             - manage Agent-local memory',
          '  /personas           - manage Agent-local personas',
          '  /skills             - manage reusable Agent-local skills',
          '  /routines           - manage Agent-local routines',
          '  /delegate           - explicitly hand build/fix/review work to GoodVibes TUI',
        ].join('\n'));
        return;
      }
      ctx.print('Usage: /welcome [open|print]');
    },
  });
}
