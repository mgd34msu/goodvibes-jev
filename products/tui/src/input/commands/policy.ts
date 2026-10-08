import { POLICY_COMMAND, runPolicyCommand } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import type { SlashCommand, CommandContext } from '../command-registry.ts';
import { createPolicyCommandContext } from './policy-dispatch.ts';

export const policyCommand: SlashCommand = {
  ...POLICY_COMMAND,
  aliases: [...POLICY_COMMAND.aliases],
  description: 'Open the policy modal or manage versioned policy bundles (load, simulate, diff, promote, rollback)',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    await runPolicyCommand(args, createPolicyCommandContext(context));
  },
};
