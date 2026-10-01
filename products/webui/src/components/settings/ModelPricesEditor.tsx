/**
 * ModelPricesEditor, the real editor for the object-typed
 * `pricing.modelPrices` config key: one row per "provider:model" entry with
 * input / output / cache-read / cache-write USD-per-1M-token fields, plus
 * add, edit, and remove. Every change writes the WHOLE table through the
 * caller's commit (config.set pricing.modelPrices), the daemon's real
 * one-key write contract; there is no JSON blob involved.
 *
 * Shared by the settings surface (SettingsField's object branch) and the
 * "set a price" affordance on cost displays, so a manual price entered from
 * either place is the same write.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import {
  draftFromEntry,
  EMPTY_MODEL_PRICE_DRAFT,
  modelPriceRows,
  modelPriceSummary,
  parseModelPriceDraft,
  readModelPriceTable,
  removeModelPrice,
  upsertModelPrice,
  type ModelPriceDraft,
} from '../../lib/model-prices';
import '../../styles/components/pricing.css';

export interface ModelPricesEditorProps {
  /** The live `pricing.modelPrices` value (raw, from config.get). */
  readonly value: unknown;
  /** Commit the full replacement table; resolves on daemon ack. */
  readonly onCommit: (next: Record<string, unknown>) => Promise<void>;
  /** Pre-fill the add form with this model key (from a cost display's "set price"). */
  readonly initialModelKey?: string;
}

export function ModelPricesEditor({ value, onCommit, initialModelKey }: ModelPricesEditorProps) {
  const table = readModelPriceTable(value);
  const rows = modelPriceRows(table);
  const [draft, setDraft] = useState<ModelPriceDraft>(() =>
    initialModelKey && !(initialModelKey in table)
      ? { ...EMPTY_MODEL_PRICE_DRAFT, modelKey: initialModelKey }
      : EMPTY_MODEL_PRICE_DRAFT,
  );
  // Which existing row the form is editing (null = adding a new entry).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState<boolean>(() => Boolean(initialModelKey) || rows.length === 0);

  async function commitTable(next: Record<string, unknown>): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await onCommit(next);
      setDraft(EMPTY_MODEL_PRICE_DRAFT);
      setEditingKey(null);
      setFormOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function submitDraft(): void {
    const parsed = parseModelPriceDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    let next = table;
    // Renaming an entry under edit removes the old key.
    if (editingKey !== null && editingKey !== parsed.modelKey) {
      next = removeModelPrice(next, editingKey);
    }
    next = upsertModelPrice(next, parsed.modelKey, parsed.entry);
    void commitTable({ ...next });
  }

  function beginEdit(modelKey: string): void {
    setDraft(draftFromEntry(modelKey, table[modelKey]));
    setEditingKey(modelKey);
    setFormOpen(true);
    setError(null);
  }

  function priceInput(label: string, field: keyof ModelPriceDraft, required: boolean) {
    return (
      <Field label={required ? label : `${label} (optional)`}>
        <Input
          type="text"
          inputMode="decimal"
          aria-label={`${label} price (USD per 1M tokens)`}
          value={draft[field]}
          disabled={saving}
          onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
        />
      </Field>
    );
  }

  return (
    <div className="model-prices-editor" data-testid="model-prices-editor">
      {rows.length === 0 ? (
        <p className="model-prices-empty">No manual prices set. A manual price always wins over provider-served and catalog pricing.</p>
      ) : (
        <ul className="gv-rows" aria-label="Manual model prices">
          {rows.map(({ modelKey, entry }) => (
            <li key={modelKey} className="gv-row price-row" data-model-key={modelKey}>
              <div className="gv-row__main">
                <span className="gv-row__text">
                  <span className="gv-row__title price-row__key">{modelKey}</span>
                  <span className="gv-row__meta">{modelPriceSummary(entry)}</span>
                </span>
              </div>
              <div className="gv-row__trailing">
                <Button
                  size="sm"
                  disabled={saving}
                  aria-label={`Edit price for ${modelKey}`}
                  onClick={() => beginEdit(modelKey)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  aria-label={`Remove price for ${modelKey}`}
                  onClick={() => void commitTable({ ...removeModelPrice(table, modelKey) })}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {formOpen ? (
        <form
          className="model-prices-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <Field label="Model (provider:model)">
            <Input
              type="text"
              className="price-row__key"
              aria-label="Model key (provider:model)"
              placeholder="openrouter:deepseek/deepseek-chat"
              value={draft.modelKey}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, modelKey: e.target.value })}
            />
          </Field>
          <div className="model-prices-form-prices">
            {priceInput('Input', 'input', true)}
            {priceInput('Output', 'output', true)}
            {priceInput('Cache read', 'cacheRead', false)}
            {priceInput('Cache write', 'cacheWrite', false)}
          </div>
          <div className="model-prices-form-actions">
            <Button type="submit" variant="primary" size="sm" disabled={saving}>
              {editingKey !== null ? 'Save price' : 'Add price'}
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft(EMPTY_MODEL_PRICE_DRAFT);
                setEditingKey(null);
                setFormOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" className="model-prices-add" disabled={saving} onClick={() => setFormOpen(true)}>
          Add price
        </Button>
      )}

      {error && (
        <div className="banner warning model-prices-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
