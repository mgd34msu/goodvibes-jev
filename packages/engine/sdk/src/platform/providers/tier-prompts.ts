/**
 * Tier-based system prompt supplements.
 *
 * Model capability tiers drive how much extra guidance is injected into
 * the system prompt.  All features remain available regardless of tier;
 * only the verbosity of the guidance changes. The tier is read by routing
 * (readTierPromptSupplement); the supplement texts are fixed.
 */

import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ModelTier } from './registry.js';
import type { ModelFacts, ModelTierStore } from '../routing/model-tiers.js';
import { GUIDANCE_TIER_WHEN_UNSETTLED } from '../routing/policy.js';
import type { RouteTier } from '../routing/tiers.js';
export type { ModelTier };

/** The guidance level each capability tier gets: the smallest models the most. */
const GUIDANCE_FOR_TIER: Readonly<Record<RouteTier, ModelTier>> = {
  economy: 'free',
  standard: 'standard',
  premium: 'premium',
};

/** The audience receiving fixed tier guidance. Omitted preserves agent behavior. */
export type TierPromptAudience = 'agent' | 'conversation';

export interface TierPromptSupplementOptions {
  readonly audience?: TierPromptAudience | undefined;
}

function cancelledTierPrompt(): JudgmentError {
  // Abort reasons can contain private caller context. Follow the judgment
  // protocol's fixed cancellation error rather than echoing signal.reason.
  return new JudgmentError('aborted', 'the judgment call was cancelled');
}

function assertTierPromptActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledTierPrompt();
}

/** Stop this caller's wait without owning or cancelling another caller's shared promise. */
function awaitTierReading(
  reading: ReturnType<ModelTierStore['read']>,
  signal?: AbortSignal,
): ReturnType<ModelTierStore['read']> {
  if (!signal) return reading;
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => { cleanup(); reject(cancelledTierPrompt()); };
    signal.addEventListener('abort', onAbort, { once: true });
    // Both handlers remain attached after cancellation so late rejection is
    // consumed. No listener or pending prompt survives this caller's abort.
    void reading.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * The supplement for a model, from its capability tier as routing.model-tier
 * reads it from the model's published facts (remembered per model), in place
 * of the old context-window thresholds. A model whose tier reading does not
 * settle gets the guidance policy.ts names for that case.
 */
export async function readTierPromptSupplement(
  model: ModelFacts,
  tiers: Pick<ModelTierStore, 'read'>,
  site = 'providers.tier-prompts',
  options: TierPromptSupplementOptions & { readonly signal?: AbortSignal | undefined } = {},
): Promise<string> {
  // The store may serve a cached/shared reading without observing this caller's
  // signal. Check on both sides so a cancelled prompt cannot consume a late tier.
  assertTierPromptActive(options.signal);
  try {
    const { tier } = await awaitTierReading(tiers.read(model, {
      site,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }), options.signal);
    assertTierPromptActive(options.signal);
    return getTierPromptSupplement(GUIDANCE_FOR_TIER[tier ?? GUIDANCE_TIER_WHEN_UNSETTLED], options);
  } catch (error) {
    assertTierPromptActive(options.signal);
    throw error;
  }
}

/**
 * Returns supplemental system prompt content based on the model's capability
 * tier.  The returned string is appended to the base system prompt before
 * each LLM call.
 *
 * - free   , explicit tool-call examples, multi-agent reminders, structured
 *             output enforcement (~300 tokens); conversations keep only the
 *             tool guidance
 * - standard, brief reminders about tool usage and plan adherence (~80 tokens)
 * - premium , empty; capable models need no extra hand-holding
 */
export function getTierPromptSupplement(tier: ModelTier, options: TierPromptSupplementOptions = {}): string {
  switch (tier) {
    case 'free':
      return options.audience === 'conversation' ? CONVERSATION_FREE_SUPPLEMENT : FREE_SUPPLEMENT;
    case 'standard':
      return STANDARD_SUPPLEMENT;
    case 'premium':
      return '';
    case 'subscription':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Supplement text
// ---------------------------------------------------------------------------

const FREE_SUPPLEMENT = `## Agent Guidance

You are operating in a multi-agent system. Follow these rules carefully:

**Tool calls, required format:**
Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

Example, correct agent spawn:
\`\`\`json
{ "name": "agent", "input": { "task": "<task>", "mode": "engineer" } }
\`\`\`

**Multi-agent workflows:**
When a plan requires multiple parallel agents, spawn ALL of them before
waiting for results, do not spawn one, wait, then spawn the next. Parallel
spawns run concurrently and complete faster.

**Structured output:**
Your final message MUST end with the required JSON completion block. Omitting
it causes the orchestrator to treat your run as failed.

**Plan adherence:**
Complete the full plan. Do not stop after the first step and ask for
confirmation, there is no human watching. Make the best choice and continue.`;

/** Upstream's person-facing guidance: tool discipline without unattended-agent rules. */
const CONVERSATION_FREE_SUPPLEMENT = `## Tool guidance

Every tool call must include ALL required parameters. Missing parameters cause
silent failures. When in doubt, check the tool's schema before calling it.

When work needs several independent agents, spawn all of them before waiting
for any result: parallel spawns run concurrently and finish sooner.`;

const STANDARD_SUPPLEMENT = `## Reminders
- Include all required parameters in every tool call.
- When spawning agents, use the correct \`mode\` parameter.
- Complete your full plan before reporting results.`;
