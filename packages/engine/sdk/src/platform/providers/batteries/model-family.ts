/**
 * `engine.runtime.model-family`: which maker's model family a model belongs
 * to, for the model picker's family filter. Read by the picker
 * (providers/model-family.ts) in place of twelve regexes over
 * the model id and display name (claude, gpt or o1/o3/o4, gemini, llama,
 * qwen, glm, minimax, deepseek, mistral, command or cohere, grok, kimi),
 * which filed any model with "command" in its name under Cohere and a
 * gpt-oss derivative served under another name under Other.
 *
 * One choice per model, read once per exact model evidence and installed port for the life of the
 * process; state: `{ id, displayName, provider }`.
 *
 * Band: low stakes. The family only files the model under a filter in the
 * picker; nothing is selected or routed on it.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const MODEL_FAMILY_OPTIONS = {
  Claude: 'Anthropic Claude models (Opus, Sonnet, Haiku).',
  GPT: 'OpenAI GPT and o-series reasoning models (gpt-4o, gpt-5, o1, o3, o4-mini, gpt-oss).',
  Gemini: 'Google Gemini and Gemma models.',
  Llama: 'Meta Llama models and fine-tunes built on Llama.',
  Qwen: 'Alibaba Qwen models, including QwQ and Qwen coder models.',
  GLM: 'Zhipu GLM and ChatGLM models.',
  MiniMax: 'MiniMax models, including abab.',
  DeepSeek: 'DeepSeek models (V3, R1, coder).',
  Mistral: 'Mistral AI models (Mistral, Mixtral, Codestral, Devstral, Magistral).',
  Command: 'Cohere Command models.',
  Grok: 'xAI Grok models.',
  Kimi: 'Moonshot Kimi models.',
  Other: 'A model from any other maker, or one whose maker cannot be told from its id and name.',
} as const;

export type ModelFamilyOption = keyof typeof MODEL_FAMILY_OPTIONS;

const model = (id: string, displayName: string, provider: string) => ({ id, displayName, provider });

export const modelFamily = defineBattery({
  name: 'engine.runtime.model-family',
  version: 1,
  description: "Which maker's model family a model belongs to, from its id, display name and the provider serving it.",
  accuracyFloor: 0.9,
  items: {
    family: oneOf(
      '`id` and `displayName` name a language model served by the provider `provider` (a gateway or local server may serve models from any maker). Which model family is it?',
      MODEL_FAMILY_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'claude sonnet on anthropic', state: model('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'anthropic'), expect: { family: 'Claude' } },
    { name: 'claude haiku on bedrock', state: model('anthropic.claude-haiku-4-5-v1:0', 'Claude Haiku 4.5', 'amazon-bedrock'), expect: { family: 'Claude' } },
    { name: 'gpt-5 on openai', state: model('gpt-5', 'GPT-5', 'openai'), expect: { family: 'GPT' } },
    { name: 'o4-mini on openai', state: model('o4-mini', 'o4 mini', 'openai'), expect: { family: 'GPT' } },
    { name: 'gpt-oss on a gateway', state: model('openai/gpt-oss-120b', 'gpt-oss 120B', 'openrouter'), expect: { family: 'GPT' } },
    { name: 'gemini flash', state: model('gemini-2.5-flash', 'Gemini 2.5 Flash', 'gemini'), expect: { family: 'Gemini' } },
    { name: 'gemma locally', state: model('gemma3:27b', 'gemma3:27b', 'ollama'), expect: { family: 'Gemini' } },
    { name: 'llama on groq', state: model('llama-3.3-70b-versatile', 'Llama 3.3 70B', 'groq'), expect: { family: 'Llama' } },
    { name: 'hermes llama fine-tune', state: model('nousresearch/hermes-3-llama-3.1-405b', 'Hermes 3 405B', 'openrouter'), expect: { family: 'Llama' } },
    { name: 'qwen coder', state: model('qwen2.5-coder:32b', 'qwen2.5-coder:32b', 'ollama'), expect: { family: 'Qwen' } },
    { name: 'qwq reasoning', state: model('qwen/qwq-32b', 'QwQ 32B', 'openrouter'), expect: { family: 'Qwen' } },
    { name: 'glm on zhipu', state: model('glm-4.6', 'GLM 4.6', 'zai'), expect: { family: 'GLM' } },
    { name: 'chatglm locally', state: model('chatglm3-6b', 'chatglm3-6b', 'lm-studio'), expect: { family: 'GLM' } },
    { name: 'minimax m2', state: model('minimax-m2', 'MiniMax M2', 'minimax'), expect: { family: 'MiniMax' } },
    { name: 'abab chat', state: model('abab6.5s-chat', 'abab 6.5s', 'minimax'), expect: { family: 'MiniMax' } },
    { name: 'deepseek reasoner', state: model('deepseek-reasoner', 'DeepSeek R1', 'deepseek'), expect: { family: 'DeepSeek' } },
    { name: 'deepseek on together', state: model('deepseek-ai/DeepSeek-V3', 'DeepSeek V3', 'together'), expect: { family: 'DeepSeek' } },
    { name: 'mixtral', state: model('mistralai/mixtral-8x7b-instruct', 'Mixtral 8x7B', 'openrouter'), expect: { family: 'Mistral' } },
    { name: 'devstral', state: model('devstral-medium-latest', 'Devstral Medium', 'mistral'), expect: { family: 'Mistral' } },
    { name: 'command r plus', state: model('command-r-plus', 'Command R+', 'cohere'), expect: { family: 'Command' } },
    { name: 'command a on openrouter', state: model('cohere/command-a', 'Command A', 'openrouter'), expect: { family: 'Command' } },
    { name: 'grok 4', state: model('grok-4', 'Grok 4', 'xai'), expect: { family: 'Grok' } },
    { name: 'grok code fast', state: model('x-ai/grok-code-fast-1', 'Grok Code Fast 1', 'openrouter'), expect: { family: 'Grok' } },
    { name: 'kimi k2', state: model('kimi-k2-0905-preview', 'Kimi K2', 'moonshot'), expect: { family: 'Kimi' } },
    { name: 'moonshot v1', state: model('moonshot-v1-128k', 'Moonshot v1 128k', 'moonshot'), expect: { family: 'Kimi' } },
    { name: 'command line tool model is not cohere', state: model('commandline-helper-7b', 'Commandline Helper 7B', 'lm-studio'), expect: { family: 'Other' } },
    { name: 'phi', state: model('phi-4', 'Phi-4', 'azure'), expect: { family: 'Other' } },
    { name: 'granite', state: model('ibm/granite-3.1-8b-instruct', 'Granite 3.1 8B', 'openrouter'), expect: { family: 'Other' } },
  ],
});
