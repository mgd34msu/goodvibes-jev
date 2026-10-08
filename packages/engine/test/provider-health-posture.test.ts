import { describe, expect, test } from 'bun:test';
import {
  buildProviderHealthDomainSummaries, buildAccountPosture, buildSyntheticAuthRoutes,
  routePriority, isRouteUsable, type ProviderHealthDomainInputs, type ProviderRuntimeAuthMetadata,
} from '@goodvibes-jev/engine/sdk/platform/runtime/provider-health';
import type { ProviderRuntimeSnapshot } from '../sdk/src/platform/providers/runtime-snapshot.ts';
import type { ProviderAuthRouteDescriptor } from '../sdk/src/platform/providers/interface.ts';
import { bundleBrowserEntrypoint } from './_helpers/browser-bundle.ts';

function inputs(): ProviderHealthDomainInputs {
  return {
    configManager: { get: (() => undefined) as ProviderHealthDomainInputs['configManager']['get'] },
    auth: { bootstrapCredentialPresent: false, userCount: 2, sessionCount: 3 },
    settings: { available: true, conflictCount: 0, recentFailureCount: 0, hasStagedManagedBundle: false, managedLockCount: 0 },
    remote: { supervisor: { sessions: [], degradedConnections: 0 } },
    security: { mcpServers: [] },
    intelligence: { diagnosticsStatus: 'ready', symbolSearchStatus: 'ready', completionsStatus: 'ready', hoverStatus: 'ready', totalRequests: 3, avgLatencyMs: 12.6 },
    continuity: { recoveryFilePresent: false, lastSessionPointer: null, sessionId: '' },
    worktrees: { summary: { total: 0, active: 0, paused: 0, pendingCleanup: 0, discard: 0 } },
    session: { session: {}, estimatedContextTokens: 1_000, contextWindow: 100_000, messageCount: 1 },
  };
}
function domain(input: ProviderHealthDomainInputs, name: string) {
  return buildProviderHealthDomainSummaries(input).find((entry) => entry.name === name)!;
}

