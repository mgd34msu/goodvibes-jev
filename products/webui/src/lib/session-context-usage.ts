import type { OperatorMethodOutput } from './goodvibes';

type ContextUsage = OperatorMethodOutput<'sessions.contextUsage.get'>;
type WindowSource = NonNullable<ContextUsage['contextWindowSource']>;
type WindowOrigin = NonNullable<ContextUsage['contextWindowOrigin']>;

// Browser-safe labels for the engine's typed provenance, never model-name guesses.
const SOURCE_LABELS = {
  provider_api: 'provider API',
  configured_cap: 'configured cap',
  observed_limit: 'learned from a provider rejection',
  accepted_floor: 'provider accepted a larger request than the stated window',
  catalog: 'model catalog',
  fallback: 'fallback estimate',
  registry: 'model registry',
  openrouter: 'OpenRouter',
} satisfies Record<WindowSource, string>;

function originLabel(origin: WindowOrigin): string {
  switch (origin.kind) {
    case 'user_override': return 'user override';
    case 'provider_file': return 'provider file';
    case 'catalog': return `catalog: ${origin.catalogProviderId}`;
    case 'consensus': {
      const providers = `${origin.providers} ${origin.providers === 1 ? 'provider' : 'providers'}`;
      return origin.agreeing === origin.providers
        ? `estimate from ${providers}`
        : `estimate from ${providers} (${origin.agreeing} agree)`;
    }
    case 'family_default': return 'family default (estimate)';
  }
}

/** Preserve the compact estimate while disclosing what the engine actually knows. */
export function formatSessionContextUsage(usage: ContextUsage): string {
  const { estimatedContextTokens, contextWindow, contextUsagePct, contextWindowSource, contextWindowOrigin,
    contextWindowAcceptedFloor } = usage;
  const tokens = Number.isFinite(estimatedContextTokens) ? estimatedContextTokens.toLocaleString() : 'Unknown';
  // Floors and fallback/consensus estimates do not establish capacity. Guard
  // against older peers carrying them in contextWindow as well as nullable peers.
  const knownWindow = contextWindowSource !== 'accepted_floor' && contextWindowSource !== 'fallback'
    && contextWindowOrigin?.kind !== 'consensus' && contextWindowOrigin?.kind !== 'family_default'
    && typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;
  const percentage = typeof contextUsagePct === 'number' && Number.isFinite(contextUsagePct)
    ? `~${contextUsagePct}% ` : '';
  const summary = knownWindow
    ? `${percentage}(${tokens} of ${contextWindow.toLocaleString()} tokens, estimated)`
    : `${tokens} tokens estimated; context window unknown`;
  const source = contextWindowSource ? SOURCE_LABELS[contextWindowSource] : undefined;
  const origin = contextWindowOrigin ? originLabel(contextWindowOrigin) : undefined;
  const provenance = [source, origin].filter(Boolean).join(' · ');
  const floor = typeof contextWindowAcceptedFloor === 'number' && Number.isFinite(contextWindowAcceptedFloor)
    && contextWindowAcceptedFloor > 0
    ? `; provider accepted at least ${contextWindowAcceptedFloor.toLocaleString()} tokens (lower bound, not capacity)` : '';
  return `${summary}${provenance ? `; source: ${provenance}` : ''}${floor}`;
}
