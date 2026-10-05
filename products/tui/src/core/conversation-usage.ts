/**
 * conversation-usage.ts, usage totals folded from a transcript's assistant
 * messages (re-exported by conversation.ts).
 *
 * The fold is the SDK's (platform/core sumConversationUsage): a resumed
 * session hydrates its token counters and its context figure from it. The
 * context figure is the latest real turn request's; a follow-up
 * acknowledgement (sent without tool definitions) counts toward the totals
 * only, so the meter never drops to that smaller request's size.
 */

export { sumConversationUsage } from '@goodvibes-jev/engine/sdk/platform/core';

import { sumConversationUsage, type ConversationMessageSnapshot, type Orchestrator } from '@goodvibes-jev/engine/sdk/platform/core';

// Keep availability on the counter object: live turns mutate it, while a
// successful restore (including /clear) replaces it with a complete fold.
const unavailableUsage = new WeakSet<object>();

export function isConversationUsageAvailable(usage: object): boolean {
  return !unavailableUsage.has(usage);
}

export function isConversationContextAvailable(orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens'>): boolean {
  return isConversationUsageAvailable(orchestrator.usage) || orchestrator.lastInputTokens > 0;
}

/** Restore unknown billing as unavailable, without leaking persisted values. */
export function hydrateConversationUsage(
  conversation: { getMessageSnapshot(): readonly ConversationMessageSnapshot[] },
  orchestrator: Pick<Orchestrator, 'usage' | 'lastInputTokens'>,
): void {
  const messages = conversation.getMessageSnapshot();
  let restored: ReturnType<typeof sumConversationUsage>;
  try {
    restored = sumConversationUsage(messages);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // These are only the new live counters. Readers must not present them as
    // complete session totals, and no prior session's context survives.
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    unavailableUsage.add(usage);
    orchestrator.usage = usage;
    orchestrator.lastInputTokens = 0;
    return;
  }
  orchestrator.usage = restored.usage;
  orchestrator.lastInputTokens = restored.lastInputTokens;
}
