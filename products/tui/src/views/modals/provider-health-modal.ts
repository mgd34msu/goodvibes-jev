import type { ConfigModalActionContext, ConfigModalRow, ConfigModalSurface, ConfigModalView } from '../../input/config-modal-types.ts';
import type { UiReadModel, UiProvidersSnapshot } from '../../runtime/ui-read-models.ts';
import type { ProviderRuntimeSnapshot } from '@goodvibes-jev/engine/sdk/platform/providers';
import { buildAccountPosture, isRouteUsable } from '../provider-health-routes.ts';
import { buildProviderHealthDomainSummaries, type ProviderHealthDomainInputs } from '../provider-health-domains.ts';
import { toneStyle, statusGlyph, pad, postureLine, kv } from './modal-surface-helpers.ts';

/** The slice of ProviderRuntimeInspectionQuery this surface consumes. */
export interface ProviderRuntimeInspect {
  listProviderIds(): readonly string[];
  inspectAll(): Promise<readonly ProviderRuntimeSnapshot[]>;
}

/**
 * Provider-health config-modal surface (migrated from the `provider-health`
 * view, the charter's live-modal exemplar; also the target of the `providers`
 * and `accounts` redirects). providerRuntime.inspectAll() is async, so its
 * result is cached and refreshed on open, on `r`, and on a 3s live tick (the
 * view's display-tick cadence); buildView reads the cache synchronously so
 * live status/model-count values update in place with a stable layout.
 *
 * Auth-route descriptors and the eight repair domains are presented through
 * the engine-owned pure posture builders. Credential-backed account commands
 * and the existing Enter repair dispatch retain their separate responsibilities.
 */
class ProviderHealthModalSurface implements ConfigModalSurface {
  readonly name = 'providers-modal';
  readonly title = 'Providers';
  private requestRender: () => void = () => {};
  private cache = new Map<string, ProviderRuntimeSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsub: (() => void) | null = null;
  private loaded = false;
  private inspectionFailed = false;
  private inspectionGeneration = 0;
  private pendingInspection: number | null = null;
  private opened = false;

  constructor(
    private readonly providerRuntime: ProviderRuntimeInspect,
    private readonly providersReadModel?: UiReadModel<UiProvidersSnapshot>,
    private readonly domainInputs?: () => ProviderHealthDomainInputs,
  ) {}

  readonly actions = [
    {
      key: 'enter', id: 'repair', label: 'repair',
      enabledFor: (row: ConfigModalRow | null, tabId: string) =>
        (tabId === 'health' || tabId === 'accounts') && Boolean(row?.id.startsWith('provider:')),
    },
    { key: 'r', id: 'refresh', label: 'refresh posture' },
  ];

  onOpen(requestRender: () => void): void {
    this.opened = true;
    this.requestRender = requestRender;
    void this.reinspect();
    if (this.providersReadModel && !this.unsub) this.unsub = this.providersReadModel.subscribe(() => this.requestRender());
    if (this.timer === null) this.timer = setInterval(() => {
      // Slow metadata must eventually publish. Only explicit refresh supersedes
      // an in-flight inspection; automatic ticks coalesce until it completes.
      if (this.pendingInspection === null) void this.reinspect();
    }, 3_000);
  }

  onClose(): void {
    this.opened = false;
    this.inspectionGeneration++;
    this.pendingInspection = null;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.unsub?.();
    this.unsub = null;
  }

  private providerIds(): string[] {
    const ids = new Set<string>([
      ...(this.providersReadModel?.getSnapshot().providerIds ?? []),
      ...this.providerRuntime.listProviderIds(),
      ...this.cache.keys(),
    ]);
    return [...ids].sort((a, b) => a.localeCompare(b));
  }

