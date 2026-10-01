import { describe, expect, test } from 'bun:test';
import {
  deriveCredentialAvailability,
  deriveProviderStatus,
  freshnessTone,
  providerHeaderLabel,
  providerStatePhrase,
} from './provider-status';
import { bestStatus } from './object';

describe('deriveProviderStatus: worst-wins freshness roll-up', () => {
  test('a single healthy route reads healthy, not "unknown"', () => {
    const status = deriveProviderStatus({
      routes: [{ route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' }],
    });
    expect(status.freshness).toBe('healthy');
  });

  test('expiring, expired, and pending each render their own honest label', () => {
    expect(deriveProviderStatus({ routes: [{ configured: true, freshness: 'expiring' }] }).freshness).toBe('expiring');
    expect(deriveProviderStatus({ routes: [{ configured: true, freshness: 'expired' }] }).freshness).toBe('expired');
    expect(deriveProviderStatus({ routes: [{ configured: true, freshness: 'pending' }] }).freshness).toBe('pending');
  });

  test('a multi-route provider rolls up to the worst meaningful freshness (expired beats healthy)', () => {
    const status = deriveProviderStatus({
      routes: [
        { route: 'api-key', configured: true, freshness: 'healthy' },
        { route: 'service-oauth', configured: true, freshness: 'expired' },
      ],
    });
    expect(status.freshness).toBe('expired');
  });

  test('worst-wins ranking holds for every pair (expired > expiring > pending > healthy)', () => {
    const rollup = (a: string, b: string) =>
      deriveProviderStatus({ routes: [{ configured: true, freshness: a }, { configured: true, freshness: b }] }).freshness;
    expect(rollup('expiring', 'healthy')).toBe('expiring');
    expect(rollup('pending', 'healthy')).toBe('pending');
    expect(rollup('expired', 'expiring')).toBe('expired');
    expect(rollup('expired', 'pending')).toBe('expired');
  });

  test('a bad route is never hidden behind a good one. The detail list still carries every route', () => {
    const status = deriveProviderStatus({
      routes: [
        { route: 'api-key', configured: true, freshness: 'healthy' },
        { route: 'service-oauth', configured: true, freshness: 'expired', detail: 'token expired 2h ago' },
      ],
    });
    expect(status.freshness).toBe('expired');
    expect(status.routes).toHaveLength(2);
    expect(status.routes.find((r) => r.route === 'service-oauth')?.detail).toBe('token expired 2h ago');
  });
});

describe('deriveProviderStatus: configured header sourcing', () => {
  test('a configured provider with a usable model list is configured, and the header names how', () => {
    const status = deriveProviderStatus({
      configured: true,
      configuredVia: 'env',
      routes: [{ route: 'api-key', configured: true, freshness: 'healthy' }],
    });
    expect(status.configured).toBe(true);
    expect(providerHeaderLabel(status)).toContain('env');
  });

  test('configured flag nested at runtime.auth.configured (providers.get shape) is honored even with no flat configuredVia', () => {
    const status = deriveProviderStatus({
      runtime: { auth: { configured: true, routes: [{ route: 'api-key', configured: true, freshness: 'healthy' }] } },
    });
    expect(status.configured).toBe(true);
  });

  test('a genuinely unconfigured provider is not configured', () => {
    const status = deriveProviderStatus({ configured: false, routes: [{ route: 'api-key', configured: false, freshness: 'unconfigured' }] });
    expect(status.configured).toBe(false);
  });
});

describe('deriveProviderStatus: unconfigured vs status-unavailable (different truths)', () => {
  test('every route explicitly reporting "unconfigured" -> the pill reads "unconfigured"', () => {
    const status = deriveProviderStatus({
      routes: [{ route: 'api-key', configured: false, freshness: 'unconfigured' }],
    });
    expect(status.freshness).toBe('unconfigured');
  });

  test('no route data at all (health genuinely absent) -> "status unavailable", distinct from "unconfigured"', () => {
    const status = deriveProviderStatus({ id: 'some-provider', label: 'Some Provider' });
    expect(status.freshness).toBe('status unavailable');
    expect(status.freshness).not.toBe('unconfigured');
  });

  test('an empty routes array also reads "status unavailable" (no per-route signal to roll up)', () => {
    const status = deriveProviderStatus({ routes: [] });
    expect(status.freshness).toBe('status unavailable');
  });
});

describe('deriveProviderStatus: unknown/future freshness on a configured route (F7f forward-compat ruling)', () => {
  test('an unrecognized freshness value on a CONFIGURED route is never read as healthy, it surfaces as "status unavailable"', () => {
    const status = deriveProviderStatus({
      routes: [{ route: 'api-key', configured: true, freshness: 'quantum-degraded' }],
    });
    expect(status.freshness).toBe('status unavailable');
    // The per-route normalization must have caught the unknown value, not passed it through.
    expect(status.routes[0].freshness).toBe('status unavailable');
  });

  test('an unrecognized freshness on an UNCONFIGURED route stays "unconfigured" (not a fault)', () => {
    const status = deriveProviderStatus({
      routes: [{ route: 'api-key', configured: false, freshness: 'quantum-degraded' }],
    });
    expect(status.freshness).toBe('unconfigured');
  });

  test('a configured-but-unknown route is SURFACED, not hidden behind a healthy sibling', () => {
    const status = deriveProviderStatus({
      routes: [
        { route: 'api-key', configured: true, freshness: 'healthy' },
        { route: 'service-oauth', configured: true, freshness: 'from-a-future-daemon' },
      ],
    });
    // Without the ruling this rolled up to 'healthy', hiding the route we can't vouch for.
    expect(status.freshness).toBe('status unavailable');
  });

  test('a KNOWN degraded state still dominates an unknown one (a real fault is more severe/actionable)', () => {
    const rollup = (a: string, b: string) =>
      deriveProviderStatus({ routes: [{ configured: true, freshness: a }, { configured: true, freshness: b }] }).freshness;
    expect(rollup('expired', 'from-the-future')).toBe('expired');
    expect(rollup('expiring', 'from-the-future')).toBe('expiring');
    // …but the unknown state outranks the benign ones (we can't vouch for it).
    expect(rollup('healthy', 'from-the-future')).toBe('status unavailable');
    expect(rollup('pending', 'from-the-future')).toBe('status unavailable');
  });
});

describe('deriveProviderStatus: per-route detail', () => {
  test('carries freshness, detail, and repairHints per route for the expanded view', () => {
    const status = deriveProviderStatus({
      routes: [
        {
          route: 'service-oauth',
          label: 'Service OAuth',
          configured: true,
          freshness: 'expired',
          detail: 'refresh token expired',
          repairHints: ['re-authenticate via the service dashboard', 'check clock skew'],
        },
      ],
    });
    const [route] = status.routes;
    expect(route.freshness).toBe('expired');
    expect(route.detail).toBe('refresh token expired');
    expect(route.repairHints).toEqual(['re-authenticate via the service dashboard', 'check clock skew']);
  });
});

describe('bestStatus is unchanged for non-provider consumers (no regression)', () => {
  test('bestStatus still reads the generic status/state/phase/health/authFreshness/kind fallback chain', () => {
    expect(bestStatus({ status: 'running' })).toBe('running');
    expect(bestStatus({ state: 'blocked' })).toBe('blocked');
    expect(bestStatus({})).toBe('unknown');
  });
});

describe('deriveCredentialAvailability (honest degrade)', () => {

  test('a healthy credentials.get result yields status metadata, never bytes', () => {
    const out = deriveCredentialAvailability({
      ok: true,
      value: {
        available: true,
        credentials: [
          { key: 'SHARED_CHANNEL_TOKEN', configured: true, usable: true, source: 'store', secure: true },
          { key: 'BROKEN_REF', configured: true, usable: false, source: 'env-ref' },
        ],
      },
    });
    expect(out.available).toBe(true);
    if (out.available) {
      expect(out.credentials).toHaveLength(2);
      expect(out.credentials[0]).toEqual({ key: 'SHARED_CHANNEL_TOKEN', configured: true, usable: true, source: 'store', secure: true });
      // The type carries no value field, statically true; pin it dynamically too.
      for (const c of out.credentials) expect('value' in c).toBe(false);
    }
  });

  test('503 CREDENTIAL_STORE_UNAVAILABLE degrades honestly, never fabricated-configured', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'CREDENTIAL_STORE_UNAVAILABLE', status: 503 } });
    expect(out.available).toBe(false);
  });

  test('METHOD_NOT_FOUND from an older daemon degrades with the not-served reason', () => {
    const out = deriveCredentialAvailability({ ok: false, error: { code: 'METHOD_NOT_FOUND', status: 404 } });
    expect(out.available).toBe(false);
  });

  test('a transport failure degrades generically; a malformed body degrades too', () => {
    const failed = deriveCredentialAvailability({ ok: false, error: new Error('fetch failed') });
    expect(failed.available).toBe(false);
    const malformed = deriveCredentialAvailability({ ok: true, value: { credentials: 'nope' } });
    expect(malformed.available).toBe(false);
  });
});

