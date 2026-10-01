/**
 * Provider protocol readings: what a local server is, whether a provider
 * error means "try the other API", whether a rejection was caused by the
 * reasoning setting, what an unfamiliar stream label or stop reason means,
 * and which documented reasoning-control family a model id belongs to.
 * Every one of these replaces a substring or regex guess; exact, documented
 * values (well-known ports, status codes, known wire labels) stay code at the
 * call sites.
 *
 * Bands: every reading here picks between two request shapes, a label or a
 * table row, all reversible within the same request's retry, so the low bands
 * apply, except the reasoning family, which decides which field a request
 * carries (a wrong one is a 400 on every request to that model until the
 * process restarts), so it takes the medium bands.
 */
import { defineBattery, defineDispatch, oneOf, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment/decisions';

const LOW = STAKES_BANDS.low;
const MEDIUM = STAKES_BANDS.medium;

/**
 * `routing.local-server-identity`: which local model server software answered
 * a discovery probe, from the probe's port, response headers and model ids.
 * Asked only when the port is not one of the fixed well-known ports.
 */
export const localServerIdentity = defineDispatch({
  name: 'routing.local-server-identity',
  version: 1,
  description: 'Which local model server software answered a discovery probe, from its port, response headers and model ids.',
  accuracyFloor: 0.9,
  instructions: 'Which server software answered this probe of an OpenAI-compatible endpoint? Judge from `headers` and `model_ids`; answer unknown when they do not show it.',
  routes: {
    'lm-studio': 'LM Studio',
    vllm: 'vLLM (for example headers starting with x-vllm)',
    llamacpp: 'llama.cpp server (llama-server)',
    localai: 'LocalAI',
    tgi: 'Hugging Face Text Generation Inference',
    ollama: 'Ollama',
    unknown: 'Another server, or the evidence does not show which software this is',
  },
  band: LOW.confidence,
  fixtures: [
    { name: 'lm studio header', state: { port: 8081, headers: { 'x-powered-by': 'lmstudio' }, model_ids: ['qwen/qwen3-8b'] }, expect: 'lm-studio' },
    { name: 'vllm header', state: { port: 8000, headers: { 'x-vllm-version': '0.6.3', 'content-type': 'application/json' }, model_ids: ['meta-llama/Llama-3.1-8B-Instruct'] }, expect: 'vllm' },
    { name: 'llama server header', state: { port: 8080, headers: { server: 'llama.cpp' }, model_ids: ['gemma-3-12b-it-q4_k_m.gguf'] }, expect: 'llamacpp' },
    { name: 'localai header', state: { port: 8080, headers: { server: 'localai' }, model_ids: ['gpt-4'] }, expect: 'localai' },
    { name: 'tgi header', state: { port: 3000, headers: { 'x-compute-type': 'text-generation-inference' }, model_ids: ['tgi'] }, expect: 'tgi' },
    { name: 'ollama on a custom port', state: { port: 9000, headers: { server: 'ollama' }, model_ids: ['llama3.2:latest', 'qwen2.5-coder:7b'] }, expect: 'ollama' },
    { name: 'plain proxy', state: { port: 4000, headers: { 'content-type': 'application/json' }, model_ids: ['my-model'] }, expect: 'unknown' },
  ],
});

/**
 * `routing.alternate-api`: whether a local server's error means the request
 * should be retried through the server's other API (Ollama's native chat and
 * its OpenAI-compatible endpoint; LM Studio's native, responses and
 * OpenAI-compatible endpoints). Status 404, 405 and 501 decide on their own in
 * code; this reads the wording of every other failure.
 */
export const alternateApi = defineBattery({
  name: 'routing.alternate-api',
  version: 2,
  description: 'Whether a local model server error means the endpoint or a feature of the request is unsupported there, so the server\'s other API should be tried.',
  accuracyFloor: 0.9,
  items: {
    unsupported: yesNo(
      'This error came from one of two APIs a local model server offers for the same chat request. Does `error` reject something tied to this API rather than to the model or the machine: the endpoint itself (unknown, not implemented, not supported), tool calling, the layout of the messages, or a field such as a previous response id that is invalid or not found? Then the same request could succeed through the server\'s other API. A missing model, a crash, running out of memory, a connection failure or an over-long prompt is not that.',
      LOW.yesNo,
    ),
  },
  fixtures: [
    { name: 'no tool support', state: { status: 400, error: 'registry.ollama.ai/library/gemma3:4b does not support tools' }, expect: { unsupported: 'yes' } },
    { name: 'unknown endpoint', state: { status: 400, error: 'Unknown endpoint: /api/v1/chat' }, expect: { unsupported: 'yes' } },
    { name: 'not implemented', state: { status: 500, error: 'Not implemented: streaming with images' }, expect: { unsupported: 'yes' } },
    { name: 'stale previous response', state: { status: 400, error: 'previous_response_id resp_123 not found' }, expect: { unsupported: 'yes' } },
    { name: 'bad message format', state: { status: 400, error: 'invalid message format: messages[2].content must be a string' }, expect: { unsupported: 'yes' } },
    { name: 'model missing', state: { status: 400, error: 'model "llama9" not found, try pulling it first' }, expect: { unsupported: 'no' } },
    { name: 'out of memory', state: { status: 500, error: 'CUDA error: out of memory' }, expect: { unsupported: 'no' } },
    { name: 'connection refused', state: { error: 'connect ECONNREFUSED 127.0.0.1:11434' }, expect: { unsupported: 'no' } },
    { name: 'prompt too long', state: { status: 400, error: 'the input length exceeds the context length' }, expect: { unsupported: 'no' } },
  ],
});

/**
 * `routing.reasoning-rejection`: whether a provider's 400 says the request's
 * reasoning setting caused it, so the error names the setting to change. The
 * status and a present setting stay code at the call site.
 */
export const reasoningRejection = defineBattery({
  name: 'routing.reasoning-rejection',
  version: 1,
  description: 'Whether a provider rejection names the request\'s reasoning setting (effort, thinking, thinking budget) as the problem.',
  accuracyFloor: 0.9,
  items: {
    reasoning: yesNo(
      'Does `error` say the request was rejected because of its reasoning setting: the reasoning effort level, the thinking configuration, or the thinking or reasoning token budget?',
      LOW.yesNo,
    ),
  },
  fixtures: [
    { name: 'unsupported effort value', state: { error: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'." }, expect: { reasoning: 'yes' } },
    { name: 'thinking budget too small', state: { error: 'thinking.budget_tokens: Input should be greater than or equal to 1024' }, expect: { reasoning: 'yes' } },
    { name: 'thinking not supported', state: { error: 'thinking is not supported for this model' }, expect: { reasoning: 'yes' } },
    { name: 'bad tool schema', state: { error: "Invalid schema for function 'search': 'query' is not of type 'object'." }, expect: { reasoning: 'no' } },
    { name: 'max tokens too large', state: { error: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for this model' }, expect: { reasoning: 'no' } },
    { name: 'empty message', state: { error: 'messages: text content blocks must be non-empty' }, expect: { reasoning: 'no' } },
  ],
});

/**
 * `routing.content-part-kind`: whether an unfamiliar content-part type label
 * in a streamed response carries the model's reasoning. Documented labels are
 * an exact table in openai-stream-delta.ts; this reads only labels outside it,
 * once per label.
 */
export const contentPartKind = defineBattery({
  name: 'routing.content-part-kind',
  version: 1,
  description: 'Whether a streamed content part with an unfamiliar type label carries the model\'s reasoning rather than its answer.',
  accuracyFloor: 0.9,
  items: {
    reasoning: yesNo(
      'In a streamed chat completion, does a content part whose type label is `type` carry the model\'s reasoning, thinking or a summary of its reasoning, rather than answer text meant for the user?',
      LOW.yesNo,
    ),
  },
  fixtures: [
    { name: 'thought', state: { type: 'thought' }, expect: { reasoning: 'yes' } },
    { name: 'reasoning summary text', state: { type: 'reasoning_summary_text' }, expect: { reasoning: 'yes' } },
    { name: 'chain of thought', state: { type: 'chain_of_thought' }, expect: { reasoning: 'yes' } },
    { name: 'answer', state: { type: 'answer' }, expect: { reasoning: 'no' } },
    { name: 'markdown', state: { type: 'markdown' }, expect: { reasoning: 'no' } },
    { name: 'final text', state: { type: 'final_text' }, expect: { reasoning: 'no' } },
  ],
});

/**
 * `routing.stop-reason`: what an unfamiliar raw stop reason from a model
 * server means in the canonical vocabulary. Documented values are exact maps
 * in stop-reason-maps.ts; this reads only values outside them, once each.
 */
export const stopReason = defineBattery({
  name: 'routing.stop-reason',
  version: 1,
  description: 'Which canonical stop an unfamiliar raw stop reason from a model server reports: finished, stopped to call a tool, or cut off at the token limit.',
  accuracyFloor: 0.9,
  items: {
    stop: oneOf(
      'Why did generation stop, according to `raw_reason`?',
      {
        completed: 'The model finished its answer normally, or the reason is housekeeping such as loading or unloading the model',
        tool_call: 'The model stopped to call a tool or function',
        max_tokens: 'Generation was cut off at the token or length limit',
      },
      LOW.confidence,
    ),
  },
  fixtures: [
    { name: 'end of turn', state: { raw_reason: 'end_turn' }, expect: { stop: 'completed' } },
    { name: 'eos token', state: { raw_reason: 'eos_token' }, expect: { stop: 'completed' } },
    { name: 'function call', state: { raw_reason: 'function_call' }, expect: { stop: 'tool_call' } },
    { name: 'tool use', state: { raw_reason: 'tool_use' }, expect: { stop: 'tool_call' } },
    { name: 'token limit', state: { raw_reason: 'max_output_tokens' }, expect: { stop: 'max_tokens' } },
    { name: 'truncated', state: { raw_reason: 'truncated_length' }, expect: { stop: 'max_tokens' } },
  ],
});

/**
 * The documented reasoning-control families, as the family question offers
 * them. Each id keys a row of documented request-field facts in
 * providers/reasoning-effort-families.ts.
 */
export const REASONING_FAMILY_ROUTES = {
  'claude-fable-mythos': 'Claude Fable or Claude Mythos, any version',
  'claude-5': 'Claude Opus 5, Sonnet 5 or Haiku 5 (generation 5 or later of Opus, Sonnet or Haiku)',
  'claude-opus-4-7-8': 'Claude Opus 4.7 or Claude Opus 4.8',
  'claude-4-6': 'Claude Opus 4.6 or Claude Sonnet 4.6',
  'claude-opus-4-5': 'Claude Opus 4.5',
  'claude-3-7': 'Claude 3.7 Sonnet',
  'claude-4-early': 'Claude Opus, Sonnet or Haiku 4, 4.1 or 4.5, other than Opus 4.5 (for example Sonnet 4, Sonnet 4.5, Haiku 4.5, Opus 4.1)',
  'claude-before-3-7': 'Claude Instant, Claude 1, 2 or 3, or Claude 3.5 (any Claude before 3.7 Sonnet)',
  'gemini-3': 'Gemini 3 series (any Gemini 3 or 3.x model)',
  'gemini-latest': 'The Gemini "flash-latest" or "pro-latest" aliases',
  'gemini-2-5': 'Gemini 2.5 series',
  'gemini-legacy': 'Gemini 2.0, 1.5 or 1.0',
  'grok-4-base': 'The base grok-4 model exactly, with no suffix or later version',
  'grok-4-plus': 'Grok 4 variants and later Grok models (grok-4.x, grok-4-fast, grok-5, grok-code)',
  'deepseek-reasoner': 'deepseek-reasoner',
  deepseek: 'Any other DeepSeek model (deepseek-chat, deepseek-v3, deepseek-v4 and so on)',
  'openai-reasoning': 'GPT-5 family, o1, o3 or o4 reasoning models',
  'mercury-edit': 'Mercury Edit',
  mercury: 'Any other Mercury model (mercury-2, mercury-coder and so on)',
  none: 'None of these families, or a different model family altogether',
} as const;

export type ReasoningFamily = Exclude<keyof typeof REASONING_FAMILY_ROUTES, 'none'>;

/**
 * `routing.reasoning-family`: which documented reasoning-control family a
 * model id belongs to, across provider decorations (vendor and region
 * prefixes, version and date suffixes, gateway paths, local tags). Replaces
 * the id-normalization regexes and the family regex table. Used only when
 * neither the live catalog nor the model's own declaration says what it
 * accepts.
 */
export const reasoningFamily = defineDispatch({
  name: 'routing.reasoning-family',
  version: 1,
  description: 'Which documented reasoning-control family a model id belongs to, through provider, region and version decorations.',
  accuracyFloor: 0.9,
  instructions: 'Which model family and generation is `model_id`? Ignore provider or gateway prefixes, region prefixes, date or version suffixes and local tags.',
  routes: REASONING_FAMILY_ROUTES,
  band: MEDIUM.confidence,
  fixtures: [
    { name: 'fable', state: { model_id: 'claude-fable-5' }, expect: 'claude-fable-mythos' },
    { name: 'opus 5 on a gateway', state: { model_id: 'anthropic/claude-opus-5' }, expect: 'claude-5' },
    { name: 'opus 4.7 dated', state: { model_id: 'claude-opus-4-7-20260301' }, expect: 'claude-opus-4-7-8' },
    { name: 'sonnet 4.6', state: { model_id: 'claude-sonnet-4-6' }, expect: 'claude-4-6' },
    { name: 'opus 4.5 on vertex', state: { model_id: 'claude-opus-4-5@20251101' }, expect: 'claude-opus-4-5' },
    { name: 'sonnet 3.7 on bedrock', state: { model_id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0' }, expect: 'claude-3-7' },
    { name: 'sonnet 4.5', state: { model_id: 'claude-sonnet-4-5-20250929' }, expect: 'claude-4-early' },
    { name: 'haiku 3.5', state: { model_id: 'claude-3-5-haiku-latest' }, expect: 'claude-before-3-7' },
    { name: 'gemini 3', state: { model_id: 'gemini-3-pro-preview' }, expect: 'gemini-3' },
    { name: 'gemini latest alias', state: { model_id: 'gemini-flash-latest' }, expect: 'gemini-latest' },
    { name: 'gemini 2.5', state: { model_id: 'google/gemini-2.5-flash' }, expect: 'gemini-2-5' },
    { name: 'gemini 1.5', state: { model_id: 'gemini-1.5-pro-002' }, expect: 'gemini-legacy' },
    { name: 'base grok 4', state: { model_id: 'grok-4' }, expect: 'grok-4-base' },
    { name: 'grok 4 fast', state: { model_id: 'x-ai/grok-4-fast' }, expect: 'grok-4-plus' },
    { name: 'deepseek reasoner', state: { model_id: 'deepseek-reasoner' }, expect: 'deepseek-reasoner' },
    { name: 'deepseek chat', state: { model_id: 'deepseek/deepseek-chat-v3.1' }, expect: 'deepseek' },
    { name: 'gpt 5', state: { model_id: 'openai/gpt-5-mini' }, expect: 'openai-reasoning' },
    { name: 'o3', state: { model_id: 'o3-2025-04-16' }, expect: 'openai-reasoning' },
    { name: 'mercury edit', state: { model_id: 'mercury-edit' }, expect: 'mercury-edit' },
    { name: 'mercury 2', state: { model_id: 'mercury-2' }, expect: 'mercury' },
    { name: 'local llama', state: { model_id: 'llama3.1:8b' }, expect: 'none' },
    { name: 'mistral', state: { model_id: 'mistral-large-latest' }, expect: 'none' },
  ],
});
