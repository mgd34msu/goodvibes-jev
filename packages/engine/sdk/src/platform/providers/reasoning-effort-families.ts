/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Curated per-family-generation reasoning-effort table.
 *
 * Consulted when the live models.dev catalog carries nothing for a model,
 * a stale or missing catalog entry, a self-hosted endpoint, a gateway that
 * re-exposes a known model under its own id. Every row is sourced from the
 * provider's own current documentation, cited inline, and re-checked whenever
 * the date below is bumped. The live catalog outranks this table; this table
 * outranks the labelled best-guess ladder.
 *
 * The rows are documented request-field facts and stay code. Which row a
 * model id belongs to, through gateway paths, region prefixes, version and
 * date suffixes and local tags, is read by routing.reasoning-family
 * (routing/batteries/provider.ts) and remembered per id; the id-normalizing
 * and family-matching regexes it replaces are gone.
 *
 * Verified against provider documentation on 2026-07-25.
 */

import { knownReasoningFamily, readReasoningFamily } from '../routing/provider-readings.js';
import type { ReasoningFamily } from '../routing/batteries/provider.js';
import {
  type ReasoningEffortSpec,
  type ResolvedReasoningEffort,
  budgetLevels,
  FALLBACK_REASONING_EFFORT_SPEC,
  reasoningEffortSourceRank,
  resolveEffortForModel,
} from './reasoning-effort.js';

export const REASONING_EFFORT_FAMILIES_AS_OF = '2026-07-25';

/** Anthropic documents `high` as the default when `output_config.effort` is omitted. */
const ANTHROPIC_EFFORT_DEFAULT = 'high';

