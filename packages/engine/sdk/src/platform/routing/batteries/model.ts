/**
 * The model decisions: which capability tier a catalog model belongs to,
 * which candidate model should do a piece of work, and whether two catalog
 * entries name the same model. The questions describe models by their
 * published facts; no rule names a vendor or a model, so they hold for the
 * whole catalog. Model names appear only in the fixtures, as the data a
 * question is asked about.
 */
import { defineBattery, defineSelector, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const MEDIUM = STAKES_BANDS.medium;
const LOW = STAKES_BANDS.low;

/** A fixture's model facts, in the shape modelFactsState produces. */
type FixtureModel = {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly context_window?: number;
  readonly max_output_tokens?: number;
  readonly price_per_million_tokens?: { readonly input: number; readonly output: number } | 'free' | 'unpriced' | 'subscription';
  readonly reasoning?: boolean;
  readonly input_modalities?: string[];
  readonly benchmark_composite?: number;
};

const model = (facts: FixtureModel): { model: FixtureModel } => ({ model: facts });

/**
 * `routing.model-tier`: two atomic questions about one model's published
 * facts, composed into a tier in code (modelTierFrom in model-tiers.ts): a
 * frontier flagship is premium, a small or special-purpose model is economy,
 * and a model that reads as neither is standard. State: `{ model }`
 * (modelFactsState). Low bands: the tier only decides which pool a model is
 * offered from; routing.model-choice then checks each candidate is strong
 * enough for the work, and the work itself is checked, so a wrong tier costs
 * a reroute, not a wrong result. Models newer than the reader's knowledge
 * read in the 0.6 to 0.75 range, which the low bands act on.
 */
export const modelTier = defineBattery({
  name: 'routing.model-tier',
  version: 3,
  description: 'Whether a catalog model is a frontier flagship, and whether it is a small or special-purpose model, from its published facts.',
  accuracyFloor: 0.9,
  items: {
    frontier: yesNo(
      'Is `model` a frontier flagship: among the most capable reasoning and coding models available today, the top tier of a leading model family and priced like it, rather than a smaller, cheaper, mid-range or previous-generation model? Being large or open-weight alone does not make a model frontier. Judge from its name, family, price per million tokens and benchmark score (0 to 1, higher is stronger) where given.',
      LOW.yesNo,
    ),
    small: yesNo(
      'Is `model` a small or lightweight model (roughly 15 billion parameters or fewer, or a variant its name marks as mini, nano, lite, tiny or instant), or a special-purpose model such as an embedding, speech, image or moderation model? A mid-range general model sold as fast or balanced is not small.',
      LOW.yesNo,
    ),
  },
  fixtures: [
    {
      name: 'small open model',
      state: model({ id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B Instruct', provider: 'openrouter', context_window: 131072, price_per_million_tokens: { input: 0.02, output: 0.05 } }),
      expect: { frontier: 'no', small: 'yes' },
    },
    {
      name: 'nano variant',
      state: model({ id: 'gpt-5-nano', name: 'GPT-5 Nano', provider: 'openai', context_window: 400000, price_per_million_tokens: { input: 0.05, output: 0.4 }, reasoning: true }),
      expect: { frontier: 'no', small: 'yes' },
    },
    {
      name: 'embedding model',
      state: model({ id: 'qwen/qwen3-embedding-8b', name: 'Qwen 3 Embedding 8B', provider: 'nano-gpt', context_window: 32768, price_per_million_tokens: { input: 0.01, output: 0 } }),
      expect: { frontier: 'no', small: 'yes' },
    },
    {
      name: 'flash lite',
      state: model({ id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google', context_window: 1048576, price_per_million_tokens: { input: 0.1, output: 0.4 }, input_modalities: ['text', 'image'] }),
      expect: { frontier: 'no', small: 'yes' },
    },
    {
      name: 'mid-size open model',
      state: model({ id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct', provider: 'openrouter', context_window: 131072, price_per_million_tokens: { input: 0.6, output: 0.6 } }),
      expect: { frontier: 'no', small: 'no' },
    },
    {
      name: 'balanced flash model',
      state: model({ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', context_window: 1048576, price_per_million_tokens: { input: 0.3, output: 2.5 }, reasoning: true, input_modalities: ['text', 'image', 'audio'] }),
      expect: { frontier: 'no', small: 'no' },
    },
    {
      name: 'medium model',
      state: model({ id: 'mistral-medium-latest', name: 'Mistral Medium 3', provider: 'mistral', context_window: 131072, price_per_million_tokens: { input: 0.4, output: 2 } }),
      expect: { frontier: 'no', small: 'no' },
    },
    {
      name: 'frontier flagship',
      state: model({ id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic', context_window: 200000, price_per_million_tokens: { input: 5, output: 25 }, reasoning: true, input_modalities: ['text', 'image', 'pdf'], benchmark_composite: 0.78 }),
      expect: { frontier: 'yes', small: 'no' },
    },
    {
      name: 'frontier pro model',
      state: model({ id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', provider: 'google', context_window: 1048576, price_per_million_tokens: { input: 2, output: 12 }, reasoning: true, input_modalities: ['text', 'image', 'video', 'audio', 'pdf'], benchmark_composite: 0.8 }),
      expect: { frontier: 'yes', small: 'no' },
    },
    {
      name: 'frontier reasoning model',
      state: model({ id: 'grok-4', name: 'Grok 4', provider: 'xai', context_window: 256000, price_per_million_tokens: { input: 3, output: 15 }, reasoning: true }),
      expect: { frontier: 'yes', small: 'no' },
    },
  ],
});

/** A candidate as the model-choice and model-identity fixtures offer it. */
const candidate = (id: string, content: FixtureModel): { id: string; content: { model: FixtureModel } } => ({ id, content: { model: content } });

/**
 * `routing.model-choice`: which candidate model should do a piece of work,
 * or none. Candidates are same-tier models the planner shortlisted from the
 * whole catalog; context is the work and what the request readings said about
 * it. Low bands: the pick is reversible (the work is checked, and the route
 * carries fallbacks), so a modest reading may act.
 */
export const modelChoice = defineSelector({
  name: 'routing.model-choice',
  version: 1,
  description: 'Which of the shortlisted catalog models should do a piece of work, or none of them.',
  accuracyFloor: 0.9,
  instructions: 'Which candidate model is the best fit to do `context.work`? Weigh what the work needs (`context.intent`, `context.domain`, `context.language`, input it must read) against each model\'s facts; prefer the lower price when two fit equally.',
  fitInstructions: 'Can this candidate model do `context.work` well: does it accept the input the work needs, is it a general chat or reasoning model rather than an embedding, speech or image-only model, and is it strong enough for the work?',
  band: LOW.confidence,
  fitBand: LOW.yesNo,
  fixtures: [
    {
      name: 'screenshot needs image input',
      context: { work: 'Look at the attached screenshot of the checkout page and list every layout bug you can see.', intent: 'code_review', domain: 'software', language: 'english' },
      candidates: [
        candidate('a:text-only', { id: 'text-only-70b', name: 'Text 70B', provider: 'a', context_window: 131072, price_per_million_tokens: { input: 0.5, output: 0.8 }, input_modalities: ['text'] }),
        candidate('b:vision', { id: 'vision-pro', name: 'Vision Pro', provider: 'b', context_window: 200000, price_per_million_tokens: { input: 1, output: 4 }, input_modalities: ['text', 'image'] }),
      ],
      expect: 'b:vision',
    },
    {
      name: 'coding work skips an embedding model',
      context: { work: 'Add input validation to the signup form handler and cover it with tests.', intent: 'code_change', domain: 'software', language: 'english' },
      candidates: [
        candidate('a:embed', { id: 'text-embedding-3-large', name: 'Text Embedding 3 Large', provider: 'a', context_window: 8192, price_per_million_tokens: { input: 0.13, output: 0 } }),
        candidate('b:coder', { id: 'qwen3-coder-30b-a3b', name: 'Qwen3 Coder 30B', provider: 'b', context_window: 262144, price_per_million_tokens: { input: 0.1, output: 0.3 } }),
      ],
      expect: 'b:coder',
    },
    {
      name: 'long document needs a long context',
      context: { work: 'Read the full 400-page merger agreement (about 300,000 tokens) and list every change-of-control clause.', intent: 'analysis', domain: 'law', language: 'english' },
      candidates: [
        candidate('a:short', { id: 'small-32k', name: 'Small 32K', provider: 'a', context_window: 32768, price_per_million_tokens: { input: 0.2, output: 0.6 } }),
        candidate('b:long', { id: 'long-1m', name: 'Long 1M', provider: 'b', context_window: 1048576, price_per_million_tokens: { input: 1.25, output: 10 } }),
      ],
      expect: 'b:long',
    },
    {
      name: 'nothing can chat',
      context: { work: 'Draft a polite reply declining the meeting invitation.', intent: 'writing', domain: 'personal', language: 'english' },
      candidates: [
        candidate('a:tts', { id: 'tts-1-hd', name: 'TTS 1 HD', provider: 'a', price_per_million_tokens: 'unpriced' }),
        candidate('b:embed', { id: 'embed-english-v3', name: 'Embed English v3', provider: 'b', context_window: 512, price_per_million_tokens: { input: 0.1, output: 0 } }),
      ],
      expect: 'none',
    },
    {
      name: 'equal fit prefers the cheaper model',
      context: { work: 'Fix the typo in the README heading.', intent: 'code_change', domain: 'software', language: 'english' },
      candidates: [
        candidate('a:cheap', { id: 'mini-chat', name: 'Mini Chat', provider: 'a', context_window: 128000, price_per_million_tokens: { input: 0.05, output: 0.2 } }),
        candidate('b:costly', { id: 'mini-chat-plus', name: 'Mini Chat Plus', provider: 'b', context_window: 128000, price_per_million_tokens: { input: 0.6, output: 2.4 } }),
      ],
      expect: 'a:cheap',
    },
  ],
});
