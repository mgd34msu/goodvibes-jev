import { expect, test, spyOn, setSystemTime } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createBuiltinProviderHealthModalSurface } from '../../../views/builtin-modals.ts';
import type { ResolvedBuiltinViewDeps } from '../../../views/view-deps.ts';
import { createProviderHealthModalSurface } from '../../../views/modals/provider-health-modal.ts';
import type { ProviderRuntimeSnapshot, ProviderRuntimeMetadata } from '@goodvibes-jev/engine/sdk/platform/providers';
import { buildProviderHealthDomainSummaries, buildAccountPosture } from '@goodvibes-jev/engine/sdk/platform/runtime/provider-health';
import { buildProviderHealthDomainSummaries as localDomains } from '../../../views/provider-health-domains.ts';
import { buildAccountPosture as localPosture } from '../../../views/provider-health-routes.ts';
import { handleConfigModalToken } from '../../../input/handler-modal-routes.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture() {
  let reads = 0;
  let fail = false;
  let quarantineReason: string | undefined = 'operator_flagged';
  let trustMode = 'allow-all';
  let contextWindow: number | null = null;
  const declared: ProviderRuntimeMetadata = { auth: { mode: 'oauth', configured: true, routes: [
    { route: 'secret-ref', label: 'Vault reference', configured: true, usable: true, freshness: 'healthy', detail: 'Fixture route detail', repairHints: ['Review fixture vault reference'] },
    { route: 'anonymous', label: 'Local anonymous', configured: true, usable: false, freshness: 'pending', detail: 'Fixture pending route' },
  ] } };
  const providers = [
    { name: 'generic', models: [], describeRuntime: () => declared },
    { name: 'missing', models: [] },
    { name: 'null-metadata', models: [], describeRuntime: () => null },
    { name: 'explicit-none', models: [], describeRuntime: () => ({ auth: { mode: 'none', configured: false } }) },
    { name: 'explicit-unconfigured', models: [], describeRuntime: () => ({ auth: { mode: 'api-key', configured: false } }) },
  ];
  const readModel = (getSnapshot: () => unknown) => ({ getSnapshot, subscribe: () => () => {} });
  const values = {
    localAuth: readModel(() => ({ bootstrapCredentialPresent: false, userCount: 2, sessionCount: 1 })),
    providers: readModel(() => ({ providerIds: ['uninspected'] })),
    settings: readModel(() => ({ available: true, conflictCount: 0, recentFailureCount: 0, managedLockCount: 0, hasStagedManagedBundle: false })),
    remote: readModel(() => ({ supervisor: { sessions: [], degradedConnections: 0 } })),
    security: readModel(() => ({ mcpServers: [{ name: 'fixture-mcp', connected: true, schemaFreshness: 'fresh', trustMode, quarantineReason }] })),
    intelligence: readModel(() => ({ diagnosticsStatus: 'ready', symbolSearchStatus: 'ready', completionsStatus: 'ready', hoverStatus: 'ready', totalRequests: 0, avgLatencyMs: 0 })),
    continuity: readModel(() => ({ recoveryFilePresent: false, lastSessionPointer: null, sessionId: '' })),
    worktrees: readModel(() => ({ summary: { total: 0, active: 0, paused: 0, pendingCleanup: 0, discard: 0 } })),
    session: readModel(() => ({ estimatedContextTokens: 0, contextWindow, messageCount: 0, session: {} })),
  };
  const deps = {
    configManager: { get: () => undefined },
    uiServices: { readModels: values, providers: {
      benchmarkStore: {}, favoritesStore: {},
      providerRegistry: {
        listProviders: () => providers,
        getRegistered: (id: string) => providers.find((provider) => provider.name === id),
        getCurrentModel: () => { throw new Error('no active model'); },
        listModels: () => [],
        describeRuntime: (id: string) => { reads++; if (fail) throw new Error('fixture unavailable'); return providers.find((provider) => provider.name === id)?.describeRuntime?.(); },
      },
    } },
  } as unknown as ResolvedBuiltinViewDeps;
  return { deps, values, declared, reads: () => reads, fail: () => { fail = true; }, healthy: () => { quarantineReason = undefined; trustMode = 'constrained'; contextWindow = 100_000; } };
}
function text(rows: readonly { label: string }[]) { return rows.map((row) => row.label).join('\n'); }

test('compatibility exports are the canonical functions, not parallel product algorithms', () => {
  expect(localDomains).toBe(buildProviderHealthDomainSummaries);
  expect(localPosture).toBe(buildAccountPosture);
  const source = readFileSync(new URL('../../../views/builtin-modals.ts', import.meta.url), 'utf8');
  expect(source).toContain('manager.registerModalSurface(createBuiltinProviderHealthModalSurface(deps))');
});

