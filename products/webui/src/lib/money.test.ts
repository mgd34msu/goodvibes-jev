import { describe, expect, test } from 'bun:test';
import {
  InvalidMoneyInputError,
  MAX_MONEY_AMOUNT,
  formatMoneyAmountValue,
  isMoneyField,
  majorTextToMinorUnits,
  minorUnitExponent,
  minorUnitsToMajorText,
  parseMoneyAmountInput,
} from './money';

describe('isMoneyField', () => {
  test('true only when the schema entry is marked unit: "money"', () => {
    expect(isMoneyField('money')).toBe(true);
  });

  test('false when the schema entry carries no unit mark', () => {
    expect(isMoneyField(undefined)).toBe(false);
  });
});

describe('parseMoneyAmountInput: plain amounts, no unit conversion', () => {
  test('a whole number is returned exactly as typed', () => {
    expect(parseMoneyAmountInput('100')).toBe(100);
    expect(parseMoneyAmountInput('50')).toBe(50);
  });

  test('a decimal amount is returned exactly as typed', () => {
    expect(parseMoneyAmountInput('19.99')).toBe(19.99);
    expect(parseMoneyAmountInput('0.10')).toBe(0.1);
  });

  test('a leading currency symbol is tolerated and stripped', () => {
    expect(parseMoneyAmountInput('$100')).toBe(100);
  });

  test('thousands grouping is tolerated and stripped', () => {
    expect(parseMoneyAmountInput('1,250.50')).toBe(1250.5);
  });

  test('tolerates surrounding whitespace', () => {
    expect(parseMoneyAmountInput('  19.99  ')).toBe(19.99);
  });

  test('rejects empty, non-numeric, and negative input', () => {
    expect(() => parseMoneyAmountInput('')).toThrow(InvalidMoneyInputError);
    expect(() => parseMoneyAmountInput('abc')).toThrow(InvalidMoneyInputError);
    expect(() => parseMoneyAmountInput('-5')).toThrow(InvalidMoneyInputError);
  });

  test('rejects more than 2 decimal places', () => {
    expect(() => parseMoneyAmountInput('5.999')).toThrow(InvalidMoneyInputError);
  });

  test('rejects an amount over MAX_MONEY_AMOUNT', () => {
    expect(() => parseMoneyAmountInput(String(MAX_MONEY_AMOUNT + 1))).toThrow(InvalidMoneyInputError);
    expect(parseMoneyAmountInput(String(MAX_MONEY_AMOUNT))).toBe(MAX_MONEY_AMOUNT);
  });
});

