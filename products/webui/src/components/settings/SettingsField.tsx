/**
 * SettingsField, one typed config editor row, driven by the SDK schema. Laid
 * out as a settings-dialog row: a readable label, the key in mono and the
 * description on the left, the kit control on the right (stacked beneath on a
 * phone, and for wide editors). No native widgets.
 *
 *   boolean → kit Toggle (commits immediately)
 *   enum    → kit Select of the schema's enumValues (commits immediately)
 *   number  → numeric input, committed on blur/Enter, client-parsed to a finite
 *             number; the schema validationHint is shown as the accepted range
 *   string  → text input, committed on blur/Enter
 *   secret  → masked display + explicit "Replace" that reveals a WRITE-ONLY
 *             field (the stored value is never round-tripped back into an input)
 *   object  → a REAL structured editor, never a JSON blob: pricing.modelPrices
 *             gets the per-model price-row editor (ModelPricesEditor); any
 *             future object-typed key falls back to a validating JSON form
 *             that at least round-trips honestly until it gets its own editor
 *
 * A few keys get a specialized editor ahead of the generic type dispatch:
 *   daemon.timezone        → TimezonePicker, a searchable IANA-zone select
 *                             (never free text) with an explicit "UTC (unset)"
 *                             option that writes ''.
 *   payments.cvvHandling   → CvvHandlingField, an enum select that surfaces
 *                             CVV_PROMPT_TRADEOFF_WARNING the moment 'prompt'
 *                             is selected.
 *   payments.budget.*      → MoneyField for any schema key marked
 *                             `unit: 'money'` (SDK 2.0.5's money-value.ts),
 *                             the plain amount is displayed and entered as-is,
 *                             with no unit conversion; detection reads the
 *                             schema's `unit` mark, never the key's name.
 *
 * Card material (a card number, expiry, or CVV) never reaches this component:
 * CONFIG_SCHEMA never declares such a key (schema-domain-payments.ts's own
 * header), and settings-model.ts drops any matching key it finds in the live
 * config too (lib/card-material.ts) before it ever becomes a field or row.
 *
 * Commits call onCommit(key, value); it resolves on success (the parent
 * reconciles via a config refetch) and rejects on daemon rejection, which this
 * row surfaces inline (plus the parent's toast). Nothing is faked: an unset key
 * shows its schema default distinctly, and a rejected write keeps the row's edit
 * state so the user can correct it.
 */
import { useState } from 'react';
import { maskSecretValue } from '../../lib/config-redaction';
import { settingLabelForKey } from '../../lib/setting-label';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Input, Textarea } from '../ui/Field';
import { Select } from '../ui/Select';
import { Toggle } from '../ui/Toggle';
import { isMoneyField } from '../../lib/money';
import type { ConfigFieldModel } from '../../lib/settings-model';
import type { ConfigSetOutcome } from '../../lib/goodvibes';
import { secretStoreSetCommandFor } from '../../lib/secret-store-only-config-keys';
import { ModelPricesEditor } from './ModelPricesEditor';
import { TimezonePicker } from './TimezonePicker';
import { MoneyField } from './MoneyField';
import { CvvHandlingField } from './CvvHandlingField';

interface SettingsFieldProps {
  readonly field: ConfigFieldModel;
  readonly onCommit: (key: string, value: unknown) => Promise<void>;
  /** What the daemon reported for the last successful config.set of THIS key this
   *  session (SettingsModal's persistedByKey, looked up by the caller), undefined
   *  until this row has been saved at least once. */
  readonly persisted?: ConfigSetOutcome;
  /** The live `payments.currency` value, used only by `unit: 'money'` fields
   *  to label the amount input; defaults to the schema's own default ('USD')
   *  when the caller does not pass one. */
  readonly currency?: string;
}

function effectiveValue(field: ConfigFieldModel): unknown {
  return field.present ? field.liveValue : field.default;
}

/** Render a scalar config value into an input's text form, without stringifying objects blindly. */
function scalarToText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  return JSON.stringify(v);
}

