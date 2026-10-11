/**
 * The schema-driven config surface, lifted out of the old SettingsModal so the
 * settings dialog can render each config namespace inside the section it
 * belongs to (sections.ts). The mechanism is unchanged:
 *
 * Rows are driven by the SDK's CONFIG_SCHEMA (types / enums / defaults /
 * descriptions / validation hints), merged with the daemon's live config.get()
 * values, so each key gets a TYPED editor: booleans toggle, enums select,
 * numbers validate, strings text, secrets stay masked/write-only
 * (config-redaction.ts). Every platform capability renders as ONE unit in its
 * DOMAIN group, its enablement control in its real shape (boolean toggle /
 * enum mode select / constant, per SDK FEATURE_SETTINGS) together with the
 * settings keys it owns (settings-model.ts). Owned keys never double-list as
 * orphan rows in their namespace.
 *
 * Restart honesty: a restart-gated feature whose enablement was changed here
 * shows a pending-restart marker, tracked per feature id from THIS dialog
 * session's confirmed config.set writes. The state lives in the provider, so
 * switching sections never drops a marker.
 *
 * Honesty bars:
 *   - an admin-scope refusal (403) on config.get reads distinctly from a generic
 *     fetch failure;
 *   - a secret-shaped key never renders its stored value;
 *   - undeclared keys remain excluded until current canonical metadata readings
 *     establish they are not card material; unresolved secrets remain masked.
 *
 * Writes go through config.set one key at a time (the daemon's real /config
 * contract); the raw key/value form remains, demoted to an explicit escape hatch
 * for unschema'd keys (RawConfigEditor, in "All settings").
 */
import { createContext, useCallback, useContext, useMemo, useState, useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { isDeclaredCardMaterialKey } from '../../../lib/card-material';
import { readConfigKey, type ConfigKeyResult } from '../../../lib/config-key-judgment';
import { subscribeClientLifetime } from '../../../lib/client-lifetime';
import { sdk, type ConfigSetOutcome } from '../../../lib/goodvibes';
import { formatError, serializeError } from '../../../lib/errors';
import { asRecord } from '../../../lib/object';
import { useToast } from '../../../lib/toast';
import { ErrorState } from '../../feedback/ErrorState';
import { SkeletonBlock } from '../../feedback/SkeletonBlock';
import { SettingsField } from '../SettingsField';
import { SettingsHeadingLevel } from './parts';
import { FeatureUnitCard } from '../FeatureUnitCard';
import { PaymentCardEntry } from '../PaymentCardEntry';
import { displayConfigValue, isUndeclaredConfigKey, isUnresolvedConfigKey, SECRET_CONFIG_KEYS } from '../../../lib/config-redaction';
import {
  buildSettingsModel,
  liveLeafKeys,
  OBJECT_TYPED_CONFIG_KEYS,
  filterSettingsModel,
  readConfigPath,
  type SettingsGroupModel,
} from '../../../lib/settings-model';
import { isSecretStoreOnlyConfigKey, secretStoreSetCommandFor } from '../../../lib/secret-store-only-config-keys';
import { Button } from '../../ui/Button';
import { Input, Textarea, Field } from '../../ui/Field';

/** The daemon's real 403 admin-scope refusal on config.get carries no machine `code`, status only. */
export function isAdminRequiredError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = typeof serialized.status === 'number' ? serialized.status : typeof transport.status === 'number' ? transport.status : undefined;
  return status === 403;
}

interface ConfigSettingsValue {
  config: UseQueryResult;
  groups: SettingsGroupModel[];
  currency: string;
  refused: boolean;
  degraded: boolean;
  commit: (key: string, value: unknown) => Promise<void>;
  persistedByKey: Readonly<Record<string, ConfigSetOutcome>>;
  pendingRestartIds: ReadonlySet<string>;
  markPendingRestart: (featureId: string) => void;
}

const ConfigSettingsContext = createContext<ConfigSettingsValue | null>(null);