describe('formatMoneyAmountValue: the stored value as-is, never scaled', () => {
  test('renders a whole number and a decimal exactly', () => {
    expect(formatMoneyAmountValue(100)).toBe('100');
    expect(formatMoneyAmountValue(19.99)).toBe('19.99');
  });

  test('falls back to "0" for a non-finite value rather than showing a broken string', () => {
    expect(formatMoneyAmountValue(Number.NaN)).toBe('0');
    expect(formatMoneyAmountValue(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('major <-> minor unit round trip: exact, no float drift', () => {
  // Representative values including ones that break naive `Number(x) * 100` /
  // `/ 100` float math (0.1, 0.29 famously do not survive that round trip
  // exactly on IEEE 754 doubles).
  const cases: [string, number][] = [
    ['0.10', 10],
    ['0.29', 29],
    ['19.99', 1999],
    ['1234.56', 123456],
    ['0.00', 0],
    ['0', 0],
    ['50', 5000],
    ['1', 100],
    ['0.1', 10],
    ['0.9', 90],
  ];

  for (const [text, minor] of cases) {
    test(`"${text}" major <-> ${minor} minor`, () => {
      expect(majorTextToMinorUnits(text)).toBe(minor);
      expect(minorUnitsToMajorText(minor)).toBe(minorUnitsToMajorText(majorTextToMinorUnits(text)));
    });
  }

  test('minorUnitsToMajorText renders the canonical 2-decimal form', () => {
    expect(minorUnitsToMajorText(10)).toBe('0.10');
    expect(minorUnitsToMajorText(29)).toBe('0.29');
    expect(minorUnitsToMajorText(1999)).toBe('19.99');
    expect(minorUnitsToMajorText(123456)).toBe('1234.56');
    expect(minorUnitsToMajorText(0)).toBe('0.00');
  });

  test('never uses float multiplication that would drift: 0.1 and 0.29 are the classic float traps', () => {
    // Sanity-check the traps this module exists to avoid: naive float math
    // does not reliably give exactly 10 / 29 on every engine and rounding path.
    expect(majorTextToMinorUnits('0.10')).toBe(10);
    expect(majorTextToMinorUnits('0.29')).toBe(29);
  });

  test('a full round trip through both directions is lossless for every case', () => {
    for (const [text, minor] of cases) {
      const roundTripped = majorTextToMinorUnits(minorUnitsToMajorText(minor));
      expect(roundTripped).toBe(minor);
      expect(majorTextToMinorUnits(text)).toBe(minor);
    }
  });
});

describe('majorTextToMinorUnits: rejects malformed input honestly', () => {
  test('rejects empty, non-numeric, negative, and over-precise input', () => {
    expect(() => majorTextToMinorUnits('')).toThrow(InvalidMoneyInputError);
    expect(() => majorTextToMinorUnits('abc')).toThrow(InvalidMoneyInputError);
    expect(() => majorTextToMinorUnits('-5')).toThrow(InvalidMoneyInputError);
    expect(() => majorTextToMinorUnits('5.999')).toThrow(InvalidMoneyInputError);
    expect(() => majorTextToMinorUnits('5.')).toThrow(InvalidMoneyInputError);
    expect(() => majorTextToMinorUnits('5,00')).toThrow(InvalidMoneyInputError);
  });

  test('tolerates surrounding whitespace', () => {
    expect(majorTextToMinorUnits('  19.99  ')).toBe(1999);
  });
});

describe('minorUnitsToMajorText: rejects a value it cannot represent honestly', () => {
  test('rejects negative and non-integer minor-unit values rather than fabricating an amount', () => {
    expect(() => minorUnitsToMajorText(-1)).toThrow(InvalidMoneyInputError);
    expect(() => minorUnitsToMajorText(1.5)).toThrow(InvalidMoneyInputError);
  });
});

describe('minorUnitExponent: mirrors the SDK exponent table exactly', () => {
  test('defaults to 2 decimal places for an ordinary currency', () => {
    expect(minorUnitExponent('USD')).toBe(2);
    expect(minorUnitExponent('GBP')).toBe(2);
    expect(minorUnitExponent('EUR')).toBe(2);
  });

  test('zero-decimal currencies (no minor unit at all)', () => {
    for (const code of ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XAF', 'XOF', 'XPF']) {
      expect(minorUnitExponent(code)).toBe(0);
    }
  });

  test('three-decimal currencies', () => {
    for (const code of ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']) {
      expect(minorUnitExponent(code)).toBe(3);
    }
  });

  test('is case-insensitive and tolerates whitespace', () => {
    expect(minorUnitExponent('jpy')).toBe(0);
    expect(minorUnitExponent(' KWD ')).toBe(3);
  });
});

describe('currency-exponent-aware conversion: the real bug a hardcoded 2 decimals would cause', () => {
  test('JPY: a typed whole amount converts 1:1: "5000" must stay 5000, never become 500000', () => {
    expect(majorTextToMinorUnits('5000', 'JPY')).toBe(5000);
    expect(minorUnitsToMajorText(5000, 'JPY')).toBe('5000');
  });

  test('JPY rejects a fractional amount: there is no minor unit to hold it', () => {
    expect(() => majorTextToMinorUnits('50.5', 'JPY')).toThrow(InvalidMoneyInputError);
  });

  test('KWD (3 decimals): exact round trip, including a float trap at 3 decimal places', () => {
    expect(majorTextToMinorUnits('1.234', 'KWD')).toBe(1234);
    expect(minorUnitsToMajorText(1234, 'KWD')).toBe('1.234');
    expect(majorTextToMinorUnits('0.001', 'KWD')).toBe(1);
    expect(minorUnitsToMajorText(1, 'KWD')).toBe('0.001');
  });

  test('KWD rejects a 4th fraction digit rather than silently truncating', () => {
    expect(() => majorTextToMinorUnits('1.2345', 'KWD')).toThrow(InvalidMoneyInputError);
  });

  test('a full round trip is lossless for every exponent (0, 2, 3)', () => {
    const cases: [string, number, string][] = [
      ['5000', 5000, 'JPY'],
      ['19.99', 1999, 'USD'],
      ['1.234', 1234, 'KWD'],
    ];
    for (const [text, minor, currency] of cases) {
      expect(majorTextToMinorUnits(text, currency)).toBe(minor);
      expect(majorTextToMinorUnits(minorUnitsToMajorText(minor, currency), currency)).toBe(minor);
    }
  });
});
