/**
 * PaymentCardEntry, typing a payment card into the browser.
 *
 * The owner ruled for this surface directly, having been shown what a browser
 * costs that a terminal does not (a PAN on a page, form autofill, password
 * managers, browser history, XSS in our own UI). The option he chose carried
 * six conditions; they are part of the ruling, and each one below names the
 * line of code that implements it so a reviewer can check rather than trust.
 * The list itself lives in payments-cards.ts as CARD_ENTRY_CONDITIONS.
 *
 *  1. POSTED OVER THE AUTHENTICATED DAEMON CHANNEL, submit() calls
 *     sdk.operator.payments.cards.create, the same scoped, token-carrying
 *     transport every other secret takes. The daemon puts the values in its own
 *     secret store, encrypted at rest, at DAEMON scope: it is the process that
 *     charges the card with every surface closed, so a client-scoped write
 *     would report success and do nothing.
 *
 *  2. NEVER IN A URL, the route is POST /api/payments/cards, so invokeOperator
 *     sends the input as a request BODY. (It sends a GET method's input as a
 *     query string, which is why payments-cards.test.ts pins the method to
 *     POST: a route flipped to GET would put a card number into browser
 *     history, referrer headers and every access log on the way.)
 *
 *  3. NEVER RENDERED BACK, nothing here reads a card value out of a response.
 *     create() answers with metadata only (label, brand, last four, expiry
 *     month/year, materialComplete); `cards` renders exactly that. No field is
 *     ever repopulated from the server, including after a failed submit.
 *
 *  4. autocomplete="off" ON EVERY CARD FIELD, see CARD_INPUT_GUARDS, spread
 *     onto all four inputs rather than typed out four times, so a new field
 *     cannot be added without it.
 *
 *  5. NOT SAVEABLE BY A PASSWORD MANAGER, three things together, because
 *     autocomplete="off" alone is widely ignored by managers:
 *       - there is NO <form> element. A manager's "save this?" prompt is
 *         overwhelmingly triggered by a form submission, and this panel submits
 *         with a button handler instead;
 *       - the inputs carry no `name` attribute, which is the other half of what
 *         managers match on (nothing here needs one, a name is only meaningful
 *         to a native form post, which we do not do);
 *       - the vendor opt-outs 1Password, LastPass and Bitwarden actually honor
 *         are set explicitly (data-1p-ignore / data-lpignore / data-bwignore).
 *     A manager that copied the number would put it in storage this system
 *     cannot reach, cannot clear, and does not know about.
 *
 *  6. NO CARD VALUE RETAINED IN DOM STATE, on success, submit() assigns
 *     emptyCardDraft() back over the whole draft, so every card field returns
 *     to empty rather than the ones someone remembered to list. Note what this
 *     component deliberately does NOT use: react-query's useMutation, whose
 *     mutation cache holds `variables` (which would be the card) until it is
 *     reset or garbage-collected. The create call is a plain async handler with
 *     local state for exactly that reason. Nothing card-shaped goes in a store,
 *     a query cache, or anything that survives this component unmounting.
 *
 * Concealment while typing is best-effort and visual only: the number and
 * security code render through `-webkit-text-security: disc` (settings.css)
 * rather than type="password", because a password input is the single strongest
 * signal a manager looks for and condition 5 outranks a nicer mask. On a
 * browser without that property the characters are visible as typed, which is
 * worth stating plainly rather than implying a guarantee we do not have.
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeCardEntryRefusal } from '@goodvibes-jev/engine/sdk/platform/payments/browser';
import { sdk } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Field, Input } from '../ui/Field';
import { Row, RowList } from '../ui/Row';
import { Select } from '../ui/Select';
import { SettingsBlock } from './dialog/parts';
import { useToast } from '../../lib/toast';
import { minorUnitsToMajorText } from '../../lib/money';
import {
  buildCardCreateInput,
  CARD_INPUT_GUARDS,
  CardDraftError,
  emptyCardDraft,
  mayOfferCardEntryHere,
  WEBUI_CARD_ENTRY_SURFACE,
  type CardDraft,
} from '../../lib/payments-cards';

export interface PaymentCardEntryProps {
  /** The currency the issuer cap is typed in, payments.currency's live value. */
  readonly currency?: string;
  /** Overridable only so a test can drive the refusal path; never passed in app code. */
  readonly surface?: string;
}

