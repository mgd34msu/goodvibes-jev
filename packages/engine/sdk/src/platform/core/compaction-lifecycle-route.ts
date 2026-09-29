/**
 * compaction-lifecycle-route.ts
 *
 * Routes a conversation compaction the orchestrator runs through the
 * session's CompactionManager (runtime/compaction), so the compaction moves
 * the session's lifecycle state machine, emits the COMPACTION_* lifecycle
 * events and leaves a boundary commit. The compaction itself (structured,
 * distiller or small-window) is unchanged: the manager owns the lifecycle
 * around it, not the algorithm.
 */

import type { ProviderMessage } from '../providers/interface.js';
import { createCompactionManager } from '../runtime/compaction/index.js';
import type { CompactionManager } from '../runtime/compaction/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/manager.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { CompactionStrategy, CompactionTrigger } from '../runtime/compaction/types.js';
import type { CompactionReceipt } from './compaction-types.js';

/**
 * Create a session's CompactionManager at session init (the Orchestrator's
 * constructor). Null when the session has no runtime bus or no capability
 * gates: there is then no session bus for a lifecycle to be reported on. The
 * context window is read live from the session's provider registry, so it
 * follows a model change.
 */
export function createSessionCompactionManager(
  sessionId: string,
  bus: RuntimeEventBus | null,
  flags: FeatureFlagManager | null,
  getProviderRegistry: () => Pick<ProviderRegistry, 'getContextWindowForModel' | 'getCurrentModel'> | undefined,
): CompactionManager | null {
  if (!bus || !flags) return null;
  return createCompactionManager({
    sessionId,
    bus,
    flags,
    contextWindow: () => {
      const registry = getProviderRegistry();
      return registry ? registry.getContextWindowForModel(registry.getCurrentModel()) : 0;
    },
  });
}

/** The part of a session's CompactionManager the orchestrator routes through. */
export type CompactionLifecycleOwner = Pick<CompactionManager, 'runLifecycle'>;

/** What the orchestrator knows about a compaction before it runs. */
export interface ConversationCompactionRun {
  readonly trigger: CompactionTrigger;
  readonly strategy: CompactionStrategy;
  readonly messages: readonly ProviderMessage[];
  readonly tokenCount: number;
  readonly contextWindow: number;
  readonly threshold: number;
}

/**
 * Lifecycle strategy for a conversation compaction: a compaction forced by the
 * model's own context-full report is the reactive one; small-window
 * keep-last-N is the structural microcompact; the summarizing compaction
 * (structured or distiller) is autocompact.
 */
export function lifecycleStrategyFor(forcedByModelWarning: boolean, smallWindow: boolean): CompactionStrategy {
  if (forcedByModelWarning) return 'reactive';
  return smallWindow ? 'microcompact' : 'autocompact';
}

/** The lifecycle trigger for an orchestrator-run compaction. */
export function lifecycleTriggerFor(forcedByModelWarning: boolean): CompactionTrigger {
  return forcedByModelWarning ? 'prompt_too_long' : 'auto';
}

/**
 * Run `execute` (a conversation compaction) through the session's manager.
 * Without a manager (an orchestrator composed with no runtime bus or no
 * capability gates) the compaction runs directly, as there is no session bus
 * for its lifecycle to be reported on.
 */
export function routeConversationCompaction(
  owner: CompactionLifecycleOwner | null | undefined,
  run: ConversationCompactionRun,
  conversation: { getMessagesForLLM(): ProviderMessage[] },
  execute: () => Promise<CompactionReceipt | undefined>,
): Promise<CompactionReceipt | undefined> {
  if (!owner) return execute();
  return owner.runLifecycle({
    trigger: run.trigger,
    strategy: run.strategy,
    messages: run.messages,
    tokenCount: run.tokenCount,
    contextWindow: run.contextWindow,
    threshold: run.threshold,
    execute,
    outcome: (receipt) => {
      if (!receipt || receipt.outcome !== 'applied') return null;
      return {
        messages: conversation.getMessagesForLLM(),
        tokensAfter: receipt.tokensAfter,
        summary: `${receipt.trigger} ${receipt.strategy} compaction: ${receipt.messagesBefore} to ${receipt.messagesAfter} messages, ~${receipt.tokensBefore} to ~${receipt.tokensAfter} tokens${receipt.detail ? ` (${receipt.detail})` : ''}`,
        warnings: receipt.validationPassed ? [] : ['compaction validation reported warnings'],
      };
    },
  });
}
