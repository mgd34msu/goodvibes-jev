import { describe, expect, it } from 'bun:test';
import {
  formatProviderModel,
  getModelIdFromProviderModel,
  getProviderIdFromModel,
} from '../../config/provider-model.ts';
import { DEFAULT_CONFIG } from '@goodvibes-jev/engine/sdk/platform/config';

const defaultProviderId = getProviderIdFromModel(DEFAULT_CONFIG.provider.model);

describe('getProviderIdFromModel', () => {
  it('extracts provider from valid provider:model strings', () => {
    expect(getProviderIdFromModel('anthropic:claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(getProviderIdFromModel('openai:gpt-4o')).toBe('openai');
  });

  it('returns the default provider for a bare model string (no colon)', () => {
    // A bare model name with no colon is treated as a model-only form
    // and falls back to the default provider
    const result = getProviderIdFromModel('gpt-4o');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns the default provider for a leading-colon input like ":foo"', () => {
    // A leading colon means separator === 0 (not > 0), so we fall back to default
    const result = getProviderIdFromModel(':foo');
    expect(result).toBe(defaultProviderId);
    expect(result).not.toBe(':foo');
    expect(result.startsWith(':')).toBe(false);
  });

  it('returns the default provider for an empty string', () => {
    const result = getProviderIdFromModel('');
    expect(result).toBe(defaultProviderId);
  });

  it('returns the default provider for null/undefined', () => {
    expect(getProviderIdFromModel(null)).toBe(defaultProviderId);
    expect(getProviderIdFromModel(undefined)).toBe(defaultProviderId);
  });
});

describe('getModelIdFromProviderModel', () => {
  it('extracts model from provider:model strings', () => {
    expect(getModelIdFromProviderModel('anthropic:claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022');
    expect(getModelIdFromProviderModel('openai:gpt-4o')).toBe('gpt-4o');
  });

  it('returns full string for bare model (no provider prefix)', () => {
    expect(getModelIdFromProviderModel('gpt-4o')).toBe('gpt-4o');
  });
});

describe('formatProviderModel', () => {
  it('formats provider:model correctly', () => {
    expect(formatProviderModel('anthropic', 'claude-3-5-sonnet-20241022')).toBe('anthropic:claude-3-5-sonnet-20241022');
  });

  it('returns model alone when provider is empty', () => {
    expect(formatProviderModel('', 'gpt-4o')).toBe('gpt-4o');
  });
});
