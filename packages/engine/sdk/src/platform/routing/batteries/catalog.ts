/**
 * `routing.catalog-provider-access`: how a user pays for a catalog provider's
 * models, read from the provider's published catalog facts (name, id, API
 * base URL, documentation URL, key variables, sample models). Replaces the
 * hardcoded subscription and shutdown provider-id lists and the
 * "coding-plan" substring test: whether a zero listed price means free depends
 * on this reading, and the zero itself stays arithmetic in code.
 *
 * Medium bands: a wrong reading labels a provider's models free, metered or
 * subscription for a day, which the failover chain and the planner act on.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** How a user pays: per token, through a plan, or not at all because the models run locally. */
export type ProviderAccess = 'metered' | 'subscription' | 'local';

const provider = (facts: {
  id: string;
  name: string;
  api?: string;
  doc?: string;
  env_vars: string[];
  sample_models: string[];
}): { provider: typeof facts } => ({ provider: facts });

export const catalogProviderAccess = defineBattery({
  name: 'routing.catalog-provider-access',
  version: 2,
  description: 'Whether a catalog provider runs models locally, and whether it sells access as a subscription or plan rather than per token.',
  accuracyFloor: 0.9,
  items: {
    local: yesNo(
      'Does `provider` serve models from the user\'s own machine or local network, with an API at a localhost, 127.0.0.1 or private address and no per-token billing?',
      STAKES_BANDS.medium.yesNo,
    ),
    plan: yesNo(
      'Do the name, id or documentation of `provider` describe access sold as a subscription, coding plan, token plan, pass, seat license or bundled developer product, rather than pay-as-you-go API usage billed per token?',
      STAKES_BANDS.medium.yesNo,
    ),
  },
  fixtures: [
    { name: 'router', state: provider({ id: 'openrouter', name: 'OpenRouter', api: 'https://openrouter.ai/api/v1', doc: 'https://openrouter.ai/models', env_vars: ['OPENROUTER_API_KEY'], sample_models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5'] }), expect: { local: 'no', plan: 'no' } },
    { name: 'first-party api', state: provider({ id: 'deepseek', name: 'DeepSeek', api: 'https://api.deepseek.com', doc: 'https://api-docs.deepseek.com/quick_start/pricing', env_vars: ['DEEPSEEK_API_KEY'], sample_models: ['deepseek-chat', 'deepseek-reasoner'] }), expect: { local: 'no', plan: 'no' } },
    { name: 'inference cloud', state: provider({ id: 'fireworks-ai', name: 'Fireworks AI', api: 'https://api.fireworks.ai/inference/v1/', doc: 'https://fireworks.ai/docs/', env_vars: ['FIREWORKS_API_KEY'], sample_models: ['Kimi K2 Instruct', 'Qwen3 235B'] }), expect: { local: 'no', plan: 'no' } },
    { name: 'coding plan', state: provider({ id: 'zai-coding-plan', name: 'Z.AI Coding Plan', api: 'https://api.z.ai/api/coding/paas/v4', doc: 'https://docs.z.ai/devpack/overview', env_vars: ['ZHIPU_API_KEY'], sample_models: ['GLM-4.6', 'GLM-4.5-Air'] }), expect: { local: 'no', plan: 'yes' } },
    { name: 'token plan', state: provider({ id: 'alibaba-token-plan', name: 'Alibaba Token Plan', api: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', doc: 'https://www.alibabacloud.com/help/en/model-studio/token-plan-overview', env_vars: ['DASHSCOPE_API_KEY'], sample_models: ['Qwen3 Coder Plus'] }), expect: { local: 'no', plan: 'yes' } },
    { name: 'seat product', state: provider({ id: 'github-copilot', name: 'GitHub Copilot', doc: 'https://docs.github.com/en/copilot', env_vars: ['GITHUB_TOKEN'], sample_models: ['Claude Sonnet 4.5', 'GPT-5 mini'] }), expect: { local: 'no', plan: 'yes' } },
    { name: 'bundled agent platform', state: provider({ id: 'gitlab', name: 'GitLab Duo', doc: 'https://docs.gitlab.com/user/duo_agent_platform/', env_vars: ['GITLAB_TOKEN'], sample_models: ['Claude Sonnet 4.5'] }), expect: { local: 'no', plan: 'yes' } },
    { name: 'coding pass', state: provider({ id: 'cline-pass', name: 'ClinePass', api: 'https://api.cline.bot/api/v1', doc: 'https://docs.cline.bot/getting-started/clinepass', env_vars: ['CLINE_API_KEY'], sample_models: ['Kimi K2'] }), expect: { local: 'no', plan: 'yes' } },
    { name: 'local server', state: provider({ id: 'lmstudio', name: 'LMStudio', api: 'http://127.0.0.1:1234/v1', doc: 'https://lmstudio.ai/models', env_vars: [], sample_models: ['qwen/qwen3-30b-a3b', 'openai/gpt-oss-20b'] }), expect: { local: 'yes', plan: 'no' } },
    { name: 'local desktop app', state: provider({ id: 'atomic-chat', name: 'Atomic Chat', api: 'http://127.0.0.1:1337/v1', doc: 'https://atomic.chat', env_vars: [], sample_models: ['Llama 3.2 3B'] }), expect: { local: 'yes', plan: 'no' } },
  ],
});
