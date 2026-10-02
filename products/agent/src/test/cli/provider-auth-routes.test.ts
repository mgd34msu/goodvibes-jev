import { describe, expect, test } from 'bun:test';
import type { ProviderAuthRouteDescriptor } from '@goodvibes-jev/engine/sdk/platform/providers';
import { formatProviderAuthRoute, summarizeProviderAuthRoutes } from '../../cli/provider-auth-routes.ts';

describe('provider auth route formatting', () => {
  test('summarizes configured and usable route counts', () => {
    const routes: ProviderAuthRouteDescriptor[] = [
      { route: 'api-key', label: 'API key', configured: true, usable: true },
      { route: 'subscription-oauth', label: 'Subscription', configured: true, usable: false },
      { route: 'service-oauth', label: 'Service OAuth', configured: false },
    ];

    expect(summarizeProviderAuthRoutes(routes)).toBe('2/3 configured, 1/3 usable');
  });

  test('formats route label, kind, status, freshness, and detail', () => {
    expect(formatProviderAuthRoute({
      route: 'subscription-oauth',
      label: 'OpenAI subscription',
      configured: true,
      usable: false,
      freshness: 'expired',
      detail: 'Stored token expired.',
    })).toBe('OpenAI subscription [subscription-oauth; configured, not usable, expired] - Stored token expired.');
  });

  test('normalizes provider OAuth route labels for Agent-facing output', () => {
    expect(formatProviderAuthRoute({
      route: 'service-oauth',
      label: 'Service OAuth',
      configured: true,
      usable: true,
      freshness: 'healthy',
      detail: 'Provider OAuth credential is available.',
    })).toBe('Provider OAuth [provider-oauth; configured, usable, healthy] - Provider OAuth credential is available.');
  });

  test('returns n/a when no route metadata is available', () => {
    expect(summarizeProviderAuthRoutes(undefined)).toBe('n/a');
    expect(summarizeProviderAuthRoutes([])).toBe('n/a');
  });
});
