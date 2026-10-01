/**
 * payments-cards.test.ts, the rules card entry rests on, asserted rather than
 * trusted.
 *
 * Two of these are structural pins rather than ordinary unit tests, and they
 * are the important ones:
 *
 *  - the entry gate is the SDK's allowlist, not a local list. If the owner ever
 *    closes the webui again, the SDK edit alone must switch this surface off;
 *    the "webui is an entry surface" test below fails loudly if the pinned SDK
 *    stops saying so, instead of this app silently keeping a form the ruling
 *    no longer covers.
 *
 *  - the create route stays POST. invokeOperator sends a GET method's input as
 *    a query string, so a route flipped to GET would put a card number in the
 *    URL, browser history, referrer headers, every access log, with no change
 *    to any file that mentions cards. The pin against the generated contracts
 *    facade is what makes that a red test rather than a silent leak.
 */
import { describe, expect, test } from 'bun:test';
import { mayEnterCardDetails, mayOfferCardEntryFlow } from '@goodvibes-jev/engine/sdk/platform/payments/browser';
import {
  buildCardCreateInput,
  CARD_MATERIAL_FIELDS,
  CardDraftError,
  emptyCardDraft,
  mayEnterCardDetailsHere,
  mayOfferCardEntryHere,
  parseExpiry,
  WEBUI_CARD_ENTRY_SURFACE,
  type CardDraft,
} from './payments-cards';

// Fake throughout. Deliberately not a real card number and not the
// component's own placeholder text, so a match on one of these values can only
// come from an actual echo of a typed field.
const FAKE_NUMBER = '4000056655665556';
const FAKE_EXPIRY = '09/29';
const FAKE_CVV = '731';
const FAKE_HOLDER = 'Jane Q. Fakename';

function draft(overrides: Partial<CardDraft> = {}): CardDraft {
  return {
    ...emptyCardDraft(),
    label: 'errands card',
    number: FAKE_NUMBER,
    expiry: FAKE_EXPIRY,
    cvv: FAKE_CVV,
    cardholderName: FAKE_HOLDER,
    ...overrides,
  };
}

describe('the entry gate is the SDK allowlist, never a local list', () => {
  test('the SDK says a card may be typed on this surface', () => {
    // Asked of the SDK directly, so this fails if the pinned SDK's ruling changes.
    expect(mayEnterCardDetails(WEBUI_CARD_ENTRY_SURFACE)).toBe(true);
    expect(mayOfferCardEntryFlow(WEBUI_CARD_ENTRY_SURFACE)).toBe(true);
  });

  test('the module helpers agree with the SDK for this surface', () => {
    expect(mayEnterCardDetailsHere()).toBe(true);
    expect(mayOfferCardEntryHere()).toBe(true);
  });

  test('a surface the SDK refuses is refused here; the gate is not "am I the webui?"', () => {
    for (const remote of ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'ntfy', 'webhook', 'email', 'sms']) {
      expect(mayEnterCardDetailsHere(remote)).toBe(false);
      expect(mayOfferCardEntryHere(remote)).toBe(false);
    }
  });

  test('an unknown surface is refused. The allowlist is closed, not a denylist', () => {
    expect(mayEnterCardDetailsHere('some-channel-invented-later')).toBe(false);
    expect(mayOfferCardEntryHere('')).toBe(false);
  });
});

describe('a blank draft really is blank', () => {
  test('every card material field starts empty', () => {
    const blank = emptyCardDraft();
    for (const field of CARD_MATERIAL_FIELDS) {
      expect(blank[field]).toBe('');
    }
    expect(blank.label).toBe('');
    expect(blank.issuerCap).toBe('');
  });

  test('kind defaults to virtual: the option that bounds what a leak can cost', () => {
    expect(emptyCardDraft().kind).toBe('virtual');
  });
});

describe('parseExpiry', () => {
  test('MM/YY maps the two-digit year to 2000+YY, the only reading a card embosses', () => {
    expect(parseExpiry('09/29')).toEqual({ month: 9, year: 2029 });
  });

  test('MM/YYYY is taken as written', () => {
    expect(parseExpiry('12/2031')).toEqual({ month: 12, year: 2031 });
  });

  test('a single-digit month and surrounding spaces are accepted', () => {
    expect(parseExpiry(' 9/29 ')).toEqual({ month: 9, year: 2029 });
  });

  test('a dash separator works too', () => {
    expect(parseExpiry('09-29')).toEqual({ month: 9, year: 2029 });
  });

  test('month 00 and month 13 are refused', () => {
    expect(() => parseExpiry('00/29')).toThrow(CardDraftError);
    expect(() => parseExpiry('13/29')).toThrow(CardDraftError);
  });

  test('a shapeless expiry is refused', () => {
    expect(() => parseExpiry('next year')).toThrow(CardDraftError);
  });
});

