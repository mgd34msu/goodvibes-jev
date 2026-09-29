/**
 * card-shapes.test.ts
 *
 * The detector behind the remote-channel card gate (docs/inbound-email.md
 * §11.0). Every card number below is a published test value that passes Luhn
 * and belongs to no cardholder.
 *
 * Card numbers are code (Luhn over a 13 to 19 digit run). Whether a short
 * number or an MM/YY pair is a card's security code or expiry is Jev's
 * `engine.security.card-talk` reading over the digit-masked message; the fake
 * port here stands in for it, and these tests pin what the code does with it.
 */
import { describe, expect, test } from 'bun:test';
import { useSecurityReadings, withSecurityReadings } from './helpers/security-readings.ts';
import {
  cardShapeKinds,
  describeCardShapes,
  detectCardShapes,
  hasRefusableCardShapes,
  passesLuhn,
  redactCardShapes,
  renderCardShapeRefusal,
  type CardShapeFinding,
} from '../sdk/src/platform/security/card-shapes.ts';

/** Published test PANs. None of these is a real card. */
const VISA = '4111111111111111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';
const DINERS = '3056930009020004';

useSecurityReadings();

describe('Luhn', () => {
  test('accepts published test card numbers and rejects a digit-swapped one', () => {
    expect(passesLuhn(VISA)).toBe(true);
    expect(passesLuhn(MASTERCARD)).toBe(true);
    expect(passesLuhn(AMEX)).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
  });
});

describe('pan detection', () => {
  test('a bare Luhn-valid card number is a pan finding', async () => {
    const findings = await detectCardShapes(`please charge ${VISA} thanks`);
    expect(findings.map((f) => f.kind)).toEqual(['pan']);
    expect(hasRefusableCardShapes(findings)).toBe(true);
  });

  test('internal spaces and hyphens are stripped before the Luhn check', async () => {
    for (const written of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111 1111-1111 1111']) {
      const findings = await detectCardShapes(`card: ${written}`);
      expect(findings.some((f) => f.kind === 'pan')).toBe(true);
    }
  });

  test('the finding span covers the written form, separators included', async () => {
    const text = `pay with 4111 1111 1111 1111 now`;
    const pan = (await detectCardShapes(text)).find((f) => f.kind === 'pan');
    expect(pan).toBeDefined();
    expect(text.slice(pan!.startIndex, pan!.startIndex + pan!.length)).toBe('4111 1111 1111 1111');
  });

  test('Luhn alone decides it: no issuer prefix is required', async () => {
    // A 16-digit Luhn-valid number under no well-known issuer prefix (leading
    // 9). §11.0 refuses an issuer-prefix allowlist precisely so cards from
    // less common networks are not missed.
    const oddball = '9111111111111110';
    expect(passesLuhn(oddball)).toBe(true);
    expect((await detectCardShapes(oddball)).map((f) => f.kind)).toEqual(['pan']);
  });

  test('a Luhn-failing digit run of card length is not a pan', async () => {
    expect(await detectCardShapes('reference 4111111111111112 attached')).toEqual([]);
  });

  test('digit runs shorter than thirteen and longer than nineteen are not pans', async () => {
    expect(await detectCardShapes('order 12345678 shipped')).toEqual([]);
    // 20 digits, Luhn-valid, still outside the 13-19 window.
    const twenty = '12345678901234567894';
    expect(passesLuhn(twenty)).toBe(true);
    expect(await detectCardShapes(`tracking ${twenty}`)).toEqual([]);
  });

  test('newlines do not join two lines into one run', async () => {
    // Each line alone is too short; welded together they would be 16 digits.
    const text = '41111111\n11111111';
    expect(await detectCardShapes(text)).toEqual([]);
  });

  test('several card numbers in one message all report', async () => {
    const findings = await detectCardShapes(`${VISA} and ${MASTERCARD} and ${AMEX} and ${DINERS}`);
    expect(findings.filter((f) => f.kind === 'pan')).toHaveLength(4);
  });
});

