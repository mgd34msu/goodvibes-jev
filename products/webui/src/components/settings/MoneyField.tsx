/**
 * MoneyField, the typed editor for the payments budget's `unit: 'money'`
 * keys (SDK 2.0.5's money-value.ts).
 *
 * The schema stores these as a plain amount of `payments.currency`, written
 * exactly the way a person types it: typing "100" stores `100`, typing
 * "19.99" stores `19.99`. There is no minor-unit conversion here, what is
 * shown is what is stored, and what is typed is what gets sent, modulo a
 * tolerated leading currency symbol ("$100") which lib/money.ts strips before
 * the value is committed.
 *
 * Commits on blur/Enter, same convention as SettingsField's plain number
 * field; a malformed amount shows inline and is never silently coerced.
 */
import { useSettingsDraft } from '../../hooks/useSettingsDraft';
import { SettingsDraftConflict } from './SettingsDraftConflict';
import { formatMoneyAmountValue, parseMoneyAmountInput } from '../../lib/money';
import { Input } from '../ui/Field';

export interface MoneyFieldProps {
  /** The live stored amount, in ordinary units of `currency` (e.g. 19.99 means $19.99). */
  readonly value: number;
  /** payments.currency's live value (e.g. "USD"), for the label only. */
  readonly currency: string;
  readonly disabled?: boolean;
  readonly onCommit: (value: number) => void | Promise<void>;
}

export function MoneyField({ value, currency, disabled, onCommit }: MoneyFieldProps) {
  const label = currency.trim() || 'USD';
  const draft = useSettingsDraft(formatMoneyAmountValue(value), (text) => {
    const amount = parseMoneyAmountInput(text);
    return { value: amount, text: formatMoneyAmountValue(amount) };
  }, onCommit);

  return (
    <div className="money-field" data-testid="money-field">
      <div className="money-field-row">
        <span className="money-field-currency" aria-hidden="true">
          {label}
        </span>
        <Input
          type="text"
          inputMode="decimal"
          className="settings-field-input money-field-amount"
          aria-label={`Amount in ${label}`}
          value={draft.text}
          disabled={disabled === true || draft.saving}
          onChange={(e) => draft.change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape' && (draft.dirty || draft.conflicted || draft.error !== null)) {
              e.preventDefault();
              e.stopPropagation();
              draft.reset();
            }
          }}
          onBlur={() => { if (!disabled) void draft.submit(); }}
        />
      </div>
      {draft.conflicted && !draft.saving && !disabled && (
        <SettingsDraftConflict onReset={draft.reset} onSave={() => void draft.submit(true)} />
      )}
      {draft.error && (
        <div className="banner warning money-field-error" role="alert">
          {draft.error}
        </div>
      )}
    </div>
  );
}
