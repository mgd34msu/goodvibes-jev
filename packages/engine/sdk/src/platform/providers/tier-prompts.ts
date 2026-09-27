/**
 * Tier-based system prompt supplements.
 *
 * Model capability tiers drive how much extra guidance is injected into
 * the system prompt.  All features remain available regardless of tier;
 * only the verbosity of the guidance changes. The tier is read by routing
 * (readTierPromptSupplement); the supplement texts are fixed.
 */

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

/**
 * The supplement for a model, from its capability tier as routing.model-tier
 * reads it from the model's published facts (remembered per model), in place
 * of the old context-window thresholds. A model whose tier reading does not
 * settle gets the guidance policy.ts names for that case.
 */
export async function readTierPromptSupplement(model: ModelFacts, tiers: Pick<ModelTierStore, 'read'>, site = 'providers.tier-prompts'): Promise<string> {
  const { tier } = await tiers.read(model, { site });
  return getTierPromptSupplement(GUIDANCE_FOR_TIER[tier ?? GUIDANCE_TIER_WHEN_UNSETTLED]);
}

/**
 * Returns supplemental system prompt content based on the model's capability
 * tier.  The returned string is appended to the base system prompt before
 * each LLM call.
 *
 * - free   , explicit tool-call examples, multi-agent reminders, structured
 *             output enforcement (~300 tokens)
 * - standard, brief reminders about tool usage and plan adherence (~80 tokens)
 * - premium , empty; capable models need no extra hand-holding
 */
export function getTierPromptSupplement(tier: ModelTier): string {
  switch (tier) {
    case 'free':
      return FREE_SUPPLEMENT;
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

const STANDARD_SUPPLEMENT = `## Reminders
- Include all required parameters in every tool call.
- When spawning agents, use the correct \`mode\` parameter.
- Complete your full plan before reporting results.`;