describe('buildCardCreateInput', () => {
  test('a complete draft becomes the daemon input shape', () => {
    expect(buildCardCreateInput(draft())).toEqual({
      label: 'errands card',
      kind: 'virtual',
      number: FAKE_NUMBER,
      expiryMonth: 9,
      expiryYear: 2029,
      cvv: FAKE_CVV,
      cardholderName: FAKE_HOLDER,
      issuerCapMinorUnits: null,
    });
  });

  test('spaces and dashes in the number are stripped, so a card can be typed as it is printed', () => {
    expect(buildCardCreateInput(draft({ number: '4000 0566 5566 5556' })).number).toBe(FAKE_NUMBER);
    expect(buildCardCreateInput(draft({ number: '4000-0566-5566-5556' })).number).toBe(FAKE_NUMBER);
  });

  test('the issuer cap converts major units to minor units for the given currency', () => {
    expect(buildCardCreateInput(draft({ issuerCap: '200.00' }), 'USD').issuerCapMinorUnits).toBe(20000);
  });

  test('a zero-exponent currency converts without inventing cents', () => {
    expect(buildCardCreateInput(draft({ issuerCap: '2000' }), 'JPY').issuerCapMinorUnits).toBe(2000);
  });

  test('an empty issuer cap means none declared, not zero; zero would read as "cannot spend"', () => {
    expect(buildCardCreateInput(draft({ issuerCap: '   ' })).issuerCapMinorUnits).toBeNull();
  });

  test('a 4-digit security code (Amex) is accepted', () => {
    expect(buildCardCreateInput(draft({ cvv: '7314' })).cvv).toBe('7314');
  });

  test('a 19-digit number is accepted and a 12-digit one is not', () => {
    expect(buildCardCreateInput(draft({ number: '4'.repeat(19) })).number).toHaveLength(19);
    expect(() => buildCardCreateInput(draft({ number: '4'.repeat(12) }))).toThrow(CardDraftError);
  });

  describe('refusals name the field', () => {
    const cases: { name: string; overrides: Partial<CardDraft>; field: keyof CardDraft }[] = [
      { name: 'no label', overrides: { label: '  ' }, field: 'label' },
      { name: 'short number', overrides: { number: '4242' }, field: 'number' },
      { name: 'shapeless expiry', overrides: { expiry: 'soon' }, field: 'expiry' },
      { name: 'two-digit security code', overrides: { cvv: '73' }, field: 'cvv' },
      { name: 'non-numeric security code', overrides: { cvv: 'abc' }, field: 'cvv' },
      { name: 'no cardholder name', overrides: { cardholderName: ' ' }, field: 'cardholderName' },
      { name: 'unparseable issuer cap', overrides: { issuerCap: 'lots' }, field: 'issuerCap' },
      { name: 'bad kind', overrides: { kind: 'imaginary' as CardDraft['kind'] }, field: 'kind' },
    ];

    for (const { name, overrides, field } of cases) {
      test(`${name} is refused, and the error names "${field}"`, () => {
        try {
          buildCardCreateInput(draft(overrides));
          throw new Error('expected a CardDraftError');
        } catch (error) {
          expect(error).toBeInstanceOf(CardDraftError);
          expect((error as CardDraftError).field).toBe(field);
        }
      });
    }
  });

  test('a refusal message never contains the value it refused. A rejected card number is still a card number', () => {
    const bad = draft({ number: '4242424' });
    try {
      buildCardCreateInput(bad);
      throw new Error('expected a CardDraftError');
    } catch (error) {
      expect(error).toBeInstanceOf(CardDraftError);
      const message = (error as CardDraftError).message;
      expect(message).not.toContain('4242424');
      expect(message).not.toContain(FAKE_CVV);
    }
  });

  test('a refused security code is not echoed either', () => {
    try {
      buildCardCreateInput(draft({ cvv: '99999' }));
      throw new Error('expected a CardDraftError');
    } catch (error) {
      expect((error as CardDraftError).message).not.toContain('99999');
    }
  });
});
