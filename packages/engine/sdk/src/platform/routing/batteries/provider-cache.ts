/**
 * Provider transport and prompt-cache readings: whether a Copilot model id
 * names an Anthropic Claude model (only when Copilot's own /models entry
 * carried neither `supported_endpoints` nor `vendor` for it), and whether a
 * failed Gemini context-cache creation says the content is below the cache
 * minimum. The facts (endpoint lists, vendor names, status codes) stay code
 * at the call sites; these read only the wording that no fact covers.
 *
 * Bands: the Claude reading picks the transport every request to that model
 * goes through for the rest of the process (a wrong pick fails each of them),
 * so it takes the medium bands. The cache-minimum reading only decides
 * whether this prompt skips the cache-creation attempt on later requests (a
 * wrong yes loses the cache discount for that prompt, a wrong no costs one
 * more failed creation call), so it takes the low bands.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const LOW = STAKES_BANDS.low;
const MEDIUM = STAKES_BANDS.medium;

/**
 * `routing.copilot-claude-model`: whether a GitHub Copilot model id names an
 * Anthropic Claude model, which Copilot serves on its Anthropic Messages
 * endpoint. Replaces `usesAnthropicTransport`, which sent a model through the
 * Anthropic path when its id contained "claude". Asked only when the /models
 * entry for the id carried no `supported_endpoints` and no `vendor`.
 */
export const copilotClaudeModel = defineBattery({
  name: 'routing.copilot-claude-model',
  version: 1,
  description: 'Whether a GitHub Copilot model id names an Anthropic Claude model.',
  accuracyFloor: 0.9,
  items: {
    claude: yesNo(
      'Is `model_id` the id of a model made by Anthropic (a Claude model such as Opus, Sonnet or Haiku, any version), rather than a model from OpenAI, Google, xAI or another maker?',
      MEDIUM.yesNo,
    ),
  },
  fixtures: [
    { name: 'opus dotted', state: { model_id: 'claude-opus-4.8' }, expect: { claude: 'yes' } },
    { name: 'sonnet 5', state: { model_id: 'claude-sonnet-5' }, expect: { claude: 'yes' } },
    { name: 'sonnet 3.7 thinking', state: { model_id: 'claude-3.7-sonnet-thought' }, expect: { claude: 'yes' } },
    { name: 'haiku without the claude prefix', state: { model_id: 'haiku-4.5' }, expect: { claude: 'yes' } },
    { name: 'opus without the claude prefix', state: { model_id: 'opus-4.1' }, expect: { claude: 'yes' } },
    { name: 'gpt 4.1', state: { model_id: 'gpt-4.1' }, expect: { claude: 'no' } },
    { name: 'gpt 5 codex', state: { model_id: 'gpt-5.1-codex' }, expect: { claude: 'no' } },
    { name: 'o3 mini', state: { model_id: 'o3-mini' }, expect: { claude: 'no' } },
    { name: 'gemini pro', state: { model_id: 'gemini-2.5-pro' }, expect: { claude: 'no' } },
    { name: 'grok code', state: { model_id: 'grok-code-fast-1' }, expect: { claude: 'no' } },
  ],
});

/**
 * `routing.cache-minimum`: whether the error from a failed Gemini context
 * cache creation says the content is below the minimum size a cache may hold.
 * Replaces the check that the error text contained "too few tokens" or
 * "minimum", which missed Gemini's "Cached content is too small" wording and
 * fired on any other error that happened to say "minimum". Asked only for a
 * 400 response; every other status leaves the prompt cacheable.
 */
export const cacheMinimum = defineBattery({
  name: 'routing.cache-minimum',
  version: 1,
  description: 'Whether a failed context-cache creation says the content is too small to be cached.',
  accuracyFloor: 0.9,
  items: {
    belowMinimum: yesNo(
      'This error came back from a request to create a context cache holding a system prompt and tool definitions. Does `error` say the request failed because that content has too few tokens, below the smallest size a cache may hold?',
      LOW.yesNo,
    ),
  },
  fixtures: [
    {
      name: 'too small with counts',
      state: { error: '{"error":{"code":400,"message":"Cached content is too small. total_token_count=12877, min_total_token_count=32768","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'yes' },
    },
    {
      name: 'minimum token count wording',
      state: { error: '{"error":{"code":400,"message":"The cached content is of 2048 tokens. The minimum token count to start caching is 4096.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'yes' },
    },
    {
      name: 'too few tokens',
      state: { error: 'Request contains too few tokens to be cached: 900 tokens provided, 1024 required.' },
      expect: { belowMinimum: 'yes' },
    },
    {
      name: 'below the threshold without the word minimum',
      state: { error: '{"error":{"code":400,"message":"Content size 3100 tokens is below the caching threshold of 4096 tokens for models/gemini-2.5-flash.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'yes' },
    },
    {
      name: 'ttl below its minimum',
      state: { error: '{"error":{"code":400,"message":"ttl must be at least the minimum of 60s.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
    {
      name: 'model does not support caching',
      state: { error: '{"error":{"code":400,"message":"Model gemini-2.0-flash-lite does not support createCachedContent.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
    {
      name: 'content too large',
      state: { error: '{"error":{"code":400,"message":"The input token count (1250000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
    {
      name: 'bad function declaration',
      state: { error: '{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"additionalProperties\\" at \'cached_content.tools[0].function_declarations[3].parameters\': Cannot find field.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
    {
      name: 'minimum api version',
      state: { error: '{"error":{"code":400,"message":"cachedContents requires a minimum API version of v1beta.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
    {
      name: 'empty system instruction',
      state: { error: '{"error":{"code":400,"message":"system_instruction.parts[0].text must not be empty.","status":"INVALID_ARGUMENT"}}' },
      expect: { belowMinimum: 'no' },
    },
  ],
});