function effort(
  values: readonly string[],
  defaultValue?: string,
  note?: string,
): ReasoningEffortSpec {
  return {
    kind: 'effort',
    values,
    source: 'family',
    ...(defaultValue ? { defaultValue } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * @param canDisableReasoning Whether the model can be told not to reason at
 *   all. True for Anthropic, which turns extended thinking off by omitting the
 *   `thinking` block regardless of its 1024-token floor for an enabled budget;
 *   false for Gemini 2.5, which puts the budget on the wire as a number and
 *   rejects a zero one on Pro.
 */
function budget(min: number, max: number | undefined, canDisableReasoning: boolean): ReasoningEffortSpec {
  return {
    kind: 'budget_tokens',
    values: budgetLevels(min, max, canDisableReasoning),
    source: 'family',
    minBudgetTokens: min,
    canDisableReasoning,
    ...(max === undefined ? {} : { maxBudgetTokens: max }),
  };
}

function unavailable(note: string): ReasoningEffortSpec {
  return { kind: 'unavailable', values: [], source: 'family', note };
}

/**
 * The documented spec of each reasoning-control family. Keys are the
 * families routing.reasoning-family reads a model id into.
 */
const FAMILY_SPECS: Readonly<Record<ReasoningFamily, ReasoningEffortSpec>> = {
  // --- Anthropic --------------------------------------------------------
  // platform.claude.com/docs/en/build-with-claude/effort: `output_config.effort`
  // takes low | medium | high (default) | xhigh | max, no beta header, on
  // Claude Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5.
  // The same docs' extended-thinking page: "Claude 4.7 and later models do not
  // support [thinking.budget_tokens] and reject requests that use it,
  // returning a 400 error." These rows must therefore never be budget-typed.
  'claude-fable-mythos': effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  'claude-5': effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  'claude-opus-4-7-8': effort(['low', 'medium', 'high', 'xhigh', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  // Claude 4.6 publishes both controls; `budget_tokens` is deprecated there
  // ("requests using it still succeed"), so the effort field is the live one.
  // `xhigh` arrived with Opus 4.7, so 4.6 stops at `max`.
  'claude-4-6': effort(['low', 'medium', 'high', 'max'], ANTHROPIC_EFFORT_DEFAULT),
  // Opus 4.5 accepts effort, but only low/medium/high, no xhigh, no max.
  'claude-opus-4-5': effort(['low', 'medium', 'high'], ANTHROPIC_EFFORT_DEFAULT),
  // Claude 3.7 through 4.5 have no effort parameter, extended thinking with a
  // token budget, minimum 1024, is the only control. An unrecognized Claude
  // reads as no family and gets the labelled ladder's effort field, which is
  // what every current generation takes.
  'claude-3-7': budget(1024, undefined, true),
  'claude-4-early': budget(1024, undefined, true),
  // Extended thinking arrived with Claude 3.7 Sonnet. Every earlier generation
  // rejects a `thinking` block outright, so they must resolve to "nothing to
  // send" rather than to a budget.
  'claude-before-3-7': unavailable('Claude generations before 3.7 Sonnet have no extended thinking and reject a thinking block.'),

  // --- Google Gemini ----------------------------------------------------
  // ai.google.dev/gemini-api/docs/thinking: Gemini 3-series takes
  // `thinkingLevel` (a named level); Gemini 2.5-series takes `thinkingBudget`
  // (a token count). Sending both on one request is a 400, so the two
  // generations must never share a spec kind.
  // `thinkingLevel` names a depth; it has no documented value that turns
  // thinking off, so the 3-series rows offer no `none`. A 3-series model that
  // does publish a reasoning toggle picks it up from the live catalog, which
  // outranks this table.
  'gemini-3': effort(['low', 'medium', 'high']),
  'gemini-latest': effort(['low', 'medium', 'high']),
  // 2.5 Pro documents a 128-token minimum and rejects a zero budget, so the
  // whole 2.5 row withholds the off levels; 2.5 Flash, which can disable
  // thinking, gets that from its catalog entry.
  'gemini-2-5': budget(128, 32768, false),
  'gemini-legacy': unavailable('Gemini 2.0 and earlier have no thinking configuration.'),

  // --- xAI Grok ---------------------------------------------------------
  // docs.x.ai/docs/guides/reasoning: `reasoning_effort` values are per model.
  // The base grok-4 does not accept the parameter at all and errors when it is
  // sent, so it must resolve to "nothing to send" rather than a level.
  'grok-4-base': unavailable('The base grok-4 model rejects reasoning_effort; only its successors accept it.'),
  'grok-4-plus': effort(['low', 'medium', 'high']),

  // --- DeepSeek ---------------------------------------------------------
  // api-docs.deepseek.com/guides/thinking_mode: `reasoning_effort` accepts only
  // high (default) and max. deepseek-reasoner always reasons and exposes no
  // levels at all.
  'deepseek-reasoner': unavailable('deepseek-reasoner always reasons and exposes no configurable levels.'),
  deepseek: effort(['high', 'max'], 'high'),

  // --- OpenAI -----------------------------------------------------------
  // developers.openai.com/api/docs/guides/reasoning: "Supported values are
  // model-dependent and can include none, minimal, low, medium, high, xhigh,
  // and max. Some models support only a subset." low/medium/high is the subset
  // every current reasoning model accepts; the live catalog widens it per model.
  'openai-reasoning': effort(['low', 'medium', 'high']),

  // --- Inception Mercury -------------------------------------------------
  // Mercury-2 takes `reasoning_effort` and names an `instant` level below
  // `low`, the one place on the ladder where `instant` is a real provider
  // value rather than our own label for "barely think".
  'mercury-edit': unavailable('Mercury Edit exposes no reasoning controls.'),
  mercury: effort(['instant', 'low', 'medium', 'high']),
};

/**
 * Curated spec for a model the live catalog does not cover: its family's row
 * once routing.reasoning-family has read the id, else undefined (not read
 * yet, or no documented family).
 */
export function findFamilyReasoningEffortSpec(modelId: string): ReasoningEffortSpec | undefined {
  const family = knownReasoningFamily(modelId.trim());
  return family ? FAMILY_SPECS[family] : undefined;
}

/** Reads the model id's family when it has not been read, then returns its row. */
export async function readFamilyReasoningEffortSpec(modelId: string, site: string): Promise<ReasoningEffortSpec | undefined> {
  const id = modelId.trim();
  if (!id) return undefined;
  const family = await readReasoningFamily(id, site);
  return family ? FAMILY_SPECS[family] : undefined;
}

/**
 * Makes the family row available to the synchronous resolvers before a
 * request is built: reads the id's family when a reasoning level was asked
 * for and neither the catalog nor the model's own declaration already
 * outranks the table. With no level asked for nothing goes on the wire, so
 * nothing needs reading. Adapters await this at the top of a request.
 */
export async function prepareReasoningEffort(requested: string | undefined, input: ReasoningEffortSpecRequest, site: string): Promise<void> {
  if (requested === undefined || requested === '') return;
  const declared = input.spec;
  if (declared && reasoningEffortSourceRank(declared.source) >= reasoningEffortSourceRank('family')) return;
  await readFamilyReasoningEffortSpec(input.modelId, site);
}

/** What is known about one model when deciding which spec governs it. */
export interface ReasoningEffortSpecRequest {
  readonly modelId: string;
  /** A spec already attached to the model definition, when the caller has one. */
  readonly spec?: ReasoningEffortSpec | undefined;
}

/**
 * Apply the source precedence: live catalog, then a declaration attached to
 * this exact model, then the curated family table, then the labelled best
 * guess.
 *
 * The caller's spec is consulted before the table rather than after it. The
 * table matches bare id prefixes, so a local `deepseek-r1:70b` served by ollama
 * would otherwise be handed DeepSeek's hosted-API row and lose the levels its
 * own adapter accepts. Whoever attached the spec knows which endpoint holds the
 * weights; a prefix does not.
 */
export function resolveReasoningEffortSpec(input: ReasoningEffortSpecRequest): ReasoningEffortSpec {
  const declared = input.spec;
  if (declared && reasoningEffortSourceRank(declared.source) >= reasoningEffortSourceRank('family')) {
    return declared;
  }
  const family = findFamilyReasoningEffortSpec(input.modelId);
  if (family) return family;
  return declared ?? FALLBACK_REASONING_EFFORT_SPEC;
}

/**
 * Resolve the governing spec and the level to send in one step, the entry
 * point for adapters, which hold a model id and a requested level but no
 * model definition.
 */
export function resolveEffortForRequest(
  requested: string | undefined,
  input: ReasoningEffortSpecRequest,
): ResolvedReasoningEffort {
  const spec = resolveReasoningEffortSpec(input);
  return resolveEffortForModel(requested, { id: input.modelId, reasoningEffort: spec });
}