test('production factory composes real runtime inspection, generic descriptors and all eight domains', async () => {
  const f = fixture();
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  surface.onOpen?.(() => {});
  try {
    await flush();
    const view = surface.buildView();
    expect(f.reads()).toBe(4);
    expect(view.tabs.map((tab) => tab.id)).toEqual(['health', 'accounts', 'routes', 'domains']);
    const accounts = text(view.tabs[2]!.rows);
    expect(accounts).toContain('active=secret-ref preferred=secret-ref freshness=healthy');
    expect(accounts).toContain('Vault reference: secret-ref configured=yes usable=yes freshness=healthy; Fixture route detail');
    expect(accounts).toContain('issue: Fixture pending route');
    expect(accounts).toContain('next: Review fixture vault reference');
    expect(view.tabs[0]!.rows.every((row) => row.id.startsWith('provider:'))).toBe(true);
    const domains = text(view.tabs[3]!.rows);
    expect(view.tabs[3]!.rows.filter((row) => row.header).map((row) => row.id)).toEqual(['domain:auth', 'domain:settings', 'domain:remote', 'domain:mcp', 'domain:intelligence', 'domain:maintenance', 'domain:continuity', 'domain:worktrees']);
    expect(domains).toContain('fixture-mcp: trust=allow-all schema=fresh quarantine=operator_flagged');
    expect(domains).toContain('next: /mcp auth-review');
    expect(domains).toContain('Context window unavailable.');
    f.healthy();
    const changed = text(surface.buildView().tabs[3]!.rows);
    expect(changed).toContain('all MCP servers are healthy');
    expect(changed).toContain('Session maintenance is stable.');
  } finally { surface.onClose?.(); }
});

test('real runtime snapshot missing/null metadata stays unknown; only explicit none is healthy', async () => {
  const f = fixture();
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  surface.onOpen?.(() => {});
  try {
    await flush();
    const rows = surface.buildView().tabs[2]!.rows;
    for (const id of ['missing', 'null-metadata']) {
      expect(rows.find((row) => row.id === `auth:${id}:unavailable`)?.label).toContain('Auth posture unavailable');
      expect(rows.some((row) => row.id === `auth:${id}:posture`)).toBe(false);
    }
    expect(rows.find((row) => row.id === 'auth:explicit-none:posture')?.label).toContain('active=none preferred=none freshness=healthy');
    expect(rows.find((row) => row.id === 'auth:explicit-unconfigured:posture')?.label).toContain('active=api-key preferred=api-key freshness=unconfigured');
    expect(rows.find((row) => row.id === 'auth:uninspected:unavailable')?.label).toContain('unavailable');
  } finally { surface.onClose?.(); }
});

test('missing readmodel data is honestly unavailable and never rendered as healthy', () => {
  const f = fixture();
  f.values.security.getSnapshot = () => { throw new Error('unavailable'); };
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  expect(text(surface.buildView().tabs[3]!.rows)).toBe('Health-domain posture unavailable');
});

test('actual host renders canonical account details and maintains the existing selected-provider repair dispatch', async () => {
  const f = fixture();
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  try {
    await flush();
    modal.nextTab();
    modal.nextTab();
    const rendered = frameFromLayer(renderConfigModal(modal, 160, 60), 160, 60).map((line) => line.map((cell) => cell.char).join('')).join('\n');
    expect(rendered).toContain('active=secret-ref');
    expect(rendered).toContain('Review fixture vault reference');
    expect(rendered).toContain('Auth posture unavailable');
    expect(rendered).toContain('active=none preferred=none freshness=healthy');
    expect(rendered).toContain('active=api-key preferred=api-key freshness=unconfigured');
    const calls: unknown[] = [];
    surface.onAction?.('repair', { row: { id: 'provider:generic', label: '' }, tabId: 'accounts', print: () => {}, requestRender: () => {}, setStatus: () => {}, close: () => {}, executeCommand: async (name, args) => { calls.push([name, args]); } });
    expect(calls).toEqual([['accounts', ['repair', 'generic']]]);
    modal.nextTab();
    const domains = frameFromLayer(renderConfigModal(modal, 160, 70), 160, 70).map((line) => line.map((cell) => cell.char).join('')).join('\n');
    expect(domains).toContain('trust=allow-all');
    expect(domains).toContain('context window unavailable.');
  } finally { modal.close(); }
});


