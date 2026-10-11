import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveHarnessCommandDetail, type CommandDetailLookup } from './agent-harness-command-catalog.ts';
import type { AgentHarnessToolDeps } from './agent-harness-tool-types.ts';
import { error, output } from './agent-harness-tool-utils.ts';
import { forwardHarnessCatalogCall, harnessCatalogExecutionGuard, harnessCatalogInvocationAuthority, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { describeCommandPolicy } from './agent-harness-metadata.ts';

function invocationArgsFromLookup(lookup: CommandDetailLookup): readonly string[] {
  return lookup.resolvedBy === 'description' ? [] : lookup.parsedArgs;
}

function safeCommandDisplay(name: string): string {
  return `/${name}`;
}

/** Only trusted workspace routing calls this with its concrete command. */
export function runTranslatedWorkspaceCommand(deps: AgentHarnessToolDeps, original: Record<string, unknown>, command: string, options?: Parameters<Tool['execute']>[1]) {
  const adapter: Tool = { definition: { name: 'workspace-command-route', description: 'Trusted concrete workspace command route.', parameters: {} },
    execute(args, exactOptions) { return runCommand(deps, args, {
      signal: exactOptions?.signal, assertCurrent: harnessCatalogExecutionGuard(args, exactOptions), retainCurrent: retainHarnessCatalogCurrent(args),
    }, exactOptions); } };
  return forwardHarnessCatalogCall(adapter, original, { ...original, command }, options);
}

export async function runCommand(deps: AgentHarnessToolDeps, args: Record<string, unknown>, options: CatalogRankingOptions = {}, executionOptions?: Parameters<Tool['execute']>[1]): Promise<{ readonly success: boolean; readonly output?: string; readonly error?: string }> {
  const registry = deps.commandRegistry, execute = registry.execute, context = deps.commandContext;
  const resolved = await resolveHarnessCommandDetail(deps.commandRegistry, args, options);
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (resolved?.status === 'found') resolved.assertCurrent?.();
  if (resolved?.status === 'ambiguous') {
    return error(`Ambiguous slash command ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
  }
  if (!resolved) return error('run_command requires a valid command, commandName, target, or query. Use mode:"commands" to inspect available commands.');

  // Registry ranking is low-stakes discovery, never an effect grant. Even a
  // sole yes requires the caller to name the selected command in a new call.
  if (resolved.lookup.resolvedBy === 'description') return output({
    status: 'selection_required', reason: 'exact_command_identity_required',
    candidates: [{ commandName: resolved.command.name, inspectRoute: `workspace action:"command" commandName:"${resolved.command.name}"` }],
  });

  const assertCommandEffect = (name: string, commandArgs: readonly string[]) => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const policy = describeCommandPolicy(name);
    // These work-import verbs are host-owned reads. Every mutation keeps the
    // original invocation floor as well as the command's own host authority.
    const read = policy.effect === 'read-only' || name === 'work-import' && ['preview', 'status'].includes(commandArgs[0] ?? '');
    if (!read && !harnessCatalogInvocationAuthority(args, executionOptions,
      ['local-state', 'ui-navigation', 'session-lifecycle'].includes(policy.effect) ? 'write' : 'send')) throw new ToolInputProjectionError('held');
    resolved.assertCurrent?.();
    if (deps.commandRegistry !== registry || registry.execute !== execute || deps.commandContext !== context) throw new ToolInputProjectionError('held');
  };

  const printed: string[] = [];
  const toolContext: CommandContext = {
    ...deps.commandContext,
    judgmentReadingOptions: { signal: options.signal, assertCurrent: () => {
      options.signal?.throwIfAborted(); options.assertCurrent?.(); resolved.assertCurrent?.();
      if (deps.commandRegistry !== registry || registry.execute !== execute || deps.commandContext !== context) throw new ToolInputProjectionError('stale');
    } },
    // This is the model running a command, not the owner typing one. Said out
    // loud because a command that grants authority must be able to tell the
    // difference, and everything reaching this function is a model tool call,
    // including one a model made after reading a page that suggested it.
    invokedByModel: true,
    print: (text: string) => {
      printed.push(text);
    },
    renderRequest: () => {},
    executeCommand: async (name: string, commandArgs: string[]) => {
      assertCommandEffect(name, commandArgs);
      const handled = await execute.call(registry, name, commandArgs, toolContext);
      options.signal?.throwIfAborted(); options.assertCurrent?.(); resolved.assertCurrent?.();
      return handled;
    },
  };
  const commandArgs = invocationArgsFromLookup(resolved.lookup);
  assertCommandEffect(resolved.command.name, commandArgs);
  if (deps.commandRegistry.get(resolved.command.name) !== resolved.command) throw new ToolInputProjectionError('stale');
  const handled = await execute.call(registry, resolved.command.name, [...commandArgs], toolContext);
  options.signal?.throwIfAborted(); options.assertCurrent?.(); resolved.assertCurrent?.();
  if (!handled) return error(`Unknown slash command /${resolved.command.name}.`);
  const MAX_PRINTED_CHARS = 6000;
  const raw = printed.length > 0 ? printed.join('\n') : '(no text output)';
  const printedText = raw.length > MAX_PRINTED_CHARS
    ? `${raw.slice(0, MAX_PRINTED_CHARS)}\n... output truncated`
    : raw;
  return output([
    `Command ${safeCommandDisplay(resolved.command.name)} completed.`,
    `Resolved by ${resolved.lookup.source} ${resolved.lookup.resolvedBy}.`,
    printedText,
  ].join('\n'));
}
