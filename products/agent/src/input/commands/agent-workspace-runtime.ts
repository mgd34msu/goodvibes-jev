import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { AGENT_WORKSPACE_CATEGORY_IDS } from '../agent-workspace-types.ts';

const AGENT_WORKSPACE_ARGS_HINT = `${AGENT_WORKSPACE_CATEGORY_IDS.join('|')}|connected-host`;

export function registerAgentWorkspaceRuntimeCommands(registry: CommandRegistry): void {
  function openAgentWorkspace(ctx: CommandContext, categoryId: string | undefined): void {
    if (!ctx.openAgentWorkspace) {
      ctx.print('Agent operator workspace is not available in this runtime.');
      return;
    }
    ctx.openAgentWorkspace(categoryId);
  }

  registry.register({
    name: 'work',
    description: 'Inspect the native read-only work ledger on the selected daemon host',
    usage: '[daemon-project-id]',
    handler(args, ctx) {
      if (args.length > 1) { ctx.print('Usage: /work [daemon-project-id]'); return; }
      if (args[0]) ctx.nativeWorkLedger?.selectProject(args[0]);
      openAgentWorkspace(ctx, 'work');
    },
  });
  registry.register({
    name: 'agent',
    aliases: ['home', 'operator'],
    description: 'Open the GoodVibes Agent operator workspace',
    usage: '[category]',
    argsHint: AGENT_WORKSPACE_ARGS_HINT,
    handler(args, ctx) {
      openAgentWorkspace(ctx, args[0]);
    },
  });
  registry.register({
    name: 'notes',
    aliases: ['scratchpad'],
    description: 'Open Agent-local scratchpad notes in the operator workspace',
    usage: '',
    handler(_args, ctx) {
      openAgentWorkspace(ctx, 'notes');
    },
  });
}
