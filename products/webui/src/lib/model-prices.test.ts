import { describe, expect, test } from 'bun:test';
import {
  draftFromEntry,
  EMPTY_MODEL_PRICE_DRAFT,
  modelPriceRows,
  modelPriceSummary,
  parseModelPriceDraft,
  readModelPriceTable,
  removeModelPrice,
  upsertModelPrice,
} from './model-prices';

describe('readModelPriceTable', () => {
  test('reads well-formed entries and keeps optional cache rates', () => {
    const table = readModelPriceTable({
      'openrouter:deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
      'anthropic:claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    });
    expect(table['openrouter:deepseek/deepseek-chat']).toEqual({ input: 0.14, output: 0.28 });
    expect(table['anthropic:claude-3-5-haiku']).toEqual({ input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 });
  });

  test('drops malformed entries instead of fabricating zeros', () => {
    const table = readModelPriceTable({
      'ok:model': { input: 1, output: 2 },
      'bad:negative': { input: -1, output: 2 },
      'bad:missing-output': { input: 1 },
      'bad:not-an-object': 'nope',
      'bad:nan': { input: Number.NaN, output: 2 },
    });
    expect(Object.keys(table)).toEqual(['ok:model']);
  });

  test('non-object input reads as an empty table', () => {
    expect(readModelPriceTable(undefined)).toEqual({});
    expect(readModelPriceTable('{}')).toEqual({});
    expect(readModelPriceTable([1])).toEqual({});
  });
});

describe('parseModelPriceDraft', () => {
  test('accepts a full draft and emits a typed entry', () => {
    const parsed = parseModelPriceDraft({
      modelKey: ' openrouter:deepseek/deepseek-chat ',
      input: '0.14',
      output: '0.28',
      cacheRead: '0.014',
      cacheWrite: '',
    });
    expect(parsed).toEqual({
      ok: true,
      modelKey: 'openrouter:deepseek/deepseek-chat',
      entry: { input: 0.14, output: 0.28, cacheRead: 0.014 },
    });
  });

  test('requires the provider:model key shape', () => {
    const missing = parseModelPriceDraft({ ...EMPTY_MODEL_PRICE_DRAFT, input: '1', output: '2' });
    expect(missing.ok).toBe(false);
    const noColon = parseModelPriceDraft({ ...EMPTY_MODEL_PRICE_DRAFT, modelKey: 'gpt-4o', input: '1', output: '2' });
    expect(noColon.ok).toBe(false);
  });

  test('model ids may contain dots, slashes, and colons after the provider', () => {
    const parsed = parseModelPriceDraft({
      ...EMPTY_MODEL_PRICE_DRAFT,
      modelKey: 'bedrock:us.anthropic.claude-3-5:0',
      input: '3',
      output: '15',
    });
    expect(parsed.ok).toBe(true);
  });

  test('rejects non-finite and negative prices', () => {
    const negative = parseModelPriceDraft({ ...EMPTY_MODEL_PRICE_DRAFT, modelKey: 'a:b', input: '-1', output: '2' });
    expect(negative.ok).toBe(false);
    const words = parseModelPriceDraft({ ...EMPTY_MODEL_PRICE_DRAFT, modelKey: 'a:b', input: '1', output: 'lots' });
    expect(words.ok).toBe(false);
    const badCache = parseModelPriceDraft({
      ...EMPTY_MODEL_PRICE_DRAFT,
      modelKey: 'a:b',
      input: '1',
      output: '2',
      cacheRead: '-0.5',
    });
    expect(badCache.ok).toBe(false);
  });

  test('required prices may be zero (free models are a real price, not unknown)', () => {
    const parsed = parseModelPriceDraft({ ...EMPTY_MODEL_PRICE_DRAFT, modelKey: 'local:llama', input: '0', output: '0' });
    expect(parsed).toEqual({ ok: true, modelKey: 'local:llama', entry: { input: 0, output: 0 } });
  });
});

describe('table operations', () => {
  const base = readModelPriceTable({ 'a:one': { input: 1, output: 2 } });

  test('upsert adds and replaces without mutating the input', () => {
    const added = upsertModelPrice(base, 'b:two', { input: 3, output: 4 });
    expect(Object.keys(added).sort()).toEqual(['a:one', 'b:two']);
    expect(Object.keys(base)).toEqual(['a:one']);
    const replaced = upsertModelPrice(added, 'a:one', { input: 9, output: 9 });
    expect(replaced['a:one']).toEqual({ input: 9, output: 9 });
  });

  test('remove deletes one entry without mutating the input', () => {
    const removed = removeModelPrice(base, 'a:one');
    expect(removed).toEqual({});
    expect(base['a:one']).toEqual({ input: 1, output: 2 });
  });

  test('rows render in stable alphabetical order', () => {
    const table = readModelPriceTable({
      'z:last': { input: 1, output: 1 },
      'a:first': { input: 1, output: 1 },
    });
    expect(modelPriceRows(table).map((r) => r.modelKey)).toEqual(['a:first', 'z:last']);
  });

  test('draftFromEntry round-trips through parse', () => {
    const draft = draftFromEntry('a:one', { input: 1.5, output: 2.5, cacheWrite: 3 });
    const parsed = parseModelPriceDraft(draft);
    expect(parsed).toEqual({ ok: true, modelKey: 'a:one', entry: { input: 1.5, output: 2.5, cacheWrite: 3 } });
  });

  test('summary names every present rate and the unit', () => {
    expect(modelPriceSummary({ input: 1, output: 2 })).toContain('$1');
    expect(modelPriceSummary({ input: 1, output: 2 })).toContain('$2');
    expect(modelPriceSummary({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 })).toBe(
      'in $1 · out $2 · cache read $0.1 · cache write $1.25 per 1M tokens',
    );
  });
});