describe('canonical provider-console domains (public package entrypoint)', () => {
  test('preserves all eight domains in order, empty states, and maintenance delegation', () => {
    const summaries = buildProviderHealthDomainSummaries(inputs());
    expect(summaries.map((entry) => [entry.name, entry.level])).toEqual([
      ['auth', 'good'], ['settings', 'good'], ['remote', 'info'], ['mcp', 'info'],
      ['intelligence', 'good'], ['maintenance', 'good'], ['continuity', 'info'], ['worktrees', 'info'],
    ]);
    expect(summaries[5]?.summary).toBe('Session maintenance is stable.');
    expect(summaries[4]?.summary).toBe('ready (3 req / 13ms avg)');
  });
  test('auth bootstrap and single-user flags retain repair instructions', () => {
    const base = inputs();
    expect(domain({ ...base, auth: { ...base.auth, userCount: 1 } }, 'auth')).toMatchObject({ level: 'warn', next: '/auth local review' });
    expect(domain({ ...base, auth: { ...base.auth, bootstrapCredentialPresent: true } }, 'auth')).toMatchObject({ level: 'warn', summary: 'bootstrap credential file still present', nextSteps: ['/auth local review', '/auth local rotate-password <user> <password>', '/auth local clear-bootstrap-file'] });
  });
  test('settings count, staged state, locks and unavailable posture stay distinct', () => {
    const base = inputs();
    const changed = { ...base, settings: { ...base.settings, conflictCount: 2, recentFailureCount: 3, hasStagedManagedBundle: true, managedLockCount: 4 } };
    expect(domain(changed, 'settings')).toMatchObject({ level: 'warn', summary: '2 conflicts / 3 failures / staged bundle' });
    expect(domain(changed, 'settings').details).toContain('4 managed lock(s) enforced');
    expect(domain({ ...changed, settings: { ...changed.settings, available: false } }, 'settings')).toMatchObject({ level: 'info', summary: 'settings control plane unavailable' });
  });
  test('remote filters typed transport/heartbeat/error states and limits details to three', () => {
    const sessions: ProviderHealthDomainInputs['remote']['supervisor']['sessions'] = [
      { runnerId: 'healthy', transportState: 'connected', heartbeat: { status: 'fresh', detail: '' } },
      { runnerId: 'degraded', transportState: 'degraded', heartbeat: { status: 'fresh', detail: '' } },
      { runnerId: 'stale', transportState: 'connected', heartbeat: { status: 'stale', detail: '' } },
      { runnerId: 'error', transportState: 'connected', heartbeat: { status: 'fresh', detail: '' }, lastError: 'fixture' },
      { runnerId: 'fourth', transportState: 'reconnecting', heartbeat: { status: 'offline', detail: '' } },
    ];
    const result = domain({ ...inputs(), remote: { supervisor: { sessions, degradedConnections: 4 } } }, 'remote');
    expect(result.level).toBe('warn');
    expect(result.details).toEqual(['degraded: transport=degraded heartbeat=fresh', 'stale: transport=connected heartbeat=stale', 'error: transport=connected heartbeat=fresh error=fixture']);
    expect(result.next).toBe('/remote recover <runnerId>');
  });
  test.each(['disconnected', 'stale', 'quarantined', 'allow-all'])('MCP %s is reviewable without text heuristics', (state) => {
    const result = domain({ ...inputs(), security: { mcpServers: [{ name: 'fixture', connected: state !== 'disconnected', schemaFreshness: state === 'stale' ? 'stale' : 'fresh', quarantineReason: state === 'quarantined' ? 'operator_flagged' : undefined, trustMode: state === 'allow-all' ? 'allow-all' : 'constrained' }] } }, 'mcp');
    expect(result.level).toBe('warn');
    expect(result.nextSteps).toEqual(['/mcp review', '/mcp auth-review', '/mcp repair']);
  });
  test('intelligence counts each readiness surface', () => {
    const base = inputs();
    const result = domain({ ...base, intelligence: { ...base.intelligence, diagnosticsStatus: 'starting', hoverStatus: 'unavailable' } }, 'intelligence');
    expect(result).toMatchObject({ level: 'warn', summary: '2 readiness surface(s) degraded', details: ['diagnostics=starting', 'hover=unavailable'] });
  });
  test.each([null, 0, NaN])('unknown context %s is neutral with explicit unavailable summary', (contextWindow) => {
    const base = inputs();
    expect(domain({ ...base, session: { ...base.session, contextWindow } }, 'maintenance')).toMatchObject({ level: 'info', summary: 'Context window unavailable.' });
  });
  test('maintenance maps failure and pressure to bad and warn', () => {
    const base = inputs();
    expect(domain({ ...base, session: { ...base.session, session: { compactionState: 'failed' } } }, 'maintenance').level).toBe('bad');
    expect(domain({ ...base, session: { ...base.session, estimatedContextTokens: 90_000 } }, 'maintenance').level).toBe('warn');
  });
  test('continuity recovery presence and worktree counters preserve next steps', () => {
    const base = inputs();
    expect(domain({ ...base, continuity: { ...base.continuity, recoveryFilePresent: true } }, 'continuity')).toMatchObject({ level: 'warn', summary: 'recovery file present for (unknown session)', next: '/resume <id>' });
    expect(domain({ ...base, continuity: { ...base.continuity, lastSessionPointer: 'fixture' } }, 'continuity').level).toBe('good');
    expect(domain({ ...base, worktrees: { summary: { total: 5, active: 2, paused: 1, pendingCleanup: 1, discard: 1 } } }, 'worktrees')).toMatchObject({ level: 'warn', summary: '5 tracked / 3 need review', details: ['1 paused worktree(s)', '1 cleanup pending', '1 marked discard'] });
  });
});

const snapshot = (auth?: ProviderRuntimeAuthMetadata) => ({ providerId: 'arbitrary-provider', active: false, modelCount: 2, runtime: { auth } });
const route = (route: ProviderAuthRouteDescriptor['route'], extras: Partial<ProviderAuthRouteDescriptor> = {}): ProviderAuthRouteDescriptor => ({ route, label: route, configured: true, freshness: 'healthy', ...extras });

