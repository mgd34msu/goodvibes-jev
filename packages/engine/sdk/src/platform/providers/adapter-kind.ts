/**
 * Which adapter each registered provider runs on, by provider id.
 *
 * An adapter class declares its kind (`LLMProvider.adapterKind`); the kind of
 * a compat provider is its catalog `kind` or custom-provider `type`, because
 * that is the class it is built from. ProviderRegistry records the kind when a
 * provider is registered, so a lookup by provider id reads the registered
 * fact instead of guessing from words in the id. Providers that serve several
 * wires (GitHub Copilot picks a transport per model) declare no kind.
 */

export type ProviderAdapterKind =
  | 'anthropic'          // anthropic.ts: the Anthropic Messages API
  | 'anthropic-compat'   // anthropic-compat.ts: an Anthropic-compatible endpoint
  | 'anthropic-sdk'      // anthropic-sdk-provider.ts: Claude on Bedrock or Vertex through the Anthropic SDK
  | 'gemini'             // gemini.ts: the Gemini generateContent API
  | 'openai'             // openai.ts: the OpenAI API
  | 'openai-compat';     // openai-compat.ts: an OpenAI-compatible endpoint

const recorded = new Map<string, ProviderAdapterKind>();

/** Records (or clears, when it declares none) the adapter kind of a provider being registered. */
export function recordProviderAdapterKind(provider: { readonly name: string; readonly adapterKind?: ProviderAdapterKind | undefined }): void {
  if (provider.adapterKind) recorded.set(provider.name, provider.adapterKind);
  else recorded.delete(provider.name);
}

/** The adapter kind recorded for a provider id; undefined when none was registered under it. */
export function providerAdapterKind(providerId: string): ProviderAdapterKind | undefined {
  return recorded.get(providerId);
}

/** True for the adapters that speak the Anthropic Messages API. */
export function speaksAnthropicMessages(kind: ProviderAdapterKind | undefined): boolean {
  return kind === 'anthropic' || kind === 'anthropic-compat' || kind === 'anthropic-sdk';
}
