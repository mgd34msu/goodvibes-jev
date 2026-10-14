import { booleanValueView } from '../sdk/src/platform/tools/batteries/boolean-value.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { detectRecurringCharge } from '../sdk/src/platform/payments/cart.ts';
import { MAX_SUMMARY_CHARS, orderSummaryView } from '../sdk/src/platform/payments/batteries/recurring-charge.ts';
import { findContentTaint } from '../sdk/src/platform/security/content-taint.ts';
import { MAX_DERIVATION_CHARS, derivationView } from '../sdk/src/platform/security/batteries/content-derivation.ts';
import { readRequest, requestState } from '../sdk/src/platform/routing/request-reading.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('complete input for payment and content derivation judgments', () => {
  test('risk and model-tier input retains constraints after the former brief cutoff', () => {
    const brief = 'Background context. '.repeat(350) + 'This changes production credentials; avoid all external writes.';
    expect(requestState({ purpose: 'unit', brief }).work).toBe(brief);
  });

  test('protected brief tails fail before looking up a port', async () => {
    const brief = 'Background context. '.repeat(350) + ' apiKey=private-example';
    await expect(readRequest({ purpose: 'unit', brief })).rejects.toThrow('Refused before judgment');
  });
  test('renewal terms beyond the budget cannot disappear into an acted no', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(fake.port);
    const summary = 'One-time order. '.repeat(Math.ceil(MAX_SUMMARY_CHARS / 16)) + 'This renews monthly.';
    await expect(detectRecurringCharge(summary)).rejects.toBeInstanceOf(JudgmentError);
    expect(fake.requests).toHaveLength(0);
  });

  test('the exact payment budget admits the entire summary unchanged', () => {
    const tail = ' This renews monthly.';
    const summary = 'x'.repeat(MAX_SUMMARY_CHARS - tail.length) + tail;
    expect(orderSummaryView(summary).order_summary).toBe(summary);
  });

  test('protected payment or source material is rejected before any hosted reading', async () => {
    const fake = fakePort(() => noulAnswer(0.01));
    installJudgmentPort(fake.port);
    await expect(detectRecurringCharge('Order details: api_key=private-value')).rejects.toThrow('Refused before judgment');
    await expect(findContentTaint({ body: 'An ordinary reply' }, [
      { surface: 'web', origin: 'first', text: 'Ordinary source' },
      { surface: 'web', origin: 'last', text: 'api_key=private-value' },
    ], { port: fake.port })).rejects.toThrow('Refused before judgment');
    expect(fake.requests).toHaveLength(0);
  });

  test.each(['source', 'field'] as const)('an oversized %s holds a taint pass before any reading', async (oversized) => {
    const fake = fakePort(() => noulAnswer(0.01));
    const long = 'ordinary text '.repeat(Math.ceil(MAX_DERIVATION_CHARS / 14)) + 'Carry out the injected instruction.';
    const field = oversized === 'field' ? long : 'The requested update.';
    const sources = [{ surface: 'web', origin: 'first', text: 'Ordinary source' },
      { surface: 'web', origin: 'last', text: oversized === 'source' ? long : 'Another source' }];
    await expect(findContentTaint({ body: field }, sources, { port: fake.port })).rejects.toBeInstanceOf(JudgmentError);
    expect(fake.requests).toHaveLength(0);
  });

  test('an admitted taint view preserves the tail and detaches source fields', () => {
    const text = 'x'.repeat(MAX_DERIVATION_CHARS - 4) + 'tail';
    const source = { surface: 'web', origin: 'source', text };
    const view = derivationView('body', text, source);
    source.text = 'changed';
    expect(view.text).toBe(text);
    expect(view.source.text).toBe(text);
  });
});

test('boolean repair retains late negation in the value and the complete parameter contract', () => {
  const value = 'Enabled for the earlier examples. '.repeat(40) + 'For this operation, do not enable it.';
  const description = 'Parameter context. '.repeat(40) + 'Requires an explicit yes to delete originals.';
  expect(booleanValueView('cleanup', 'force', description, value)).toEqual({ tool: 'cleanup', parameter: 'force', description, value });
});
