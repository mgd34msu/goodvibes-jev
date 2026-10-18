/** Anthropic output-cap fallback when the provider has not reported a limit. */
import { defineDispatch, STAKES_BANDS } from '@goodvibes-jev/judgment';

const MEDIUM = STAKES_BANDS.medium;

/** The documented Anthropic output-cap rows a model id can belong to (sizes in anthropic.ts). */
export const ANTHROPIC_OUTPUT_CAP_ROUTES = {
  'output-128k': 'Claude Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5 or Sonnet 4.6',
  'output-64k': 'Claude Sonnet 4.5, Haiku 4.5, Opus 4.5, Sonnet 4 or Sonnet 3.7',
  'output-32k': 'Claude Opus 4 or Opus 4.1',
  'output-8k': 'Claude 3.5 Sonnet or Claude 3.5 Haiku',
  'output-4k': 'Claude 3 Opus, Claude 3 Sonnet, Claude 3 Haiku, or any Claude before 3 (Claude 2, Claude Instant)',
  none: 'Not one of these Claude models, or the id does not say which Claude it is',
} as const;

export type AnthropicOutputCapRow = Exclude<keyof typeof ANTHROPIC_OUTPUT_CAP_ROUTES, 'none'>;

/**
 * `routing.anthropic-output-cap`: which documented output-cap row an
 * Anthropic model belongs to when GET /v1/models has not reported its
 * `max_tokens`. Replaces ANTHROPIC_MAX_OUTPUT's id prefixes and substrings
 * ("haiku" 8192, "opus-4" 32000, "sonnet-4" 64000 and others), which capped
 * Claude 3 Haiku above its real 4096 and sent Claude 3.7 Sonnet and every
 * Claude 3 and 3.5 model to a 16384 default none of them has.
 */
export const anthropicOutputCap = defineDispatch({
  name: 'routing.anthropic-output-cap',
  version: 1,
  description: 'Which documented output-cap row an Anthropic model id belongs to.',
  accuracyFloor: 0.9,
  instructions: 'Which Claude model and generation is `model_id`? Ignore date suffixes and "-latest" aliases.',
  routes: ANTHROPIC_OUTPUT_CAP_ROUTES,
  band: MEDIUM.confidence,
  fixtures: [
    { name: 'fable 5', state: { model_id: 'claude-fable-5' }, expect: 'output-128k' },
    { name: 'opus 4.7', state: { model_id: 'claude-opus-4-7' }, expect: 'output-128k' },
    { name: 'sonnet 4.6', state: { model_id: 'claude-sonnet-4-6' }, expect: 'output-128k' },
    { name: 'sonnet 4.5 dated', state: { model_id: 'claude-sonnet-4-5-20250929' }, expect: 'output-64k' },
    { name: 'haiku 4.5 dated', state: { model_id: 'claude-haiku-4-5-20251001' }, expect: 'output-64k' },
    { name: 'sonnet 3.7', state: { model_id: 'claude-3-7-sonnet-20250219' }, expect: 'output-64k' },
    { name: 'opus 4.1', state: { model_id: 'claude-opus-4-1-20250805' }, expect: 'output-32k' },
    { name: 'opus 4', state: { model_id: 'claude-opus-4-20250514' }, expect: 'output-32k' },
    { name: 'sonnet 3.5', state: { model_id: 'claude-3-5-sonnet-20241022' }, expect: 'output-8k' },
    { name: 'haiku 3.5 latest', state: { model_id: 'claude-3-5-haiku-latest' }, expect: 'output-8k' },
    { name: 'haiku 3', state: { model_id: 'claude-3-haiku-20240307' }, expect: 'output-4k' },
    { name: 'opus 3', state: { model_id: 'claude-3-opus-20240229' }, expect: 'output-4k' },
    { name: 'a fine-tune alias', state: { model_id: 'acme-support-bot' }, expect: 'none' },
    { name: 'a non-claude id', state: { model_id: 'mistral-large-latest' }, expect: 'none' },
  ],
});