export function ConfigSettingsProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingRestartIds, setPendingRestartIds] = useState<ReadonlySet<string>>(new Set());
  // What the daemon reported back for the last successful config.set of each key
  // (persistedTo / tier / daemonOwned), never fabricated from config.get, which
  // returns the persisted tree only. Cleared whenever the dialog remounts.
  const [persistedByKey, setPersistedByKey] = useState<Readonly<Record<string, ConfigSetOutcome>>>({});

  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => sdk.operator.config.get(),
    enabled,
    retry: false,
  });

  const baseGroups = useMemo(() => buildSettingsModel(config.data), [config.data]);
  const unresolvedNames = liveLeafKeys(config.data, "", new Set([...OBJECT_TYPED_CONFIG_KEYS, ...SECRET_CONFIG_KEYS]))
    .filter((key) => isUndeclaredConfigKey(key) && !isDeclaredCardMaterialKey(key));
  const nameSignature = JSON.stringify(unresolvedNames);
  const [classification, setClassification] = useState<{
    data: unknown;
    updatedAt: number;
    nameSignature: string;
    result: ConfigKeyResult;
    cardResult: ConfigKeyResult;
  }>();
  const [identityRevision, setIdentityRevision] = useState(0);
  useEffect(
    () =>
      subscribeClientLifetime(() => {
        setClassification(undefined);
        setIdentityRevision((value) => value + 1);
      }),
    []
  );
  useEffect(() => {
    const names = JSON.parse(nameSignature) as string[];
    if (!enabled || !config.isSuccess || config.isFetching || !names.length || names.length > 64)
      return;
    const abort = new AbortController();
    void Promise.all([readConfigKey(names, abort.signal), readConfigKey(names, abort.signal, "webui.settings.card-material-key")]).then(([result, cardResult]) => {
      if (!abort.signal.aborted)
        setClassification({
          data: config.data,
          updatedAt: config.dataUpdatedAt,
          nameSignature,
          result,
          cardResult,
        });
    });
    return () => abort.abort();
  }, [
    enabled,
    config.isSuccess,
    config.isFetching,
    config.data,
    config.dataUpdatedAt,
    nameSignature,
    identityRevision,
  ]);
  const current = enabled && config.isSuccess && !config.isFetching
    && classification?.data === config.data && classification.updatedAt === config.dataUpdatedAt
    && classification.nameSignature === nameSignature ? classification : undefined;
  const nonCardKeys = current?.cardResult.status === 'ready' && current.cardResult.isCurrent()
    ? new Set(unresolvedNames.filter((_, index) => current.cardResult.status === 'ready' && current.cardResult.matches.at(index) === false))
    : new Set<string>();
  const clearedKeys = current?.result.status === 'ready' && current.result.isCurrent()
    ? new Set(unresolvedNames.filter((_, index) => current.result.status === 'ready' && current.result.matches.at(index) === false))
    : new Set<string>();
  const groups = nonCardKeys.size ? buildSettingsModel(config.data, clearedKeys, nonCardKeys) : baseGroups;
  // payments.currency's live value, for MoneyField's currency label, read from
  // the live config since it may sit in a different group than the money field.
  const currency = useMemo(() => {
    const { present, value } = readConfigPath(config.data, 'payments.currency');
    return present && typeof value === 'string' && value ? value : 'USD';
  }, [config.data]);

  const refused = config.isError && isAdminRequiredError(config.error);
  const degraded = config.isError && !refused;

  /**
   * Single write path: config.set one key, reconcile via refetch, surface errors.
   * config.set REJECTS on a non-2xx or network failure; the catch re-throws so the
   * calling row keeps its edit state and shows the failure inline, on top of the
   * toast here. config.get is NOT invalidated on failure, so the row keeps showing
   * the value the daemon actually holds.
   */
  const commit = useCallback(
    async (key: string, value: unknown): Promise<void> => {
      try {
        const outcome = await sdk.operator.config.set(key, value);
        setPersistedByKey((prev) => ({ ...prev, [key]: outcome }));
        await queryClient.invalidateQueries({ queryKey: ['config'] });
        toast({
          title: 'Config saved',
          description: outcome.persistedTo ? `${key} updated: stored in ${outcome.persistedTo}.` : `${key} updated.`,
          tone: 'success',
        });
      } catch (error) {
        toast({ title: 'Failed to save config', description: formatError(error), tone: 'danger' });
        throw error;
      }
    },
    [queryClient, toast],
  );

  const markPendingRestart = useCallback((featureId: string) => {
    setPendingRestartIds((prev) => new Set(prev).add(featureId));
  }, []);

  const value = useMemo<ConfigSettingsValue>(() => ({
    config,
    groups,
    currency,
    refused,
    degraded,
    commit,
    persistedByKey,
    pendingRestartIds,
    markPendingRestart,
  }), [config, groups, currency, refused, degraded, commit, persistedByKey, pendingRestartIds, markPendingRestart]);

  return <ConfigSettingsContext.Provider value={value}>{children}</ConfigSettingsContext.Provider>;
}