describe('deriveProviderStatus: a usable route IS a configured provider', () => {
  // The live daemon has been observed reporting runtime.auth.configured false
  // ("OPENAI_API_KEY or OPENAI_KEY not set") while its own subscription-oauth
  // route reports configured+usable+healthy. The header must side with the
  // routes: "not configured" beside a healthy pill contradicts itself.
  test('aggregate configured:false is overridden by a usable subscription-oauth route', () => {
    const status = deriveProviderStatus({
      runtime: {
        auth: {
          configured: false,
          detail: 'OPENAI_API_KEY or OPENAI_KEY not set',
          routes: [
            { route: 'api-key', configured: false, usable: false, freshness: 'unconfigured' },
            { route: 'subscription-oauth', configured: true, usable: true, freshness: 'healthy' },
          ],
        },
      },
    });
    expect(status.configured).toBe(true);
    expect(status.freshness).toBe('healthy');
  });

  test('all-unconfigured routes still read not configured', () => {
    const status = deriveProviderStatus({
      runtime: {
        auth: {
          configured: false,
          routes: [{ route: 'api-key', configured: false, usable: false, freshness: 'unconfigured' }],
        },
      },
    });
    expect(status.configured).toBe(false);
  });
});

describe('plain-language provider state (settings dialog rows)', () => {
  test('every freshness has a dot tone', () => {
    expect(freshnessTone('healthy')).toBe('ok');
    expect(freshnessTone('expiring')).toBe('warn');
    expect(freshnessTone('expired')).toBe('bad');
    expect(freshnessTone('unconfigured')).toBe('idle');
  });

  test('the row phrase names where a configured provider was set up', () => {
    const configured = providerStatePhrase({ freshness: 'healthy', configured: true, configuredVia: 'env', routes: [] });
    expect(configured).toContain('env');
    expect(providerStatePhrase({ freshness: 'unconfigured', configured: false, configuredVia: '', routes: [] }))
      .not.toBe(configured);
  });
});
