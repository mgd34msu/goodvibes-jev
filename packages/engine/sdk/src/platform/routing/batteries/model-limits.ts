/**
 * Provider model facts the catalog and the provider leave out: which
 * documented context-window row an unsized model belongs to, which documented
 * output-cap row an Anthropic model belongs to when /v1/models has not
 * reported its `max_tokens`, and whether a model a listing endpoint returned
 * is a chat model at all.
 *
 * The rows themselves (window and cap sizes, each cited to the vendor's
 * documentation) stay code beside their callers: context-window-fallback.ts
 * and anthropic.ts. A fact always wins over a reading: a catalog, provider or
 * OpenRouter window, a live /v1/models `max_tokens`, a listing's own chat
 * capability field. These are read only where no fact exists.
 *
 * Bands: both row dispatches take the medium bands. A window too large lets
 * compaction fire too late and earns "context length exceeded"; a cap too
 * large is a 400 on every request to that model. Either stays wrong until the
 * process restarts. The chat-model question also takes the medium bands: a no
 * hides the model from the picker until the next listing refresh.
 */
import { defineBattery, defineDispatch, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const MEDIUM = STAKES_BANDS.medium;

/** The documented context-window rows a model id can belong to (sizes in context-window-fallback.ts). */
export const CONTEXT_WINDOW_FAMILY_ROUTES = {
  gemini: 'Google Gemini 1.5, 2.0, 2.5, 3 or later, including the flash-latest and pro-latest aliases (not Gemma, not Gemini 1.0)',
  claude: 'Anthropic Claude 3 or later: Haiku, Sonnet, Opus, Fable and Mythos models of any generation from 3 on',
  'grok-4': 'xAI Grok 4 or later (grok-4, grok-4-fast, grok-4.x, grok-code, grok-5); not Grok 3 or earlier',
  'gpt-5-or-4-1': 'OpenAI GPT-5 family (gpt-5, gpt-5.x and their mini, nano, codex variants) or GPT-4.1 family',
  'openai-o-series': 'OpenAI o1, o3 or o4 reasoning models and their mini variants',
  none: 'None of these: another family (GPT-4o, GPT-4, Grok 3, Gemma, Llama, Qwen, Mistral and so on) or a model the id does not identify',
} as const;

export type ContextWindowFamily = Exclude<keyof typeof CONTEXT_WINDOW_FAMILY_ROUTES, 'none'>;

/**
 * `routing.context-window-family`: which documented context-window row a
 * model the catalog, the provider and OpenRouter all leave unsized belongs
 * to. Replaces inferFallbackContextWindow's substrings of the provider name
 * and prefixes of the model id ("google", "gemini", "anthropic", "claude",
 * "xai", "grok", "gpt-5", "gpt-4.1", "o1", "o3", "o4"), which gave Gemma on
 * the google provider a Gemini window, Grok 3 a Grok 4 window, and a Claude
 * behind a Bedrock or OpenRouter id the flat default.
 */
export const contextWindowFamily = defineDispatch({
  name: 'routing.context-window-family',
  version: 1,
  description: 'Which documented context-window row an unsized model belongs to, from its provider and model id.',
  accuracyFloor: 0.9,
  instructions: 'Which model family and generation is `model_id`, served by `provider`? Ignore gateway or vendor path prefixes, region prefixes, date or version suffixes and local tags.',
  routes: CONTEXT_WINDOW_FAMILY_ROUTES,
  band: MEDIUM.confidence,
  fixtures: [
    { name: 'gemini 3 on google', state: { provider: 'gemini', model_id: 'gemini-3-pro' }, expect: 'gemini' },
    { name: 'gemini 2.5 through openrouter', state: { provider: 'openrouter', model_id: 'google/gemini-2.5-flash' }, expect: 'gemini' },
    { name: 'gemini 1.5 on vertex', state: { provider: 'vertex', model_id: 'gemini-1.5-pro-002' }, expect: 'gemini' },
    { name: 'gemma on the google provider', state: { provider: 'google', model_id: 'gemma-3-27b-it' }, expect: 'none' },
    { name: 'claude fable', state: { provider: 'anthropic', model_id: 'claude-fable-5' }, expect: 'claude' },
    { name: 'claude on bedrock', state: { provider: 'amazon-bedrock', model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }, expect: 'claude' },
    { name: 'claude through openrouter', state: { provider: 'openrouter', model_id: 'anthropic/claude-3.5-haiku' }, expect: 'claude' },
    { name: 'grok 4', state: { provider: 'xai', model_id: 'grok-4' }, expect: 'grok-4' },
    { name: 'grok 4 fast through openrouter', state: { provider: 'openrouter', model_id: 'x-ai/grok-4-fast' }, expect: 'grok-4' },
    { name: 'grok 3 mini on xai', state: { provider: 'xai', model_id: 'grok-3-mini' }, expect: 'none' },
    { name: 'gpt 5.6', state: { provider: 'openai', model_id: 'gpt-5.6-sol' }, expect: 'gpt-5-or-4-1' },
    { name: 'gpt 4.1 mini', state: { provider: 'openai', model_id: 'gpt-4.1-mini' }, expect: 'gpt-5-or-4-1' },
    { name: 'gpt 5 on azure', state: { provider: 'azure-openai', model_id: 'gpt-5-mini' }, expect: 'gpt-5-or-4-1' },
    { name: 'o3 dated', state: { provider: 'openai', model_id: 'o3-2025-04-16' }, expect: 'openai-o-series' },
    { name: 'o4 mini through openrouter', state: { provider: 'openrouter', model_id: 'openai/o4-mini' }, expect: 'openai-o-series' },
    { name: 'gpt 4o mini', state: { provider: 'openai', model_id: 'gpt-4o-mini' }, expect: 'none' },
    { name: 'llama on groq', state: { provider: 'groq', model_id: 'llama-3.3-70b-versatile' }, expect: 'none' },
    { name: 'local qwen', state: { provider: 'ollama', model_id: 'qwen2.5-coder:7b' }, expect: 'none' },
  ],
});

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

/**
 * `routing.chat-model`: whether a model an OpenAI-style listing returned
 * answers chat requests. Asked only when the listing entry carries no
 * documented chat capability field of its own. Replaces
 * OPENAI_NON_CHAT_MODEL_PATTERN, the substrings embedding, whisper, tts,
 * dall-e, davinci, babbage, ada, moderation, text-search, similarity,
 * transcribe, speech, realtime and image, which kept embedding and rerank
 * models whose ids name none of them and dropped chat fine-tunes whose names
 * happen to contain one.
 */
export const chatModel = defineBattery({
  name: 'routing.chat-model',
  version: 1,
  description: 'Whether a model a provider listing returned answers chat requests.',
  accuracyFloor: 0.9,
  items: {
    chat: yesNo(
      '`model_id` was returned by the model listing of `provider`. Is it a chat model, one that takes a conversation of messages and writes a text reply?',
      MEDIUM.yesNo,
      {
        true: 'A chat, instruct, coding or reasoning language model, including ones that also accept images.',
        false: 'An embedding, rerank, speech, transcription, text-to-speech, image or video generation, moderation or realtime audio model, or a legacy completion-only base model.',
      },
    ),
  },
  fixtures: [
    { name: 'gpt 5.1', state: { provider: 'openai', model_id: 'gpt-5.1' }, expect: { chat: 'yes' } },
    { name: 'gpt 4o mini', state: { provider: 'openai', model_id: 'gpt-4o-mini' }, expect: { chat: 'yes' } },
    { name: 'o3 mini', state: { provider: 'openai', model_id: 'o3-mini' }, expect: { chat: 'yes' } },
    { name: 'llama instruct on together', state: { provider: 'together', model_id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' }, expect: { chat: 'yes' } },
    { name: 'deepseek chat', state: { provider: 'deepseek', model_id: 'deepseek-chat' }, expect: { chat: 'yes' } },
    { name: 'a chat fine-tune named speechless', state: { provider: 'featherless', model_id: 'uukuguy/speechless-code-mistral-7b-v1.0' }, expect: { chat: 'yes' } },
    { name: 'openai embedding', state: { provider: 'openai', model_id: 'text-embedding-3-large' }, expect: { chat: 'no' } },
    { name: 'whisper', state: { provider: 'openai', model_id: 'whisper-1' }, expect: { chat: 'no' } },
    { name: 'text to speech', state: { provider: 'openai', model_id: 'tts-1-hd' }, expect: { chat: 'no' } },
    { name: 'image generation', state: { provider: 'openai', model_id: 'dall-e-3' }, expect: { chat: 'no' } },
    { name: 'moderation', state: { provider: 'openai', model_id: 'omni-moderation-latest' }, expect: { chat: 'no' } },
    { name: 'realtime audio', state: { provider: 'openai', model_id: 'gpt-4o-realtime-preview' }, expect: { chat: 'no' } },
    { name: 'legacy base completion', state: { provider: 'openai', model_id: 'davinci-002' }, expect: { chat: 'no' } },
    { name: 'an embedding without the word in its id', state: { provider: 'together', model_id: 'BAAI/bge-large-en-v1.5' }, expect: { chat: 'no' } },
    { name: 'a reranker', state: { provider: 'jina', model_id: 'jina-reranker-v2-base-multilingual' }, expect: { chat: 'no' } },
  ],
});
