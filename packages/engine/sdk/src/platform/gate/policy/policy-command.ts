/**
 * `/policy`, the front door to the policy-bundle workflow.
 *
 * Hoisted from the TUI (src/input/commands/policy.ts). With no arguments the
 * surface opens its policy panel when it has one; every other form runs the
 * dispatcher (policy-dispatch.ts). The product registers the command with
 * these fields and calls {@link runPolicyCommand}.
 */
import { dispatchPolicyCommand, type PolicyCommandContext } from './policy-dispatch.js';

/** The command's registration fields; the product adds the handler. */
export const POLICY_COMMAND = {
  name: 'policy',
  aliases: ['pol'],
  description: 'Open the policy panel or manage versioned policy bundles (load, simulate, diff, promote, rollback)',
  usage: '<subcommand> [args]',
  argsHint: 'load|simulate|diff|lint|preflight|promote|rollback|status',
} as const;

export interface PolicyFrontDoorContext extends PolicyCommandContext {
  /** Opens the surface's policy panel, when it has one. */
  readonly openPolicyPanel?: (() => void) | undefined;
}

/** Runs `/policy [subcommand] [args]`. */
export async function runPolicyCommand(args: readonly string[], context: PolicyFrontDoorContext): Promise<void> {
  if (args.length === 0 && context.openPolicyPanel) {
    context.openPolicyPanel();
    return;
  }
  await dispatchPolicyCommand(args, context);
}