describe('secondary shapes follow the card-talk reading', () => {
  test('bare three- and four-digit runs are not findings when the reading says no', async () => {
    expect(await detectCardShapes('the answer is 123')).toEqual([]);
    expect(await detectCardShapes('meet me in room 4021 at noon')).toEqual([]);
    expect(await detectCardShapes('build 872 passed, 991 queued, 100 pending')).toEqual([]);
  });

  test('a bare MM/YY is not a finding when the reading says no', async () => {
    expect(await detectCardShapes('the invoice is dated 07/26')).toEqual([]);
    expect(await detectCardShapes('window is 03/27 to 11/27')).toEqual([]);
  });

  test('a security code the reading confirms is a finding', async () => {
    const findings = await detectCardShapes('the cvv is 123');
    expect(cardShapeKinds(findings)).toEqual(['security-code']);
    expect(hasRefusableCardShapes(findings)).toBe(true);
  });

  test('an unsure reading keeps the candidate: only a confident no leaves a number alone', async () => {
    const findings = await withSecurityReadings({ securityCode: () => 'unsure', expiry: () => 'unsure' }, () =>
      detectCardShapes('room 123 on 07/29'));
    expect(cardShapeKinds(findings)).toEqual(['security-code', 'expiry']);
  });

  test('the reading never sees a digit', async () => {
    await withSecurityReadings({}, async (requests) => {
      await detectCardShapes(`card ${VISA} cvv 123 expiry 07/29`);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]!.state)).not.toMatch(/\d/);
    });
  });

  test('only the questions whose candidates exist are asked, and none without candidates', async () => {
    await withSecurityReadings({}, async (requests) => {
      await detectCardShapes(`charge ${VISA} thanks`);
      await detectCardShapes('cvv 123');
      await detectCardShapes('card expiry 07/29');
      expect(requests.map((request) => Object.keys(request.questions))).toEqual([['security_code'], ['expiry']]);
    });
  });

  test('an expiry the reading confirms is a finding', async () => {
    const findings = await detectCardShapes('card expiry 07/29');
    expect(findings.some((f) => f.kind === 'expiry')).toBe(true);
  });

  test('a month outside 01-12 is not an expiry candidate', async () => {
    const findings = await detectCardShapes('card ratio 13/29');
    expect(findings.some((f) => f.kind === 'expiry')).toBe(false);
  });

  test('pans and confirmed secondary shapes report together', async () => {
    const findings = await withSecurityReadings({ securityCode: () => true, expiry: () => true }, () =>
      detectCardShapes(`${VISA} 07/29 123`));
    expect(cardShapeKinds(findings)).toEqual(['pan', 'security-code', 'expiry']);
  });

  test('secondary shapes never overlap a pan span', async () => {
    const findings = await detectCardShapes(`card 4111-1111-1111-1111`);
    expect(cardShapeKinds(findings)).toEqual(['pan']);
  });

  test('findings come back sorted by position and never overlap', async () => {
    const findings = await detectCardShapes(`cvv 123 then ${VISA} then 07/29`);
    for (let index = 1; index < findings.length; index += 1) {
      const previous = findings[index - 1]!;
      const current = findings[index]!;
      expect(current.startIndex).toBeGreaterThanOrEqual(previous.startIndex + previous.length);
    }
  });
});

describe('the result cannot carry the digits', () => {
  test('a finding exposes only kind, startIndex and length at runtime', async () => {
    const findings = await detectCardShapes(`charge ${VISA}`);
    expect(findings).toHaveLength(1);
    expect(Object.keys(findings[0]!).sort()).toEqual(['kind', 'length', 'startIndex']);
  });

  test('no finding value serialises any part of the card number', async () => {
    const findings = await detectCardShapes(`card ${VISA} cvv 123 expiry 07/29`);
    expect(JSON.stringify(findings)).not.toContain(VISA);
    expect(JSON.stringify(findings)).not.toContain('4111');
  });

  test('the compile-time guard in card-shapes.ts is the type-level assertion', async () => {
    // The real assertion is the @ts-expect-error trio and the keyof guard at
    // the bottom of card-shapes.ts, which fail `tsc` the moment a value-bearing
    // field is added, a runtime test cannot observe a field that does not
    // exist. This case pins the exact key set the type is allowed to have, so
    // an addition shows up here as well as in the build.
    const finding: CardShapeFinding = { kind: 'pan', startIndex: 0, length: 16 };
    const allowed: ReadonlyArray<keyof CardShapeFinding> = ['kind', 'startIndex', 'length'];
    expect(Object.keys(finding).every((key) => (allowed as readonly string[]).includes(key))).toBe(true);
  });
});

describe('refusal text', () => {
  test('names the shapes and never the digits', async () => {
    const findings = await detectCardShapes(`card ${VISA} cvv 123 expiry 07/29`);
    const message = renderCardShapeRefusal(findings);
    expect(message).toContain('card number');
    expect(message).toContain('security code');
    expect(message).toContain('expiry date');
    expect(message).not.toContain(VISA);
    // Nothing from the card, in any written form, and no numerals at all.
    expect(message).not.toMatch(/\d/);
  });

  test('says approvals and vetoes still work, because the refused message may have been one', async () => {
    const message = renderCardShapeRefusal(await detectCardShapes(VISA));
    expect(message.toLowerCase()).toContain('vetoing');
  });

  test('describeCardShapes reports each distinct shape once, in a stable order', async () => {
    const findings = await detectCardShapes(`card ${VISA} ${MASTERCARD} cvv 123`);
    expect(describeCardShapes(findings)).toEqual(['card number', 'security code']);
  });
});

describe('redaction', () => {
  test('replaces the card number with a kind marker and leaves the rest intact', async () => {
    const redacted = await redactCardShapes(`Your order shipped. Card ending ${VISA} was charged.`);
    expect(redacted).not.toContain(VISA);
    expect(redacted).not.toContain('4111');
    expect(redacted).toContain('[redacted:pan]');
    expect(redacted).toContain('Your order shipped.');
    expect(redacted).toContain('was charged.');
  });

  test('redacts every span when there are several', async () => {
    const redacted = await redactCardShapes(`${VISA} then ${MASTERCARD}`);
    expect(redacted).toBe('[redacted:pan] then [redacted:pan]');
  });

  test('leaves ordinary order-confirmation text untouched', async () => {
    const body = 'Order 10029384 shipped. Tracking 1Z999AA10123456784. Total 42.99 on 07/26.';
    expect(await redactCardShapes(body)).toBe(body);
  });

  test('redacts secondary shapes only when the reading confirms them', async () => {
    expect(await redactCardShapes('room 123')).toBe('room 123');
    expect(await redactCardShapes('cvv 123')).toBe('cvv [redacted:security-code]');
  });
});
