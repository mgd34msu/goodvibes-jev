/** Model catalog aliases. Connection selection still uses the requested provider. */
export const CATALOG_PROVIDER_NAME_ALIASES: Record<string, string> = {
  'openai-subscriber': 'openai',
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
};

export function sameProviderCatalog(left: string, right: string): boolean {
  return (CATALOG_PROVIDER_NAME_ALIASES[left] ?? left) === (CATALOG_PROVIDER_NAME_ALIASES[right] ?? right);
}