describe('canonical provider descriptor posture', () => {
  test('priority is the original closed order', () => {
    expect(['subscription-oauth', 'service-oauth', 'secret-ref', 'api-key', 'anonymous', 'none', 'unconfigured'].map((r) => routePriority(r as Parameters<typeof routePriority>[0]))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  test.each(['api-key', 'oauth', 'anonymous', 'none'] as const)('legacy %s descriptor is synthesized', (mode) => {
    const routes = buildSyntheticAuthRoutes({ mode, configured: false, envVars: ['FIXTURE_KEY', 'OTHER_KEY'] });
    expect(routes[0]?.route).toBe(mode === 'oauth' ? 'service-oauth' : mode);
    expect(routes[0]?.usable).toBe(mode === 'none');
    if (mode === 'api-key') expect(routes[0]?.repairHints).toEqual(['Set FIXTURE_KEY or OTHER_KEY in the environment or secrets store.']);
  });
  test('missing auth remains unconfigured with a review hint', () => {
    expect(buildSyntheticAuthRoutes(undefined)).toEqual([]);
    expect(buildAccountPosture(snapshot())).toMatchObject({ activeRoute: 'unconfigured', authFreshness: 'unconfigured', routes: [], issues: ['Provider has no usable auth route configured.'], repairHints: ['Review arbitrary-provider provider credentials and routing metadata.'] });
  });
  test('declared descriptors are preserved and preferred/active selection stays distinct', () => {
    const routes = [route('api-key'), route('subscription-oauth', { usable: false, freshness: 'expired' }), route('secret-ref', { detail: 'Secret reference route', repairHints: ['repair fixture', '', 'repair fixture'] })];
    const result = buildAccountPosture(snapshot({ mode: 'api-key', configured: true, routes }));
    expect(result.routes).toBe(routes);
    expect(result).toMatchObject({ preferredRoute: 'subscription-oauth', activeRoute: 'secret-ref', activeRouteReason: 'Secret reference route', authFreshness: 'healthy', expiringSoon: true });
    expect(result.issues).toContain('subscription-oauth is expired.');
    expect(result.issues).toContain('Multiple auth routes are simultaneously usable; verify route priority before switching providers.');
    expect(result.repairHints).toEqual(['repair fixture']);
    expect(routes.map((r) => r.route)).toEqual(['api-key', 'subscription-oauth', 'secret-ref']);
  });
  test.each(['expiring', 'expired', 'pending'] as const)('secondary %s route sets expiringSoon', (freshness) => {
    const result = buildAccountPosture(snapshot({ mode: 'oauth', configured: true, routes: [route('subscription-oauth'), route('service-oauth', { usable: false, freshness })] }));
    expect(result.authFreshness).toBe('healthy');
    expect(result.expiringSoon).toBe(true);
  });
  test('explicit usable false wins over configured and fallback preserves preferred route', () => {
    const descriptor = route('anonymous', { usable: false });
    expect(isRouteUsable(descriptor)).toBe(false);
    const result = buildAccountPosture(snapshot({ mode: 'anonymous', configured: true, routes: [descriptor] }));
    expect(result.activeRoute).toBe('anonymous');
    expect(result.issues).toEqual(['anonymous is configured but not currently usable.']);
  });
  test('explicit no-auth remains healthy; empty descriptors use legacy synthesis', () => {
    expect(buildAccountPosture(snapshot({ mode: 'none', configured: false, routes: [] }))).toMatchObject({ activeRoute: 'none', authFreshness: 'healthy', issues: [], repairHints: [] });
  });
});

test('public consumer bundles for browsers and its emitted functions execute without Node services', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(import.meta.dir, '.test-tmp');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'provider-health-browser-'));
  try {
    const entry = join(dir, 'consumer.ts');
    writeFileSync(entry, `import { buildAccountPosture, buildProviderHealthDomainSummaries } from '@goodvibes-jev/engine/sdk/platform/runtime/provider-health';\nglobalThis.__providerHealthProbe = { buildAccountPosture, buildProviderHealthDomainSummaries };`);
    const code = await bundleBrowserEntrypoint(entry, { conditions: ['bun'] });
    expect(code).not.toMatch(/(?:from|require\()\s*['"](?:node:|bun:)/);
    const consumer: { __providerHealthProbe?: { buildAccountPosture: typeof buildAccountPosture; buildProviderHealthDomainSummaries: typeof buildProviderHealthDomainSummaries } } = {};
    new Function('globalThis', code)(consumer);
    expect(consumer.__providerHealthProbe?.buildAccountPosture(snapshot()).authFreshness).toBe('unconfigured');
    expect(consumer.__providerHealthProbe?.buildProviderHealthDomainSummaries(inputs())).toEqual(buildProviderHealthDomainSummaries(inputs()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// This assignment is compiled under the engine test project's exact optional
// property rules: the public builder must accept real runtime snapshots.
const postureForRuntimeSnapshot: (snapshot: ProviderRuntimeSnapshot) => ReturnType<typeof buildAccountPosture> = buildAccountPosture;
test('public posture input accepts actual runtime metadata with optional fields explicitly undefined', () => {
  expect(postureForRuntimeSnapshot({ providerId: 'optional-fields', active: false, modelCount: 0, models: [], runtime: { auth: { mode: 'api-key', configured: false, detail: undefined, envVars: undefined, routes: undefined } } }).authFreshness).toBe('unconfigured');
});