export function useConfigSettings(): ConfigSettingsValue {
  const ctx = useContext(ConfigSettingsContext);
  if (!ctx) throw new Error('useConfigSettings must be used inside ConfigSettingsProvider');
  return ctx;
}

/** The config groups, or the honest loading / refused / degraded state in their place. */
export function ConfigGroupList({
  groups,
  query = '',
  emptyText,
}: {
  /** The groups to render (already narrowed to a section). */
  groups: readonly SettingsGroupModel[];
  /** Narrow to settings matching this search text. */
  query?: string;
  /** Shown when there is nothing to render (after the search). */
  emptyText?: string;
}) {
  const { config, refused, degraded, commit, persistedByKey, pendingRestartIds, markPendingRestart, currency } = useConfigSettings();
  const shown = useMemo(() => filterSettingsModel([...groups], query), [groups, query]);
  // One level under the section heading when the list sits inside a titled section.
  const GroupHeading = useContext(SettingsHeadingLevel) === 4 ? 'h4' : 'h3';

  if (config.isPending) {
    return (
      <div className="settings-skeleton" aria-label="Loading settings" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonBlock key={i} variant="block" height={32} />
        ))}
      </div>
    );
  }
  if (refused) {
    return (
      <div className="settings-degraded" role="status">
        <strong>Admin access required</strong>
        <span>Sign in with an admin-scoped token to view and edit config.</span>
      </div>
    );
  }
  if (degraded) {
    return <ErrorState error={config.error} title="Config unavailable" onRetry={() => void config.refetch()} />;
  }
  if (shown.length === 0) {
    return emptyText ? <p className="settings-empty">{emptyText}</p> : null;
  }

  return (
    <div className="settings-entries">
      {shown.map((group) => (
        <section
          key={group.id}
          className="settings-config-group"
          data-config-group={group.id}
          aria-labelledby={`settings-config-group-${group.id}`}
        >
          <GroupHeading id={`settings-config-group-${group.id}`} className="settings-config-group__title">{group.label}</GroupHeading>
          {/*
            Card entry sits at the top of the Payments group, above the budgets
            and windows that govern how it gets used. It is not a schema-driven
            row and cannot be: card material is deliberately absent from
            CONFIG_SCHEMA (it lives in the daemon secret store). The panel gates
            itself on the SDK's entry-surface allowlist.
          */}
          {group.id === 'payments' && <PaymentCardEntry currency={currency} />}
          {group.featureUnits.map((unit) => (
            <FeatureUnitCard
              key={unit.feature.id}
              unit={unit}
              onCommit={commit}
              persistedByKey={persistedByKey}
              pendingRestart={pendingRestartIds.has(unit.feature.id)}
              currency={currency}
              onEnablementCommitted={() => {
                if (unit.feature.restartRequired) markPendingRestart(unit.feature.id);
              }}
            />
          ))}
          {group.plainRows.length > 0 && (
            <div className="settings-plain-rows">
              {group.plainRows.map((field) => (
                <SettingsField
                  key={field.key}
                  field={field}
                  onCommit={commit}
                  persisted={persistedByKey[field.key]}
                  currency={currency}
                />
              ))}
            </div>
          )}
          {group.rawRows.length > 0 && (
            <div className="settings-raw-rows">
              <p className="settings-raw-note">
                Held by the daemon but not in the config schema; shown read-only. Edit them with the raw editor
                at the end of All settings.
              </p>
              <dl className="settings-readable">
                {group.rawRows.map((row) => (
                  <div key={row.key} className="settings-readable__row">
                    <dt className="settings-readable__key">
                      {row.key}
                      {row.isSecret && <span className="settings-secret-flag"> {isUnresolvedConfigKey(row.key) ? '(masked)' : '(secret)'}</span>}
                      {row.daemonOwned && (
                        <span
                          className="settings-daemon-flag"
                          title="Daemon-owned: stored in the daemon's own config and applies to every client."
                        >
                          {' '}
                          (daemon)
                        </span>
                      )}
                    </dt>
                    <dd className={row.isSecret ? 'settings-value settings-value--secret' : 'settings-value'}>
                      {displayConfigValue(row.key, row.value, row.displayCleared)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Escape hatch for keys the config schema does not define. */
export function RawConfigEditor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rawKey, setRawKey] = useState('');
  const [rawValue, setRawValue] = useState('');
  const [rawError, setRawError] = useState('');

  const saveRaw = useMutation({
    mutationFn: () => {
      const key = rawKey.trim();
      if (!key) throw new Error('Config key is required');
      // secret-store-only-config-keys.ts: these keys' real value is resolved
      // exclusively from the daemon's secret store; a config.set write here
      // would leave a plaintext, never-read copy in the daemon's config file
      // and configure nothing. Refuse and name the real command instead.
      if (isSecretStoreOnlyConfigKey(key)) {
        throw new Error(
          `${key} is only ever read from the daemon's secret store, never from config, writing it here `
          + `would save a plaintext copy that the mail/calendar connector ignores. Run `
          + `"${secretStoreSetCommandFor(key)}" from a terminal with daemon access instead.`,
        );
      }
      let parsed: unknown = rawValue;
      if (rawValue.trim()) {
        try {
          parsed = JSON.parse(rawValue);
        } catch {
          parsed = rawValue;
        }
      }
      return sdk.operator.config.set(key, parsed);
    },
    onSuccess: async () => {
      const key = rawKey.trim();
      setRawKey('');
      setRawValue('');
      setRawError('');
      await queryClient.invalidateQueries({ queryKey: ['config'] });
      toast({ title: 'Config saved', description: `Key "${key}" updated.`, tone: 'success' });
    },
    onError: (error: unknown) => {
      const message = formatError(error);
      setRawError(message);
      if (message === 'Config key is required') return;
      toast({ title: 'Failed to save config', description: message, tone: 'danger' });
    },
  });

  return (
    <section className="settings-block settings-advanced" aria-labelledby="settings-advanced-title">
      <h3 id="settings-advanced-title" className="settings-block__title">Advanced: unschema'd keys</h3>
      <p className="settings-block__description">
        For keys the config schema does not define. Schema-known keys have typed editors above; prefer those.
      </p>
      <form
        className="settings-advanced__form"
        onSubmit={(event) => {
          event.preventDefault();
          saveRaw.mutate();
        }}
      >
        <Field label="Key">
          <Input value={rawKey} onChange={(event) => setRawKey(event.target.value)} placeholder="settings.path" />
        </Field>
        <Field label="Value">
          <Textarea value={rawValue} onChange={(event) => setRawValue(event.target.value)} placeholder="JSON or text" rows={3} />
        </Field>
        <div className="settings-actions">
          <Button variant="primary" type="submit" disabled={saveRaw.isPending || !rawKey.trim()}>
            Save
          </Button>
        </div>
      </form>
      {rawError && <div className="banner warning" role="alert">{rawError}</div>}
    </section>
  );
}
