import { endpointKind, HOSTED_BASE_URL, validEndpointURL } from '@goodvibes-jev/judgment';
import { BrowserJudgmentError } from '@goodvibes-jev/engine/daemon-sdk';
import { CONFIG_SCHEMA, type ConfigManager, type SecretsManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SECRET_BEARING_CONFIG_PATHS } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createWebuiBrowserJudgment, type BrowserJudgmentRoute } from '@goodvibes-jev/engine/sdk/platform/judgment-browser';
import type { JudgmentServices } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

const KEYS = ['judgment.endpoint', 'judgment.keySource', 'judgment.model', 'judgment.timeoutMs'] as const;
const ENV_KEYS = ['TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_API_KEY'] as const;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/**
 * The daemon's configured Jev service owns these fixed WebUI purposes:
 * ranking an operator's palette query against registered commands/host chat
 * titles, interpreting an authenticated canonical daemon failure, and deciding
 * a reply prefix for an authenticated canonical mail-read subject. This is
 * the same settings-owned route and metadata-only decision log used by the
 * engine. Read scopes and browser text never grant an arbitrary destination,
 * prompt, source category, or retention store.
 */
export function composeBrowserJudgment(input: {
  readonly judgment: JudgmentServices;
  readonly providers?: () => Pick<ProviderRegistry, 'captureProviderCatalogIds'>;
  readonly config: ConfigManager;
  readonly secrets: Pick<SecretsManager, 'onDidChange'> & Partial<Pick<SecretsManager, 'list'>>;
  readonly methods: GatewayMethodCatalog;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly disposal: { add(label: string, dispose: () => void | Promise<void>): void };
}) {
  let lifetime = new AbortController();
  let credentialLifetime = new AbortController();
  let configLifetime = new AbortController();
  let revision = crypto.randomUUID();
  let closed = false;
  let observed: readonly unknown[] | undefined;
  const revoke = () => {
    lifetime.abort(new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD'));
    lifetime = new AbortController(); revision = crypto.randomUUID();
    observed = undefined;
  };
  const subscriptions = KEYS.map((key) => input.config.subscribe(key, revoke));
  subscriptions.push(input.config.onDidInvalidate(() => { configLifetime.abort(); configLifetime = new AbortController(); }));
  subscriptions.push(input.secrets.onDidChange((key) => {
    credentialLifetime.abort(); credentialLifetime = new AbortController();
    if (key === 'TYPESAFE_API_KEY') revoke();
  }));
  const snapshot = () => {
    const current = [...KEYS.map((key) => input.config.get(key)), ...ENV_KEYS.map((key) => input.env[key])];
    // Environment writes have no subscription. Observe them at both admission
    // and every current-authority check, retiring old work without poisoning
    // the next request's configured generation.
    if (observed && current.some((value, index) => value !== observed![index])) revoke();
    observed = current;
    return current;
  };
  const currentRoute = (): BrowserJudgmentRoute | undefined => {
    if (closed) return undefined;
    // Values stay in this operation-local closure, never in route IDs/logs.
    const configuration = snapshot();
    const endpoint = text(configuration[0]) || text(configuration[KEYS.length]) || HOSTED_BASE_URL;
    if (!validEndpointURL(endpoint)) return undefined;
    const capturedRevision = revision;
    const capturedLifetime = lifetime;
    return {
      revision: capturedRevision, kind: endpointKind(endpoint), port: input.judgment.port, signal: capturedLifetime.signal,
      assertCurrent() {
        snapshot();
        if (closed || capturedLifetime.signal.aborted || revision !== capturedRevision
          || observed!.some((value, index) => value !== configuration[index])) {
          capturedLifetime.abort(new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD'));
          throw new BrowserJudgmentError('JUDGMENT_PERMISSION_HELD');
        }
      },
    };
  };
  const service = createWebuiBrowserJudgment({ methods: input.methods, currentRoute,
    ...(input.providers ? { providerCatalog: {
      capture() {
        const registry = input.providers!();
        const source = registry.captureProviderCatalogIds();
        const config = configLifetime;
        const credentials = credentialLifetime;
        return {
          snapshot: { providerIds: source.providerIds, catalogProviderIds: source.catalogProviderIds },
          signal: AbortSignal.any([config.signal, credentials.signal]),
          assertCurrent() {
            if (closed || input.providers!() !== registry || config !== configLifetime || credentials !== credentialLifetime
              || config.signal.aborted || credentials.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
            source.assertCurrent();
          },
        };
      },
    } } : {}),
    configNames: {
      async list() {
        const names = new Set<string>(CONFIG_SCHEMA.map(entry => entry.key));
        const leafKeys = new Set<string>([...CONFIG_SCHEMA.filter(entry => entry.type === 'object').map(entry => entry.key), ...SECRET_BEARING_CONFIG_PATHS]);
        const walk = (value: unknown, prefix = '') => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          for (const [key, entry] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (entry && typeof entry === 'object' && !Array.isArray(entry) && !leafKeys.has(path)) walk(entry, path);
            else names.add(path);
          }
        };
        walk(input.config.getAll());
        return [...names].map(key => ({ key, description: CONFIG_SCHEMA.find(entry => entry.key === key)?.description ?? '' }));
      },
      lifetime() {
        const captured = configLifetime;
        return { signal: captured.signal, assertCurrent() {
          if (closed || captured !== configLifetime || captured.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
        } };
      },
    },
    ...(input.secrets.list ? { credentialNames: {
      list: () => input.secrets.list!(),
      lifetime: () => {
        const captured = credentialLifetime;
        return { signal: captured.signal, assertCurrent() {
          if (closed || captured !== credentialLifetime || captured.signal.aborted) throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD');
        } };
      },
    } } : {}),
    authorize({ battery, sources, route }) {
      if (closed || route.revision !== revision || !sources.length) return false;
      // Explicit source/purpose allowlist. Reference ownership is independently
      // proved by the source owner before this product policy is consulted.
      return battery === 'webui.palette.command-rank'
        ? sources.every((source) => source === 'palette-query' || source === 'chat-title') && sources.includes('palette-query')
        : battery === 'webui.errors.daemon-refusal'
          ? sources.length === 1 && sources[0] === 'daemon-error'
          : battery === 'webui.models.catalog-provider-match'
            ? sources.length === 1 && sources[0] === 'provider-catalog-ids'
          : (battery === 'webui.config.credential-key' || battery === 'webui.settings.card-material-key')
            ? sources.length === 1 && sources[0] === 'config-key-names'
            : battery === 'webui.voice.speech-seams'
            ? sources.length === 1 && sources[0] === 'chat-speech'
            : battery === 'webui.code.language'
            ? sources.length === 1 && sources[0] === 'chat-code'
            : battery === 'webui.credentials.provider-key'
            ? sources.length === 1 && sources[0] === 'credential-names'
            : battery === 'webui.pwa.install-platform'
            ? sources.length === 1 && sources[0] === 'browser-platform'
            : battery === 'webui.mail.reply-subject' && sources.length === 1 && sources[0] === 'mail-subject';
    },
  });
  input.disposal.add('browser judgment transport', async () => {
    closed = true;
    for (const unsubscribe of subscriptions) unsubscribe();
    lifetime.abort(new BrowserJudgmentError('JUDGMENT_SHUTTING_DOWN'));
    credentialLifetime.abort();
    configLifetime.abort();
    await service.close();
  });
  return service;
}