test('read-only Routes details and long hints remain reachable through actual narrow host navigation', async () => {
  const f = fixture();
  // A single provider is the pathological case: selectable parent rows must
  // not trap all informational detail below the viewport.
  const registry = f.deps.uiServices.providers.providerRegistry;
  const listed = registry.listProviders();
  registry.listProviders = () => listed.filter((provider) => provider.name === 'generic');
  f.values.providers.getSnapshot = () => ({ providerIds: [] });
  const hints = Array.from({ length: 20 }, (_, index) => `repair hint ${index}`);
  hints.push('a long hint '.repeat(30) + 'LAST_HINT_SENTINEL');
  const auth = f.declared.auth!;
  (auth.routes![0] as { repairHints?: readonly string[] }).repairHints = hints;
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  const modal = new ConfigModal();
  modal.open(surface, () => {});
  try {
    await flush();
    const route = { configModal: modal, requestRender: () => {}, handleEscape: () => modal.close() };
    const key = (logicalName: string) => handleConfigModalToken(route, { type: 'key', logicalName } as never);
    key('right');
    key('right');
    modal.setViewportRows(6);
    for (const width of [30, 18, 60]) {
      // Width changes must rebuild wrapping without hiding the bottom of a
      // long individual hint. Exercise the real keyboard dispatcher on each.
      key('left');
      key('right');
      const seen = new Set<string>();
      const labels: string[] = [];
      for (let i = 0; i < 180; i++) {
        const rendered = modal.getRenderModel(width);
        for (const row of rendered.rows) { seen.add(row.id); labels.push(row.label); }
        expect(rendered.rows.every((row) => !row.selectable)).toBe(true);
        key('down');
      }
      expect(labels.join(' ')).toContain('LAST_HINT_SENTINEL');
      expect(labels.join(' ')).toContain('repair hint 19');
      expect(seen.size).toBe(modal.getRenderModel(width).scroll.total);
      expect(surface.actions?.find((action) => action.id === 'repair')?.enabledFor?.(null, 'routes')).toBe(false);
    }
    key('escape');
    expect(modal.active).toBe(false);
  } finally { modal.close(); }
});

test('failed refresh labels retained metadata as last-known instead of fresh posture', async () => {
  const f = fixture();
  const surface = createBuiltinProviderHealthModalSurface(f.deps);
  surface.onOpen?.(() => {});
  try {
    await flush();
    f.fail();
    surface.onAction?.('refresh', { row: null, tabId: 'routes', print: () => {}, requestRender: () => {}, setStatus: () => {}, close: () => {} });
    await flush();
    const view = surface.buildView();
    expect(view.degraded).toContain('last-known posture');
    expect(text(view.tabs[2]!.rows)).toContain('active=secret-ref');
  } finally { surface.onClose?.(); }
});


test('overlapping refreshes and a closed/reopened modal reject stale inspection results', async () => {
  const pending: Array<{ resolve: (snapshots: readonly ProviderRuntimeSnapshot[]) => void; reject: (error: Error) => void }> = [];
  const surface = createProviderHealthModalSurface({ listProviderIds: () => ['fixture'], inspectAll: () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); }) });
  const result = (mode: 'api-key' | 'none'): ProviderRuntimeSnapshot[] => [{ providerId: 'fixture', active: false, modelCount: 0, models: [], runtime: { auth: { mode, configured: true } } }];
  const refresh = () => surface.onAction?.('refresh', { row: null, tabId: 'routes', print: () => {}, requestRender: () => {}, setStatus: () => {}, close: () => {} });
  let renders = 0;
  surface.onOpen?.(() => { renders++; });
  try {
    refresh();
    pending[1]!.resolve(result('none'));
    await flush();
    pending[0]!.resolve(result('api-key'));
    await flush();
    expect(text(surface.buildView().tabs[2]!.rows)).toContain('active=none');
    refresh();
    surface.onClose?.();
    const closedRenders = renders;
    surface.onOpen?.(() => { renders++; });
    pending[2]!.resolve(result('api-key'));
    await flush();
    expect(renders).toBe(closedRenders);
    pending[3]!.resolve(result('none'));
    await flush();
    refresh();
    refresh();
    pending[5]!.resolve(result('none'));
    await flush();
    pending[4]!.reject(new Error('superseded failure'));
    await flush();
    expect(surface.buildView().degraded).toBeUndefined();
    expect(text(surface.buildView().tabs[2]!.rows)).toContain('active=none');
  } finally { surface.onClose?.(); }
});


test('automatic 3s ticks coalesce while a slow inspection is pending and eventually publish', async () => {
  const originalSetInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
    expect(delay).toBe(3_000);
    tick = callback;
    return originalSetInterval(() => {}, 2_147_483_647);
  }) as typeof setInterval);
  const pending: Array<(snapshots: readonly ProviderRuntimeSnapshot[]) => void> = [];
  const surface = createProviderHealthModalSurface({ listProviderIds: () => ['slow'], inspectAll: () => new Promise((resolve) => { pending.push(resolve); }) });
  const now = Date.now();
  try {
    surface.onOpen?.(() => {});
    expect(pending).toHaveLength(1);
    for (const elapsed of [3_000, 6_000, 9_000]) {
      setSystemTime(now + elapsed);
      tick?.();
      expect(pending).toHaveLength(1);
    }
    pending[0]!([{ providerId: 'slow', active: true, modelCount: 1, models: [], runtime: { auth: { mode: 'none', configured: false } } }]);
    await flush();
    expect(text(surface.buildView().tabs[2]!.rows)).toContain('active=none preferred=none freshness=healthy');
    setSystemTime(now + 12_000);
    tick?.();
    expect(pending).toHaveLength(2);
  } finally {
    surface.onClose?.();
    interval.mockRestore();
    setSystemTime();
  }
});
