import {
  dispatchPolicyCommand as dispatchEnginePolicyCommand,
  type PolicyFrontDoorContext,
} from '@goodvibes-jev/engine/sdk/platform/gate/policy';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/** Bind only surface services; policy decisions and workflow stay in the engine. */
export function createPolicyCommandContext(context: CommandContext): PolicyFrontDoorContext {
  return {
    print: (text) => context.print(text),
    get policyRuntimeState() { return context.extensions?.policyRuntimeState; },
    get policyRegistry() { return context.extensions?.policyRegistry; },
    workingDirectory: () => requireShellPaths(context).workingDirectory,
    config: () => context.platform.configManager.getAll(),
    listMcpServerSecurity: () => context.extensions.mcpRegistry.listServerSecurity(),
    get openPolicyPanel() {
      return context.openPolicyView ? () => context.openPolicyView!() : undefined;
    },
  };
}

/** Compatibility entry for callers that already selected a policy subcommand. */
export async function dispatchPolicyCommand(args: string[], context: CommandContext): Promise<void> {
  await dispatchEnginePolicyCommand(args, createPolicyCommandContext(context));
}

export { renderPolicyUsage } from '@goodvibes-jev/engine/sdk/platform/gate/policy';