export function SettingsField({ field, onCommit, persisted, currency }: SettingsFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Local draft for text/number/secret; boolean & enum commit without a draft.
  const initialText = scalarToText(effectiveValue(field));
  const [draft, setDraft] = useState(initialText);
  const [revealing, setRevealing] = useState(false);

  async function commit(value: unknown): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onCommit(field.key, value);
      setRevealing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const defaultNote = !field.present ? (
    <span className="settings-field-default" title="Not set in the daemon config, showing the built-in default.">
      default
    </span>
  ) : null;

  const control = (() => {
    // Object-typed keys get structured editors (see module header).
    if (field.type === 'object') {
      if (field.key === 'pricing.modelPrices') {
        // The editor owns its saving/error state, commits go straight to the
        // parent's config.set so a rejection surfaces inside the editor row.
        return <ModelPricesEditor value={effectiveValue(field)} onCommit={(next) => onCommit(field.key, next)} />;
      }
      return <ObjectJsonField field={field} saving={saving} onCommit={(value) => void commit(value)} />;
    }

    // Secret string whose real value the daemon resolves ONLY from its own
    // secret store (secret-store-only-config-keys.ts), never editable here.
    // A config.set write would save a plaintext copy the mail/calendar
    // connector never reads, while reporting success. Refuse and name the
    // real command instead of offering a write that cannot work.
    //
    // FIRST among the special cases on purpose: this branch is a refusal, and
    // a refusal has to be reached before anything below can offer an editor
    // for the same key. None of the three payments/timezone editors that
    // follow currently matches a secret-store-only key, so the order is not
    // load-bearing today, it is what keeps it from becoming load-bearing.
    if (field.isSecret && field.type === 'string' && field.secretStoreOnly) {
      const raw = effectiveValue(field);
      const masked = typeof raw === 'string' && raw ? maskSecretValue(raw) : '(unset)';
      return (
        <div className="settings-field-secret settings-field-secret--store-only">
          <span className="settings-value settings-value--secret">{masked}</span>
          <p className="settings-field-secret-store-only-note" role="note">
            Only readable from the daemon's own secret store. A value saved here would never be
            used. Run <code>{secretStoreSetCommandFor(field.key)}</code> from a terminal with daemon
            access to set it.
          </p>
        </div>
      );
    }

    // daemon.timezone, a searchable IANA-zone picker, never free text.
    if (field.key === 'daemon.timezone') {
      const current = effectiveValue(field);
      const value = typeof current === 'string' ? current : '';
      return <TimezonePicker value={value} disabled={saving} onCommit={(next) => void commit(next)} />;
    }

    // payments.cvvHandling, an enum select that surfaces the trade-off
    // warning at the moment 'prompt' is selected.
    if (field.type === 'enum' && field.key === 'payments.cvvHandling' && field.enumValues) {
      const current = effectiveValue(field);
      const value = typeof current === 'string' ? current : '';
      return (
        <CvvHandlingField
          value={value}
          enumValues={field.enumValues}
          disabled={saving}
          onCommit={(next) => void commit(next)}
        />
      );
    }

    // A schema key marked unit: 'money', a plain amount, displayed and
    // entered as-is with no unit conversion.
    if (field.type === 'number' && isMoneyField(field.unit)) {
      const current = effectiveValue(field);
      const value = typeof current === 'number' ? current : 0;
      return (
        <MoneyField
          value={value}
          currency={currency ?? 'USD'}
          disabled={saving}
          onCommit={(amount) => void commit(amount)}
        />
      );
    }

    // Secret string, masked, write-only replace.
    if (field.isSecret && field.type === 'string') {
      const raw = effectiveValue(field);
      const masked = typeof raw === 'string' && raw ? maskSecretValue(raw) : '(unset)';
      if (!revealing) {
        return (
          <div className="settings-field-secret">
            <span className="settings-value settings-value--secret">{masked}</span>
            <Button
              size="sm"
              className="settings-field-replace"
              onClick={() => {
                setDraft('');
                setRevealing(true);
              }}
            >
              Replace
            </Button>
          </div>
        );
      }
      return (
        <div className="settings-field-secret">
          <Input
            type="password"
            autoComplete="new-password"
            aria-label={`New value for ${field.key}`}
            value={draft}
            disabled={saving}
            placeholder="Enter new value (write-only)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit(draft);
            }}
          />
          <Button size="sm" disabled={saving} onClick={() => setRevealing(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" className="settings-field-save" disabled={saving} onClick={() => void commit(draft)}>
            Save
          </Button>
        </div>
      );
    }

    if (field.type === 'boolean') {
      const checked = Boolean(effectiveValue(field));
      return (
        <Toggle
          className="settings-field-toggle"
          checked={checked}
          disabled={saving}
          aria-label={field.key}
          onChange={(next) => void commit(next)}
        />
      );
    }

    if (field.type === 'enum' && field.enumValues) {
      const current = effectiveValue(field);
      const value = typeof current === 'string' ? current : scalarToText(current);
      return (
        <Select
          className="settings-field-select"
          aria-label={field.key}
          value={value}
          disabled={saving}
          placement="bottom-end"
          options={[
            ...(field.enumValues.includes(value) ? [] : [{ value, label: value || '(unset)' }]),
            ...field.enumValues.map((opt) => ({ value: opt, label: opt })),
          ]}
          onChange={(next) => void commit(next)}
        />
      );
    }

    if (field.type === 'number') {
      return (
        <Input
          className="settings-field-input"
          type="text"
          inputMode="decimal"
          aria-label={field.key}
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onBlur={() => {
            if (draft === initialText) return;
            const n = Number(draft);
            if (draft.trim() === '' || !Number.isFinite(n)) {
              setError(`Enter a finite number${field.validationHint ? ` (${field.validationHint})` : ''}`);
              return;
            }
            void commit(n);
          }}
        />
      );
    }

    // string (non-secret)
    return (
      <Input
        className="settings-field-input"
        type="text"
        aria-label={field.key}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={() => {
          if (draft === initialText) return;
          void commit(draft);
        }}
      />
    );
  })();

  // Wide editors (structured objects, a revealed secret, the timezone picker,
  // a store-only secret note) sit under the text instead of beside it.
  const stacked = field.type === 'object'
    || field.key === 'daemon.timezone'
    || (field.isSecret && field.type === 'string' && (field.secretStoreOnly || revealing));

  return (
    <div
      className={stacked ? 'settings-field settings-field--stacked' : 'settings-field'}
      data-config-key={field.key}
      data-daemon-owned={field.daemonOwned}
    >
      <div className="settings-field-text">
        <div className="settings-field-label">{settingLabelForKey(field.key)}</div>
        <div className="settings-field-head">
          <code className="settings-field-key">{field.key}</code>
          {field.daemonOwned && (
            <Chip
              size="sm"
              className="settings-field-daemon-badge"
              title="Daemon-owned: stored in the daemon's own config and applies to every connected client, not just this browser."
            >
              Daemon-owned
            </Chip>
          )}
          {defaultNote}
          {field.validationHint && field.type === 'number' && (
            <span className="settings-field-hint">{field.validationHint}</span>
          )}
        </div>
        {field.description && <p className="settings-field-desc">{field.description}</p>}
      </div>
      <div className="settings-field-control">{control}</div>
      {persisted?.persistedTo && (
        <p className="settings-field-persisted" role="status">
          Saved: stored in {persisted.persistedTo}.
        </p>
      )}
      {error && (
        <div className="banner warning settings-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Fallback editor for an object-typed schema key that has no dedicated
 * structured editor yet: shows the current value and accepts a replacement as
 * validated JSON (must parse to a plain object, never silently committed as a
 * string). pricing.modelPrices never reaches this, it has ModelPricesEditor.
 */
function ObjectJsonField({
  field,
  saving,
  onCommit,
}: {
  readonly field: ConfigFieldModel;
  readonly saving: boolean;
  readonly onCommit: (value: unknown) => void;
}) {
  const current = field.present ? field.liveValue : field.default;
  const [draft, setDraft] = useState(() => JSON.stringify(current ?? {}, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <div className="settings-field-object">
      <Textarea
        aria-label={field.key}
        value={draft}
        disabled={saving}
        rows={Math.min(10, draft.split('\n').length + 1)}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={saving}
        onClick={() => {
          try {
            const parsed: unknown = JSON.parse(draft);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setParseError('Value must be a JSON object.');
              return;
            }
            setParseError(null);
            onCommit(parsed);
          } catch {
            setParseError('Not valid JSON.');
          }
        }}
      >
        Save
      </Button>
      {parseError && (
        <div className="banner warning" role="alert">
          {parseError}
        </div>
      )}
    </div>
  );
}
