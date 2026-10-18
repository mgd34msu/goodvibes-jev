/** Registry-declared model catalogs. These identities never select a connection or grant access. */
export const CATALOG_PROVIDER_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'openai-subscriber': 'openai',
  gemini: 'google',
  inception: 'inceptionlabs',
  copilot: 'github-copilot',
  'azure-openai': 'microsoft-foundry',
  'azure-openai-responses': 'microsoft-foundry',
  dashscope: 'qwen',
  'volcano-engine': 'volcengine',
  'x-ai': 'xai',
  'z-ai': 'zai',
  'cloudflare-gateway': 'cloudflare-ai-gateway',
  'ai-gateway': 'vercel-ai-gateway',
});

const catalogIds = new Set(Object.values(CATALOG_PROVIDER_NAME_ALIASES));
/** Undefined preserves interpretation for an undeclared/custom provider relationship. */
export function declaredProviderCatalogId(providerId: string): string | undefined {
  if (Object.hasOwn(CATALOG_PROVIDER_NAME_ALIASES, providerId)) return CATALOG_PROVIDER_NAME_ALIASES[providerId];
  return catalogIds.has(providerId) ? providerId : undefined;
}
