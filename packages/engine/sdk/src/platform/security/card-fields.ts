/**
 * card-fields.ts, recognising a payment field on any page.
 *
 * Lives in security/ rather than in payments/ or browser/ because both need it
 * and neither owns it. The browser's snapshot must suppress a payment field's
 * value whether or not the payment capability is even configured, and the
 * payment capability must classify the same way the snapshot does or the two
 * disagree about what was protected. A shared rule in the layer they both
 * already depend on is the only arrangement where that cannot drift.
 *
 * It is also why `platform/browser/` still imports no product surface: this is
 * foundation, like link validation and the public-suffix list beside it.
 *
 * ── How a field is recognised ──────────────────────────────────────────────
 *
 * There is no registry of merchants here and there must never be one. A
 * control whose `autocomplete` attribute carries one of the payment tokens the
 * HTML standard defines has declared itself a payment field, and that
 * declaration is taken as given. Every other form control is read by Jev
 * (`engine.security.card-field`) from its name, id, placeholder and labels in
 * whatever language the page uses; that reading replaced a list of
 * multilingual name and label regexes.
 *
 * ── Erring toward yes ─────────────────────────────────────────────────────
 *
 * A false positive costs the model the contents of one form field, which it can
 * ask the owner about. A false negative hands it a card number. Those are not
 * comparable, so a control is treated as a payment field unless the reading
 * is a confident no.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { cardField } from './batteries/card-field.js';

/**
 * Everything about one control the classification may look at.
 *
 * A plain record rather than a DOM element, because the function that walks a
 * page is serialized and evaluated inside the browser and can import nothing.
 * The in-page collector gathers these attributes; the judgement happens in
 * process, where it can be tested against real inputs instead of merely read.
 */
export interface FormControlDescriptor {
  readonly tag: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
}

/**
 * The autofill tokens the HTML standard defines for payment instruments.
 *
 * A checkout that wants a browser to fill it must use these, so this catches
 * every well-behaved payment form without knowing anything about the site.
 */
const CARD_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
]);

/** The decision site the card-field reading is logged under. */
export const CARD_FIELD_SITE = 'security.card-field';

/** Whether this control is a payment field whose value must never be reported. */
export async function isCardFieldDescriptor(control: FormControlDescriptor): Promise<boolean> {
  // Every field is coerced rather than trusted. This runs on data that came
  // back from inside a page, where a missing or oddly-typed property is an
  // ordinary occurrence, and a throw here would fail the whole snapshot, which
  // is a far worse outcome than misclassifying one control.
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const tag = text(control.tag).toLowerCase();
  // Only these elements carry a value a snapshot could report.
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;

  // `autocomplete="shipping cc-number"` and `section-pay cc-csc` are both legal
  // spellings, so each token is checked rather than the whole attribute.
  const tokens = text(control.autocomplete).toLowerCase().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.some((token) => CARD_AUTOCOMPLETE_TOKENS.has(token))) return true;

  const run = await cardField.run(judgmentPort(CARD_FIELD_SITE), {
    tag,
    type: text(control.type),
    name: text(control.name),
    id: text(control.id),
    placeholder: text(control.placeholder),
    ariaLabel: text(control.ariaLabel),
    label: text(control.label),
  }, { site: CARD_FIELD_SITE });
  const reading = run.readings.card_field;
  const ordinary = reading.verdict === 'no' && reading.outcome === 'act';
  run.recordAction(ordinary ? 'value reported' : 'value suppressed');
  return !ordinary;
}
