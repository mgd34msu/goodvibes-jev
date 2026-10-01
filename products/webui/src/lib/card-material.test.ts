import { describe, expect, test } from 'bun:test';
import { isCardMaterialKey } from './card-material';

describe('isCardMaterialKey', () => {
  test('matches bare cvv / pan keys', () => {
    expect(isCardMaterialKey('payments.cards.visa.cvv')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.cvv2')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.cvc')).toBe(true);
    expect(isCardMaterialKey('pan')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.pan')).toBe(true);
  });

  test('matches compound cardNumber forms', () => {
    expect(isCardMaterialKey('payments.cards.visa.cardNumber')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.cardnumber')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.card_number')).toBe(true);
    expect(isCardMaterialKey('cardNum')).toBe(true);
  });

  test('matches a compound key ending in "pan", the trailing word identifies the material', () => {
    expect(isCardMaterialKey('payments.cards.visa.rawPan')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.visaPan')).toBe(true);
  });

  test('does NOT match legitimate keys that merely contain "pan" as a substring', () => {
    expect(isCardMaterialKey('surfaces.slack.companyName')).toBe(false);
    expect(isCardMaterialKey('device.location.japanRegion')).toBe(false);
  });

  test('does NOT match a compound key where "pan"/"cvv" is the LEADING word of a real setting name', () => {
    // payments.cvvHandling is a real, non-secret policy setting ('stored' | 'prompt'),
    // "cvv" here qualifies "Handling", it is not the trailing identifying word.
    expect(isCardMaterialKey('payments.cvvHandling')).toBe(false);
    // Same shape hypothetically for a map "pan" (as in pan/zoom) feature flag.
    expect(isCardMaterialKey('knowledge.map.panEnabled')).toBe(false);
  });

  test('does NOT match payments.defaultCardId; a card reference, not card material', () => {
    expect(isCardMaterialKey('payments.defaultCardId')).toBe(false);
  });

  test('does NOT match ordinary payments schema keys', () => {
    expect(isCardMaterialKey('payments.enabled')).toBe(false);
    expect(isCardMaterialKey('payments.currency')).toBe(false);
    expect(isCardMaterialKey('payments.cvvHandling')).toBe(false);
    expect(isCardMaterialKey('payments.budget.dailyItem')).toBe(false);
    expect(isCardMaterialKey('payments.windows.vetoMinutes')).toBe(false);
    expect(isCardMaterialKey('payments.notifyChannels')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isCardMaterialKey('payments.cards.visa.CVV')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.PAN')).toBe(true);
    expect(isCardMaterialKey('payments.cards.visa.CardNumber')).toBe(true);
  });
});

/**
 * The four keys the card-entry surfaces actually write.
 *
 * "Never rendered back after entry" is a condition of the owner's card-entry
 * ruling, and it has to hold for every card field, not only the two whose
 * names happen to end in a word the trailing-token rule already catches.
 * payments.cardExpiry and payments.cardholderName end in "expiry" and "name",
 * which must never become token rules (a "name" token would hide
 * payments.billingAddress.name and every other *.name key in the schema), so
 * they are matched by their full key instead.
 */
describe('the four card-material keys the entry surfaces write', () => {
  test('all four are non-displayable', () => {
    expect(isCardMaterialKey('payments.cardNumber')).toBe(true);
    expect(isCardMaterialKey('payments.cardExpiry')).toBe(true);
    expect(isCardMaterialKey('payments.cardCvv')).toBe(true);
    expect(isCardMaterialKey('payments.cardholderName')).toBe(true);
  });

  test('the exact-key rule does not spill onto ordinary keys ending in the same words', () => {
    // These are real, displayable settings. A trailing-word rule for "name" or
    // "expiry" would have hidden them, which is why the two card keys above
    // are matched whole rather than by their last word.
    expect(isCardMaterialKey('payments.billingAddress.name')).toBe(false);
    expect(isCardMaterialKey('payments.shippingAddress.name')).toBe(false);
    expect(isCardMaterialKey('surfaces.slack.displayName')).toBe(false);
    expect(isCardMaterialKey('relay.tokenExpiry')).toBe(false);
    expect(isCardMaterialKey('cardExpiry')).toBe(false);
    expect(isCardMaterialKey('other.cardholderName')).toBe(false);
  });
});
