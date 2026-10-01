/**
 * FeatureUnitCard, one platform capability rendered as ONE unit inside its
 * domain group: its real name, its full description (never truncated, wrap or
 * scroll, never clip), its enablement control in its REAL shape, and the typed
 * editors for the settings keys it owns. Everything writes through the same
 * config.set path as every other field, features live on first-class domain
 * settings keys (SDK 1.7.1's dissolved feature model), not on a separate
 * enablement namespace.
 *
 * Enablement shapes (feature.enablement.kind):
 *   - boolean : a feature-level toggle writing `true`/`false` to the domain key.
 *   - enum    : a mode select over the key's full schema enum (so inactive
 *               modes such as "off" are real choices); the feature is active
 *               while the value is one of enablement.enabledValues.
 *   - constant: the capability has no separate off switch, its own settings
 *               keys govern runtime activation directly, so no feature-level
 *               control renders and the keys appear as ordinary typed fields.
 *
 * Honest states:
 *   - a runtime-toggleable feature notes that changes apply immediately (the
 *     daemon's live settings bridge derives the internal gate state from the
 *     domain key on every config change).
 *   - a restart-gated feature (`restartRequired`) states that up front, and
 *     after a successful enablement change shows a pending-restart marker at
 *     the point of change: the write persisted, the running daemon applies it
 *     on its next restart. The marker is driven by THIS session's confirmed
 *     writes (config.set resolved), never fabricated from a wire signal the
 *     daemon does not expose, config.get returns the persisted tree only.
 *   - the current state distinguishes an explicit config value from the schema
 *     default.
 */
import { useState } from 'react';
import type { FeatureUnitModel } from '../../lib/settings-model';
import type { ConfigSetOutcome } from '../../lib/goodvibes';
import { SettingsField } from './SettingsField';
import { Chip } from '../ui/Chip';
import { Select } from '../ui/Select';
import { StatusDot } from '../ui/StatusDot';
import { Toggle } from '../ui/Toggle';

interface FeatureUnitCardProps {
  readonly unit: FeatureUnitModel;
  readonly onCommit: (key: string, value: unknown) => Promise<void>;
  /** What the daemon reported for the last successful config.set of each key this session
   *  (SettingsModal's persistedByKey), keyed by config key, looked up here per field and
   *  for the enablement key itself. */
  readonly persistedByKey: Readonly<Record<string, ConfigSetOutcome>>;
  /** True when an enablement change was saved this session and awaits a daemon restart. */
  readonly pendingRestart: boolean;
  /** Called after a successful enablement write (toggle or mode change). */
  readonly onEnablementCommitted: () => void;
  /** The live `payments.currency` value, forwarded to any owned field marked
   *  `unit: 'money'`, see SettingsField's `currency` prop. */
  readonly currency?: string;
}

export function FeatureUnitCard({
  unit,
  onCommit,
  persistedByKey,
  pendingRestart,
  onEnablementCommitted,
  currency,
}: FeatureUnitCardProps) {
  const { feature, enabled, explicit, enablementField, fields, daemonOwned } = unit;
  const enablementPersisted = persistedByKey[feature.enablement.key];
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const kind = feature.enablement.kind;

  async function commitEnablement(value: unknown): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onCommit(feature.enablement.key, value);
      onEnablementCommitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const enablementControl = (() => {
    if (kind === 'boolean') {
      return (
        <Toggle
          className="settings-field-toggle feature-unit-toggle"
          checked={enabled}
          disabled={saving}
          aria-label={`Enable ${feature.name}`}
          onChange={(next) => void commitEnablement(next)}
        />
      );
    }
    if (kind === 'enum' && enablementField?.enumValues) {
      const current = enablementField.present ? enablementField.liveValue : enablementField.default;
      const value = typeof current === 'string' ? current : '';
      return (
        <div className="feature-unit-mode">
          <span className="feature-unit-mode-label" aria-hidden="true">Mode</span>
          <Select
            className="settings-field-select"
            aria-label={`${feature.name} mode`}
            value={value}
            disabled={saving}
            placement="bottom-end"
            options={[
              ...(enablementField.enumValues.includes(value) ? [] : [{ value, label: value || '(unset)' }]),
              ...enablementField.enumValues.map((opt) => ({ value: opt, label: opt })),
            ]}
            onChange={(next) => void commitEnablement(next)}
          />
        </div>
      );
    }
    // constant, no separate off switch; the fields below govern activation.
    return null;
  })();

  return (
    <section className="feature-unit" data-feature-id={feature.id} data-feature-enabled={enabled}>
      <header className="feature-unit-head">
        <div className="feature-unit-title">
          <h3>
            {feature.name}
            {daemonOwned && (
              <Chip
                size="sm"
                className="feature-unit-daemon-badge"
                title="Daemon-owned: these settings are stored in the daemon's own config and apply to every connected client, not just this browser."
              >
                Daemon-owned
              </Chip>
            )}
          </h3>
          {kind === 'constant' ? (
            <span className="feature-unit-state">Governed by its settings below</span>
          ) : (
            <span className={enabled ? 'feature-unit-state feature-unit-state--enabled' : 'feature-unit-state'}>
              <StatusDot tone={enabled ? 'ok' : 'idle'} />
              {enabled ? 'Enabled' : 'Disabled'}
              {explicit ? '' : ' (default)'}
            </span>
          )}
        </div>
        {enablementControl}
      </header>
      <p className="feature-unit-desc">{feature.description}</p>
      {kind !== 'constant' &&
        (feature.restartRequired ? (
          <p className="feature-unit-note">Enablement changes apply after a daemon restart.</p>
        ) : (
          <p className="feature-unit-note">Changes to this feature apply immediately.</p>
        ))}
      {pendingRestart && (
        <p className="feature-unit-pending" role="status" data-pending-restart={feature.id}>
          Saved: takes effect when the daemon restarts.
        </p>
      )}
      {kind === 'enum' && enablementField?.description && (
        <p className="feature-unit-mode-desc">{enablementField.description}</p>
      )}
      {enablementPersisted?.persistedTo && (
        <p className="feature-unit-persisted" role="status">
          Saved: stored in {enablementPersisted.persistedTo}.
        </p>
      )}
      {error && (
        <div className="banner warning" role="alert">
          {error}
        </div>
      )}
      {fields.length > 0 && (
        <div className="feature-unit-fields">
          {fields.map((field) => (
            <SettingsField
              key={field.key}
              field={field}
              onCommit={onCommit}
              persisted={persistedByKey[field.key]}
              currency={currency}
            />
          ))}
        </div>
      )}
    </section>
  );
}
