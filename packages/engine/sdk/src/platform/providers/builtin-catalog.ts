import type { OpenAICompatOptions } from './openai-compat.js';
import type { AnthropicCompatOptions } from './anthropic-compat.js';
import { WELL_KNOWN_LOCAL_ENDPOINTS } from './well-known-endpoints.js';

export interface BuiltinProviderDefinition {
  readonly id: string;
  readonly label: string;
  /** Declared setup evidence for runtime presentation, not classification or routing. */
  readonly setupDescription?: string | undefined;
  readonly envVars: readonly string[];
  readonly serviceNames?: readonly string[] | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly subscriptionProviderId?: string | undefined;
}

export interface BuiltinOpenAICompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'openai-compat';
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  /** Date the static `models` list was last verified against the backend. */
  readonly modelsAsOf: string;
  /**
   * 'openai-endpoint' (default) = live discovery from GET {baseURL}/models;
   * 'none' = the backend has no listing API (each 'none' is verified against
   * the backend's documentation, never assumed).
   */
  readonly modelListing?: 'openai-endpoint' | 'none' | undefined;
  /** Override the model-listing URL when it is not {baseURL}/models. */
  readonly modelListingUrl?: string | undefined;
  readonly embeddingModel?: string | undefined;
  readonly reasoningFormat?: OpenAICompatOptions['reasoningFormat'] | undefined;
  readonly suppressedModelRegistryKeys?: readonly string[] | undefined;
  readonly streamProtocol?: string | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