export function PaymentCardEntry({ currency = 'USD', surface = WEBUI_CARD_ENTRY_SURFACE }: PaymentCardEntryProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<CardDraft>(emptyCardDraft());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [errorField, setErrorField] = useState<keyof CardDraft | null>(null);

  const offered = mayOfferCardEntryHere(surface);

  // Metadata only, there is no daemon method that returns card material, so
  // this query cannot carry any however it is cached. Not run at all when the
  // surface is refused: a surface that may not take a card has no business
  // listing them either.
  const cards = useQuery({
    queryKey: ['payments', 'cards'],
    queryFn: () => sdk.operator.payments.cards.list(),
    enabled: offered,
    retry: false,
  });

  const update = useCallback((field: keyof CardDraft, value: string): void => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    setError('');
    setErrorField(null);

    let input;
    try {
      input = buildCardCreateInput(draft, currency);
    } catch (problem) {
      if (problem instanceof CardDraftError) {
        setError(problem.message);
        setErrorField(problem.field);
        return;
      }
      throw problem;
    }

    setSaving(true);
    try {
      await sdk.operator.payments.cards.create(input);
      // Condition 6, and the only place it can be honoured: the whole draft is
      // replaced with a blank one the instant the write succeeds. `input` is a
      // local that goes out of scope with this call; nothing retains it.
      setDraft(emptyCardDraft());
      await queryClient.invalidateQueries({ queryKey: ['payments', 'cards'] });
      toast({
        title: 'Card stored',
        description: 'Saved to the daemon secret store, encrypted at rest, so purchases can complete while you are away.',
        tone: 'success',
      });
    } catch (problem) {
      // The draft is deliberately NOT cleared on failure, the operator would
      // otherwise have to retype a card because the network blipped. The
      // message comes from the transport, never from the values: the daemon's
      // own create handler refuses to forward its underlying error for the same
      // reason (the failing call had the card in its arguments).
      setError(formatError(problem));
      toast({ title: 'Failed to store the card', description: formatError(problem), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }, [draft, currency, queryClient, toast]);

  if (!offered) {
    // The prompt is itself the harm: a surface that cannot accept the answer
    // must never ask the question. No inputs are rendered at all, not disabled
    // ones, which would still be an invitation to type.
    return (
      <section className="settings-card-entry" data-testid="payment-card-entry-refused">
        <div className="banner warning" role="alert">
          {describeCardEntryRefusal(surface)}
        </div>
      </section>
    );
  }

  const list = cards.data?.cards ?? [];

  return (
    <SettingsBlock
      className="settings-card-entry"
      testId="payment-card-entry"
      title="Payment card"
      description="The number, expiry, security code and cardholder name go to the daemon's secret store, encrypted, and are never shown again. There is no way to read them back, here or anywhere else. A virtual card with a hard issuer cap limits what a leak could cost to one number you can cancel; a real card number cannot be capped by anything this software does."
    >
      {list.length > 0 && (
        <div className="settings-card-list" data-testid="payment-card-list">
          <RowList aria-label="Stored cards">
            {list.map((card) => (
              <Row
                key={card.id}
                title={card.label}
                meta={[
                  `${card.brand} ···${card.last4}`,
                  `${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}`,
                  card.kind,
                  card.issuerCapMinorUnits !== null
                    ? `cap ${minorUnitsToMajorText(card.issuerCapMinorUnits, currency)} ${currency}`
                    : '',
                ].filter(Boolean).join(' · ')}
                trailing={<Chip tone={card.materialComplete ? 'ok' : 'warn'}>{card.materialComplete ? 'Complete' : 'Incomplete'}</Chip>}
              />
            ))}
          </RowList>
        </div>
      )}

      {/*
        No <form> element, deliberately. See condition 5 in the header. The
        button below is an ordinary button with a click handler, not a submit.
      */}
      <div className="settings-card-form">
        <Field label="Label">
          <Input
            id="gv-card-label"
            type="text"
            value={draft.label}
            placeholder="e.g. virtual card for errands"
            disabled={saving}
            onChange={(event) => update('label', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <Field label="Kind">
          <Select
            id="gv-card-kind"
            value={draft.kind}
            disabled={saving}
            onChange={(next) => update('kind', next)}
            options={[
              { value: 'virtual', label: 'virtual (recommended: issuer-capped, killable)' },
              { value: 'real', label: 'real' },
            ]}
          />
        </Field>

        <Field label="Card number">
          <Input
            id="gv-card-number"
            type="text"
            inputMode="numeric"
            className="settings-card-concealed"
            value={draft.number}
            disabled={saving}
            aria-invalid={errorField === 'number'}
            onChange={(event) => update('number', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <Field label="Expiry (MM/YY)">
          <Input
            id="gv-card-expiry"
            type="text"
            inputMode="numeric"
            value={draft.expiry}
            placeholder="09/29"
            disabled={saving}
            aria-invalid={errorField === 'expiry'}
            onChange={(event) => update('expiry', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <Field label="Security code">
          <Input
            id="gv-card-cvv"
            type="text"
            inputMode="numeric"
            className="settings-card-concealed"
            value={draft.cvv}
            disabled={saving}
            aria-invalid={errorField === 'cvv'}
            onChange={(event) => update('cvv', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <Field label="Cardholder name">
          <Input
            id="gv-card-holder"
            type="text"
            value={draft.cardholderName}
            placeholder="as printed on the card"
            disabled={saving}
            aria-invalid={errorField === 'cardholderName'}
            onChange={(event) => update('cardholderName', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <Field label={`Issuer cap (${currency}, optional)`} help="The cap is what you declared. We cannot verify it and never enforce it; only your card issuer can.">
          <Input
            id="gv-card-cap"
            type="text"
            inputMode="decimal"
            value={draft.issuerCap}
            placeholder="200.00"
            disabled={saving}
            aria-invalid={errorField === 'issuerCap'}
            onChange={(event) => update('issuerCap', event.target.value)}
            {...CARD_INPUT_GUARDS}
          />
        </Field>

        <div className="settings-card-form__submit">
          <Button
            variant="primary"
            disabled={saving}
            data-testid="payment-card-submit"
            onClick={() => void submit()}
          >
            {saving ? 'Storing…' : 'Store card'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="banner warning" role="alert" data-testid="payment-card-error">
          {error}
        </div>
      )}
    </SettingsBlock>
  );
}
