/**
 * `engine.security.card-field`: is this form control a payment card field
 * whose value must never be reported? Read by Jev in place of the
 * multilingual name, id, placeholder and label regexes card-fields.ts used
 * (card/karte/carte..., cvv/cvc/pruefziffer..., exp/gueltig bis...,
 * cardholder/titulaire...), for the controls whose `autocomplete` attribute
 * does not already declare a payment token.
 *
 * Band: high stakes. A wrong no reports a card number to the model; a wrong
 * yes hides one ordinary field's value, which the model can ask the owner
 * about. Code suppresses the value unless the reading is a confident no.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** What the reading sees about one control: its tag, type and every label a page can give it. */
export type CardFieldView = {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly id: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
};

const control = (view: Partial<CardFieldView> & Pick<CardFieldView, 'name'>): CardFieldView => ({
  tag: 'input',
  type: 'text',
  id: '',
  placeholder: '',
  ariaLabel: '',
  label: '',
  ...view,
});

export const cardField = defineBattery({
  name: 'engine.security.card-field',
  version: 1,
  description: 'Whether a form control on a web page is a payment card field (number, security code, expiry or cardholder name).',
  accuracyFloor: 0.85,
  items: {
    card_field: yesNo(
      'The state describes one form control on a web page: its tag, input type, name and id attributes, placeholder, aria-label and visible label, in whatever language the page uses. Is this control a payment card field: the card number, the card security code (CVV, CVC, CID), the card expiry date or month or year, or the cardholder name as printed on the card?',
      STAKES_BANDS.high.yesNo,
      {
        true: 'The control collects the card number, its security code, its expiry, or the name on the card.',
        false: 'The control collects something else: a person\'s ordinary name, an email, a postal address, a phone number, a coupon, gift card or loyalty code, a quantity, a search query or a password.',
      },
    ),
  },
  fixtures: [
    { name: 'German card number field', state: control({ name: 'kreditkartennummer', label: 'Kartennummer' }), expect: { card_field: 'yes' } },
    { name: 'German verification digits', state: control({ name: 'pruefziffer', label: 'Prüfziffer', type: 'tel' }), expect: { card_field: 'yes' } },
    { name: 'French expiry', state: control({ name: 'date_validite', label: 'Date de validité (MM/AA)' }), expect: { card_field: 'yes' } },
    { name: 'Spanish security code', state: control({ name: 'codigo', placeholder: 'Código de seguridad' }), expect: { card_field: 'yes' } },
    { name: 'obscure id with a card label', state: control({ name: 'f_19', id: 'f_19', label: 'Card number' }), expect: { card_field: 'yes' } },
    { name: 'cardholder name', state: control({ name: 'holder', label: 'Name on card' }), expect: { card_field: 'yes' } },
    { name: 'expiry year select', state: control({ tag: 'select', type: '', name: 'exp_year', label: 'Expiration year' }), expect: { card_field: 'yes' } },
    { name: 'shipping name', state: control({ name: 'shipping_name', label: 'Full name' }), expect: { card_field: 'no' } },
    { name: 'email address', state: control({ name: 'email', type: 'email', label: 'Email address' }), expect: { card_field: 'no' } },
    { name: 'gift card code', state: control({ name: 'giftcard', label: 'Gift card or promo code' }), expect: { card_field: 'no' } },
    { name: 'postal code', state: control({ name: 'postcode', label: 'Postleitzahl' }), expect: { card_field: 'no' } },
    { name: 'order quantity', state: control({ name: 'qty', type: 'number', label: 'Quantity' }), expect: { card_field: 'no' } },
    { name: 'site search box', state: control({ name: 'q', type: 'search', placeholder: 'Search products' }), expect: { card_field: 'no' } },
  ],
});