  buildView(): ConfigModalView {
    const ids = this.providerIds();
    const active = ids.filter((id) => this.cache.get(id)?.active).length;
    const header = [postureLine([
      kv('providers', ids.length),
      kv('active', active),
      kv('inspected', this.cache.size),
    ])];

    const rowFor = (id: string): ConfigModalRow => {
      const snap = this.cache.get(id);
      const isActive = Boolean(snap?.active);
      return {
        id: `provider:${id}`,
        label: `${statusGlyph(isActive ? 'good' : 'dim')} ${pad(id, 18)} ${pad(isActive ? 'ACTIVE' : 'idle', 8)} models=${snap?.modelCount ?? '—'}`,
        style: toneStyle(isActive ? 'good' : 'dim'),
      };
    };

    const rows = ids.map(rowFor);
    const routeRows = ids.flatMap((id): ConfigModalRow[] => {
      const snapshot = this.cache.get(id);
      const providerRow = { ...rowFor(id), selectable: false, header: true };
      // An uninspected provider is unknown, not an implicitly healthy account.
      if (!snapshot?.runtime?.auth) return [providerRow, {
        id: `auth:${id}:unavailable`, label: '  Auth posture unavailable', selectable: false,
      }];
      const posture = buildAccountPosture(snapshot);
      return [
        providerRow,
        { id: `auth:${id}:posture`, label: `  active=${posture.activeRoute} preferred=${posture.preferredRoute} freshness=${posture.authFreshness}`, selectable: false },
        { id: `auth:${id}:reason`, label: `  ${posture.activeRouteReason}`, selectable: false },
        ...posture.routes.map((route, index): ConfigModalRow => ({
          id: `auth:${id}:route:${index}`,
          label: `  ${route.label}: ${route.route} configured=${route.configured ? 'yes' : 'no'} usable=${isRouteUsable(route) ? 'yes' : 'no'} freshness=${route.freshness ?? 'unconfigured'}${route.detail ? `; ${route.detail}` : ''}`,
          selectable: false,
        })),
        ...posture.issues.map((issue, index): ConfigModalRow => ({ id: `auth:${id}:issue:${index}`, label: `  issue: ${issue}`, selectable: false, style: toneStyle('warn') })),
        ...posture.repairHints.map((hint, index): ConfigModalRow => ({ id: `auth:${id}:hint:${index}`, label: `  next: ${hint}`, selectable: false })),
      ];
    });
    const domainRows: ConfigModalRow[] = [];
    if (this.domainInputs) {
      try {
        for (const domain of buildProviderHealthDomainSummaries(this.domainInputs())) {
          domainRows.push(
            { id: `domain:${domain.name}`, label: `${statusGlyph(domain.level)} ${domain.name}: ${domain.summary}`, style: toneStyle(domain.level), selectable: false, header: true },
            ...domain.details.map((detail, index): ConfigModalRow => ({ id: `domain:${domain.name}:detail:${index}`, label: `  ${detail}`, selectable: false })),
            ...domain.nextSteps.map((step, index): ConfigModalRow => ({ id: `domain:${domain.name}:next:${index}`, label: `  next: ${step}`, selectable: false })),
          );
        }
      } catch {
        domainRows.push({ id: 'domains:unavailable', label: 'Health-domain posture unavailable', selectable: false, style: toneStyle('warn') });
      }
    }
    const emptyText = ids.length === 0
      ? (this.loaded ? 'No providers registered. Try /provider or /subscription.' : 'Inspecting providers…')
      : undefined;

    return {
      title: 'Providers',
      ...(this.inspectionFailed ? { degraded: 'Provider inspection unavailable; showing last-known posture where available.' } : {}),
      scrollInformationalLines: true,
      tabs: [
        { id: 'health', label: 'Health', header, rows, emptyText, hints: ['r refresh posture', '/health for latency & routes'] },
        { id: 'accounts', label: 'Accounts', header, rows: ids.map(rowFor), emptyText, hints: ['Enter repair', '/accounts routes <p> for detail'] },
        { id: 'routes', label: 'Routes', header, rows: routeRows, emptyText, hints: ['↑↓ scroll details', 'Accounts tab for repair'] },
        ...(this.domainInputs ? [{ id: 'domains', label: 'Domains', rows: domainRows, hints: ['/health <domain> for detail'] }] : []),
      ],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') {
      void this.reinspect();
      ctx.setStatus('Refreshing provider posture…');
      return;
    }
    if (id === 'repair') {
      const provider = ctx.row?.id.startsWith('provider:') ? ctx.row.id.slice('provider:'.length) : null;
      if (!provider) return;
      void ctx.executeCommand?.('accounts', ['repair', provider]);
      ctx.setStatus(`Dispatched /accounts repair ${provider} (see transcript).`);
    }
  }

  private async reinspect(): Promise<void> {
    if (!this.opened) return;
    const generation = ++this.inspectionGeneration;
    this.pendingInspection = generation;
    try {
      const snapshots = await this.providerRuntime.inspectAll();
      if (!this.opened || generation !== this.inspectionGeneration) return;
      const next = new Map<string, ProviderRuntimeSnapshot>();
      for (const s of snapshots) next.set(s.providerId, s);
      this.cache = next;
      this.inspectionFailed = false;
    } catch {
      if (!this.opened || generation !== this.inspectionGeneration) return;
      this.inspectionFailed = true;
      // Leave the last-known cache in place; a transient inspect failure should
      // not blank the live table (honest degraded behaviour).
    } finally {
      if (!this.opened || generation !== this.inspectionGeneration) return;
      this.pendingInspection = null;
      this.loaded = true;
      this.requestRender();
    }
  }
}

export function createProviderHealthModalSurface(
  providerRuntime: ProviderRuntimeInspect,
  providersReadModel?: UiReadModel<UiProvidersSnapshot>,
  domainInputs?: () => ProviderHealthDomainInputs,
): ConfigModalSurface {
  return new ProviderHealthModalSurface(providerRuntime, providersReadModel, domainInputs);
}
