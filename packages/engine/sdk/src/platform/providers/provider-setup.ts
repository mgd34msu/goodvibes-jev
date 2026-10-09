/**
 * Provider setup presentation, hoisted from the TUI. Unlike catalog access,
 * this result is never consulted by routing, readiness, pricing or payment.
 * Unknown is a complete display result, not permission to guess or act.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import type { ProviderRuntimeMetadata } from './interface.js';
import { providerSetupReading } from './setup-reading.js';

export type ProviderSetupClass = 'api-key' | 'cloud-account' | 'local' | 'no-key-free' | 'self-hosted' | 'subscription' | 'unknown';
export interface ProviderSetupClassification {
  readonly setupClass: ProviderSetupClass;
  readonly setupLabel: string;
  readonly setupDetail: string;
}
export interface ProviderSetupFacts {
  readonly providerId: string;
  readonly runtime?: ProviderRuntimeMetadata | undefined;
}
export interface ProviderSetupReadOptions {
  readonly signal?: AbortSignal | undefined;
  /** Bounds display latency, never the meaning of the facts. */
  readonly timeoutMs?: number | undefined;
  readonly site?: string | undefined;
}

export function describeProviderSetup(setupClass: ProviderSetupClass): ProviderSetupClassification {
  const descriptions: Record<ProviderSetupClass, readonly [string, string]> = {
    'api-key': ['API key', 'Requires a provider API key or equivalent secret.'],
    'cloud-account': ['Cloud account', 'Requires cloud account credentials or workload identity.'],
    local: ['Local/no-key', 'Runs models locally without a paid provider API key.'],
    'no-key-free': ['No-key/free', 'Declared free hosted access without a paid API key or account.'],
    'self-hosted': ['Self-hosted', 'Uses an operator-managed local or self-hosted gateway; upstream billing is separate.'],
    subscription: ['Subscription', 'Uses a stored subscription/OAuth session instead of a raw API key.'],
    unknown: ['Unknown', 'Setup path is not established by the available runtime facts.'],
  };
  const [setupLabel, setupDetail] = descriptions[setupClass];
  return Object.freeze({ setupClass, setupLabel, setupDetail });
}
const unknownSetup = describeProviderSetup('unknown');
const classes = {
  api_key: 'api-key', cloud_account: 'cloud-account', local_runtime: 'local',
  no_key_free: 'no-key-free', self_hosted: 'self-hosted', subscription: 'subscription',
} as const;
export function providerSetupFrom(readings: Readonly<Record<keyof typeof classes, YesNoReading>>): ProviderSetupClass {
  const keys = Object.keys(classes) as (keyof typeof classes)[];
  if (keys.some((key) => readings[key].outcome !== 'act' || readings[key].verdict === 'uncertain')) return 'unknown';
  const supported = keys.filter((key) => readings[key].verdict === 'yes');
  return supported.length === 1 ? classes[supported[0]!] : 'unknown';
}

/** Captures all setup evidence immutably; never sends credentials or endpoint paths/query/userinfo. */
export function providerSetupState(facts: ProviderSetupFacts): string {
  const runtime = facts.runtime;
  return JSON.stringify({ provider: {
    id: facts.providerId,
    setup: runtime?.setup ? {
      description: runtime.setup.description ?? null,
      endpointOrigin: safeEndpointOrigin(runtime.setup.endpointOrigin),
    } : null,
    auth: runtime?.auth ? {
      mode: runtime.auth.mode,
      configured: runtime.auth.configured,
      detail: runtime.auth.detail ?? null,
      envVars: [...(runtime.auth.envVars ?? [])],
      routes: runtime.auth.routes?.map((route) => ({
        route: route.route, label: route.label, configured: route.configured,
        usable: route.usable ?? null, freshness: route.freshness ?? null,
        detail: route.detail ?? null,
      })) ?? null,
    } : null,
    local: runtime?.policy?.local ?? null,
    policyNotes: runtime?.policy?.notes ? [...runtime.policy.notes] : null,
    usageCost: runtime?.usage?.cost ? {
      source: runtime.usage.cost.source, currency: runtime.usage.cost.currency ?? null,
      inputPerMillionTokens: runtime.usage.cost.inputPerMillionTokens ?? null,
      outputPerMillionTokens: runtime.usage.cost.outputPerMillionTokens ?? null,
      detail: runtime.usage.cost.detail ?? null,
    } : null,
    usageNotes: runtime?.usage?.notes ? [...runtime.usage.notes] : null,
    notes: runtime?.notes ? [...runtime.notes] : null,
  } });
}

/** Endpoint shape is transport syntax, not a hosting/billing classification. */
export function safeEndpointOrigin(endpoint: string | undefined): string | null {
  if (endpoint === undefined) return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

/** Runtime-scoped cache. Only a settled single-class reading can be reused. */
export class ProviderSetupReadings {
  readonly #cache = new Map<string, { fingerprint: string; value: ProviderSetupClassification }>();
  readonly #current = new Map<string, symbol>();

  /** Invalidate after replacing a runtime/config/auth generation, even if its display facts repeat. */
  invalidate(): void { this.#cache.clear(); this.#current.clear(); }

  async read(facts: ProviderSetupFacts, options: ProviderSetupReadOptions = {}): Promise<ProviderSetupClassification> {
    if (options.signal?.aborted) return unknownSetup;
    if (facts.runtime === undefined) { this.#cache.delete(facts.providerId); this.#current.delete(facts.providerId); return unknownSetup; }
    const state = providerSetupState(facts);
    const fingerprint = `v${providerSetupReading.version}:${state}`;
    const cached = this.#cache.get(facts.providerId);
    if (cached?.fingerprint === fingerprint) return cached.value;
    this.#cache.delete(facts.providerId);
    const token = Symbol();
    this.#current.set(facts.providerId, token);
    const controller = new AbortController();
    const site = options.site ?? 'providers.setup-presentation';
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: ProviderSetupClassification): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        controller.abort();
        resolve(value);
      };
      const cancel = (): void => finish(unknownSetup);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) { cancel(); return; }
      const timeoutMs = options.timeoutMs ?? 1500;
      timer = setTimeout(cancel, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500);
      timer.unref?.();
      // Promise boundary also contains a missing/unavailable judgment port.
      void Promise.resolve().then(() => providerSetupReading.run(judgmentPort(site), state, { site, signal: controller.signal })).then((run) => {
        if (settled || options.signal?.aborted || this.#current.get(facts.providerId) !== token) { finish(unknownSetup); return; }
        const setupClass = providerSetupFrom(run.readings);
        run.recordAction(`presentation:${setupClass}`);
        const value = describeProviderSetup(setupClass);
        if (setupClass !== 'unknown') this.#cache.set(facts.providerId, { fingerprint, value });
        finish(value);
      }, cancel).catch(cancel);
    });
  }
}

/** One-shot reading. Repeated runtime consumers should own ProviderSetupReadings. */
export function classifyProviderSetup(facts: ProviderSetupFacts, options?: ProviderSetupReadOptions): Promise<ProviderSetupClassification> {
  return new ProviderSetupReadings().read(facts, options);
}