export interface BuiltinAnthropicCompatDefinition extends BuiltinProviderDefinition {
  readonly kind: 'anthropic-compat';
  readonly baseURL: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
  /** Date the static `models` list was last verified against the backend. */
  readonly modelsAsOf: string;
  /**
   * 'anthropic-endpoint' (default) = live discovery from GET {baseURL}/models;
   * 'none' = the backend has no listing API (each 'none' is verified against
   * the backend's documentation, never assumed).
   */
  readonly modelListing?: 'anthropic-endpoint' | 'none' | undefined;
  /** Override the model-listing URL when it is not {baseURL}/models. */
  readonly modelListingUrl?: string | undefined;
  readonly defaultHeaders?: Record<string, string> | undefined;
  readonly authHeaderMode?: AnthropicCompatOptions['authHeaderMode'] | undefined;
  readonly streamProtocol?: string | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

export type BuiltinCompatDefinition =
  | BuiltinOpenAICompatDefinition
  | BuiltinAnthropicCompatDefinition;

export { BUILTIN_PROVIDER_ENV_KEYS, getBuiltinProviderEnvVars } from './credential-catalog.js';
import { getBuiltinProviderEnvVars } from './credential-catalog.js';

/**
 * Reasoning-format audit, 2026-07-25: every entry below without an explicit
 * `reasoningFormat` sends no reasoning parameter at all. That is deliberate,
 * not an oversight, a format is only declared for a backend whose own current
 * documentation was read and cited at the entry. The rest stay silent because
 * guessing a field name earns a provider-side 400 on every turn, which is worse
 * than the setting having no effect. Re-audit an entry by reading its docs and
 * adding a cited `reasoningFormat`.
 */
export const BUILTIN_COMPAT_PROVIDERS: readonly BuiltinCompatDefinition[] = [
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'deepseek',
    label: 'DeepSeek',
    // api-docs.deepseek.com/guides/thinking_mode documents `reasoning_effort`
    // with only `high` (default) and `max`; deepseek-reasoner takes no level at
    // all. Both facts live in the curated family table, so the format here only
    // ever carries a value that model accepts.
    reasoningFormat: 'reasoning-effort',
    envVars: getBuiltinProviderEnvVars('deepseek'),
    serviceNames: ['deepseek'],
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    aliases: ['deepseek-ai'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'fireworks',
    label: 'Fireworks',
    envVars: getBuiltinProviderEnvVars('fireworks'),
    serviceNames: ['fireworks'],
    baseURL: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/routers/kimi-k2p5-turbo',
    models: [
      'accounts/fireworks/routers/kimi-k2p5-turbo',
      'accounts/fireworks/models/kimi-k2p5-turbo',
      'accounts/fireworks/models/llama-v3p1-405b-instruct',
    ],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'microsoft-foundry',
    label: 'Microsoft Foundry',
    setupDescription: 'Uses an Azure cloud account resource endpoint and account-scoped API key; usage is billed to that cloud account.',
    envVars: getBuiltinProviderEnvVars('microsoft-foundry'),
    serviceNames: ['microsoft-foundry'],
    baseURL: 'https://example.openai.azure.com/openai/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4', 'gpt-4.1', 'gpt-4o', 'o3-mini'],
    aliases: ['azure-openai', 'azure-openai-responses'],
    streamProtocol: 'openai-sse',
  },
  {
    kind: 'anthropic-compat',
    modelsAsOf: '2026-07-12',
    id: 'minimax',
    // MiniMax's Anthropic-compatible surface has no models listing, but the
    // platform documents GET /v1/models on its OpenAI-style surface with the
    // same API key (platform.minimax.io, verified 2026-07-12).
    modelListingUrl: 'https://api.minimax.io/v1/models',
    label: 'MiniMax',
    envVars: getBuiltinProviderEnvVars('minimax'),
    serviceNames: ['minimax'],
    baseURL: 'https://api.minimax.io/anthropic',
    defaultModel: 'MiniMax-M2.7',
    models: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M1-80k'],
    streamProtocol: 'anthropic-sse',
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'moonshot',
    label: 'Moonshot',
    envVars: getBuiltinProviderEnvVars('moonshot'),
    serviceNames: ['moonshot'],
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2.5',
    models: ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-instruct'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'qianfan',
    // Baidu Qianfan's v2 OpenAI-compatible docs describe only
    // chat/completions-style endpoints; the model catalog is a static
    // reference page, not a queryable API (verified 2026-07-12).
    modelListing: 'none',
    label: 'Qianfan',
    envVars: getBuiltinProviderEnvVars('qianfan'),
    serviceNames: ['qianfan'],
    baseURL: 'https://qianfan.baidubce.com/v2',
    defaultModel: 'deepseek-v3.2',
    models: ['deepseek-v3.2', 'ernie-4.5-300b-a47b', 'ernie-4.5-turbo-32k'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'qwen',
    // Alibaba Model Studio's OpenAI-compatibility doc documents only
    // chat/completions on the compatible-mode surface; the model catalog is a
    // static reference page, not a queryable API (verified 2026-07-12).
    modelListing: 'none',
    label: 'Qwen',
    envVars: getBuiltinProviderEnvVars('qwen'),
    serviceNames: ['qwen'],
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.5-plus',
    models: ['qwen3.5-plus', 'qwen3-coder-plus', 'qwen3-max', 'qwen-vl-max'],
    aliases: ['dashscope'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'sglang',
    label: 'SGLang',
    setupDescription: 'Operator-managed self-hosted model serving endpoint; setup and upstream charges belong to its operator.',
    envVars: getBuiltinProviderEnvVars('sglang'),
    serviceNames: ['sglang'],
    baseURL: 'http://127.0.0.1:30000/v1',
    defaultModel: 'default',
    models: ['default'],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'SGLang usually runs as a local OpenAI-compatible server.',
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'stepfun',
    // StepFun's API reference (platform.stepfun.ai/docs) documents only
    // chat/completions, files, and audio, no model-listing endpoint
    // (verified 2026-07-12).
    modelListing: 'none',
    label: 'StepFun',
    envVars: getBuiltinProviderEnvVars('stepfun'),
    serviceNames: ['stepfun'],
    baseURL: 'https://api.stepfun.ai/v1',
    defaultModel: 'step-3.5-flash',
    models: ['step-3.5-flash', 'step-2-mini', 'step-1v-8k'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'together',
    label: 'Together AI',
    envVars: getBuiltinProviderEnvVars('together'),
    serviceNames: ['together'],
    baseURL: 'https://api.together.xyz/v1',
    defaultModel: 'moonshotai/Kimi-K2.5',
    models: [
      'moonshotai/Kimi-K2.5',
      'moonshotai/Kimi-K2-Instruct',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'Qwen/Qwen3-235B-A22B-fp8-tput',
    ],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'venice',
    label: 'Venice',
    envVars: getBuiltinProviderEnvVars('venice'),
    serviceNames: ['venice'],
    baseURL: 'https://api.venice.ai/api/v1',
    defaultModel: 'kimi-k2-5',
    models: ['kimi-k2-5', 'llama-3.3-70b', 'qwen-2.5-coder-32b'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'volcengine',
    // Volcengine Ark's v3 surface has no models listing: client.models.list()
    // 404s (volcengine/volc-sdk-python#46, unresolved) and no Ark doc
    // describes such an endpoint (verified 2026-07-12).
    modelListing: 'none',
    label: 'Volcengine',
    envVars: getBuiltinProviderEnvVars('volcengine'),
    serviceNames: ['volcengine'],
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-8-251228',
    models: ['doubao-seed-1-8-251228', 'ark-code-latest', 'doubao-1.5-pro-32k'],
    aliases: ['volcano-engine'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'xai',
    label: 'xAI',
    // docs.x.ai/docs/guides/reasoning documents `reasoning_effort` on chat
    // completions, with per-model value sets. The base grok-4 rejects the
    // parameter outright, which the curated family table already encodes, so
    // declaring the format here does not put it on a grok-4 request.
    reasoningFormat: 'reasoning-effort',
    envVars: getBuiltinProviderEnvVars('xai'),
    serviceNames: ['xai'],
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
    models: ['grok-4', 'grok-4-fast', 'grok-4-1-fast', 'grok-code-fast-1'],
    aliases: ['x-ai'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'xiaomi',
    // Xiaomi MiMo's docs (mimo.mi.com) document only POST chat/completions
    // and the Anthropic-style messages endpoint, no model listing
    // (verified 2026-07-12).
    modelListing: 'none',
    label: 'Xiaomi MiMo',
    envVars: getBuiltinProviderEnvVars('xiaomi'),
    serviceNames: ['xiaomi'],
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2-flash',
    models: ['mimo-v2-flash', 'mimo-v2-preview'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'zai',
    // Z.ai's complete doc index (docs.z.ai/llms.txt) enumerates chat, agents,
    // audio, image, video, tokenizer, and search endpoints, no model-listing
    // endpoint exists on the paas/v4 surface (verified 2026-07-12).
    modelListing: 'none',
    label: 'Z.ai',
    envVars: getBuiltinProviderEnvVars('zai'),
    serviceNames: ['zai'],
    baseURL: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5',
    models: ['glm-5', 'glm-4.7', 'glm-4.6', 'glm-4.5-air'],
    aliases: ['z-ai'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'cloudflare-ai-gateway',
    // Cloudflare AI Gateway's provider-endpoint docs show only POST
    // chat/completions and /responses passing through; a GET /models
    // passthrough is nowhere documented (verified 2026-07-12). The base URL
    // here is also an account/gateway placeholder until configured.
    modelListing: 'none',
    label: 'Cloudflare AI Gateway',
    envVars: getBuiltinProviderEnvVars('cloudflare-ai-gateway'),
    serviceNames: ['cloudflare-ai-gateway'],
    baseURL: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-4-8', 'gpt-5.6', 'gpt-4.1', 'grok-4'],
    aliases: ['cloudflare-gateway'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    envVars: getBuiltinProviderEnvVars('vercel-ai-gateway'),
    serviceNames: ['vercel-ai-gateway'],
    baseURL: 'https://ai-gateway.vercel.sh/v1',
    defaultModel: 'anthropic/claude-opus-4-8',
    models: ['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5', 'openai/gpt-5.6', 'xai/grok-4'],
    aliases: ['ai-gateway'],
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'litellm',
    label: 'LiteLLM',
    envVars: getBuiltinProviderEnvVars('litellm'),
    serviceNames: ['litellm'],
    baseURL: `${WELL_KNOWN_LOCAL_ENDPOINTS.liteLLM}/v1`,
    defaultModel: 'claude-opus-4-8',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'gpt-5.6', 'gemini-3-pro'],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'LiteLLM commonly runs as a local or self-hosted gateway.',
  },
  {
    kind: 'openai-compat',
    modelsAsOf: '2026-07-12',
    id: 'copilot-proxy',
    label: 'Copilot Proxy',
    envVars: getBuiltinProviderEnvVars('copilot-proxy'),
    serviceNames: ['copilot-proxy'],
    baseURL: `${WELL_KNOWN_LOCAL_ENDPOINTS.copilotProxy}/v1`,
    defaultModel: 'gpt-5.6',
    models: [
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.3-codex',
      'gpt-5.2',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'gemini-3-pro',
      'grok-code-fast-1',
    ],
    allowAnonymous: true,
    anonymousConfigured: true,
    anonymousDetail: 'Copilot Proxy is an operator-managed local gateway.',
  },
];
