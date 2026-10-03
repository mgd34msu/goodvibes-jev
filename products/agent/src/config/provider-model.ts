import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';

export function getProviderIdFromModel(model: unknown): string {
  const raw = String(model ?? '').trim();
  if (!raw) return getProviderIdFromModel(DEFAULT_CONFIG.provider.model);
  const separator = raw.indexOf(':');
  // separator === 0 means a leading colon (e.g. ':foo'), treat as no provider specified
  return separator > 0 ? raw.slice(0, separator) : getProviderIdFromModel(DEFAULT_CONFIG.provider.model);
}

export function getModelIdFromProviderModel(model: unknown): string {
  const raw = String(model ?? '').trim();
  if (!raw) return String(DEFAULT_CONFIG.provider.model);
  const separator = raw.indexOf(':');
  return separator > 0 ? raw.slice(separator + 1) : raw;
}

export function formatProviderModel(providerId: string, modelId: string): string {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider) return model;
  if (!model) return `${provider}:`;
  return model.includes(':') ? model : `${provider}:${model}`;
}
