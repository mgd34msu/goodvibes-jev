/**
 * model-prices.ts, pure model for the manual model-price table
 * (`pricing.modelPrices`): a record keyed "provider:model" whose entries are
 * { input, output, cacheRead?, cacheWrite? } in USD per 1M tokens. A manual
 * price always wins over provider-served and catalog pricing and applies live.
 *
 * No React, no I/O, the editor component and any "set a price for this model"
 * affordance share these helpers so validation and shape stay identical
 * everywhere the table is written.
 */
import { asRecord } from './object';

/** One manual price entry, USD per 1M tokens. */
export interface ModelPriceEntry {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export type ModelPriceTable = Readonly<Record<string, ModelPriceEntry>>;

function readPriceNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Read the live `pricing.modelPrices` value into a typed table, dropping
 * malformed entries rather than fabricating zeros for them.
 */
export function readModelPriceTable(raw: unknown): ModelPriceTable {
  const record = asRecord(raw);
  const table: Record<string, ModelPriceEntry> = {};
  for (const [key, value] of Object.entries(record)) {
    const entry = asRecord(value);
    const input = readPriceNumber(entry.input);
    const output = readPriceNumber(entry.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = readPriceNumber(entry.cacheRead);
    const cacheWrite = readPriceNumber(entry.cacheWrite);
    table[key] = {
      input,
      output,
      ...(cacheRead !== undefined ? { cacheRead } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    };
  }
  return table;
}

/** Draft form values for one entry, strings straight from the inputs. */
export interface ModelPriceDraft {
  readonly modelKey: string;
  readonly input: string;
  readonly output: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
}

export function draftFromEntry(modelKey: string, entry: ModelPriceEntry): ModelPriceDraft {
  return {
    modelKey,
    input: String(entry.input),
    output: String(entry.output),
    cacheRead: entry.cacheRead !== undefined ? String(entry.cacheRead) : '',
    cacheWrite: entry.cacheWrite !== undefined ? String(entry.cacheWrite) : '',
  };
}

export const EMPTY_MODEL_PRICE_DRAFT: ModelPriceDraft = {
  modelKey: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
};

function parsePriceField(label: string, text: string): { value?: number; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `${label} must be a finite number >= 0 (USD per 1M tokens)` };
  }
  return { value: n };
}

function parseRequiredPrice(label: string, text: string): { value: number } | { error: string } {
  const parsed = parsePriceField(label, text);
  if (parsed.error !== undefined) return { error: parsed.error };
  if (parsed.value === undefined) return { error: `${label} price is required` };
  return { value: parsed.value };
}

/**
 * Validate a draft into an entry. Returns either the parsed entry or the
 * first human-readable problem. The key must look like "provider:model".
 */
export function parseModelPriceDraft(
  draft: ModelPriceDraft,
): { ok: true; modelKey: string; entry: ModelPriceEntry } | { ok: false; error: string } {
  const modelKey = draft.modelKey.trim();
  if (!modelKey) return { ok: false, error: 'Model key is required (provider:model)' };
  if (!/^[^:\s]+:\S+$/.test(modelKey)) {
    return { ok: false, error: 'Model key must be "provider:model", e.g. "openrouter:deepseek/deepseek-chat"' };
  }
  const input = parseRequiredPrice('Input', draft.input);
  if ('error' in input) return { ok: false, error: input.error };
  const output = parseRequiredPrice('Output', draft.output);
  if ('error' in output) return { ok: false, error: output.error };
  const cacheRead = parsePriceField('Cache read', draft.cacheRead);
  if (cacheRead.error) return { ok: false, error: cacheRead.error };
  const cacheWrite = parsePriceField('Cache write', draft.cacheWrite);
  if (cacheWrite.error) return { ok: false, error: cacheWrite.error };
  return {
    ok: true,
    modelKey,
    entry: {
      input: input.value,
      output: output.value,
      ...(cacheRead.value !== undefined ? { cacheRead: cacheRead.value } : {}),
      ...(cacheWrite.value !== undefined ? { cacheWrite: cacheWrite.value } : {}),
    },
  };
}

/** New table with one entry set (add or replace). Never mutates the input. */
export function upsertModelPrice(table: ModelPriceTable, modelKey: string, entry: ModelPriceEntry): ModelPriceTable {
  return { ...table, [modelKey]: entry };
}

/** New table with one entry removed. Never mutates the input. */
export function removeModelPrice(table: ModelPriceTable, modelKey: string): ModelPriceTable {
  return Object.fromEntries(Object.entries(table).filter(([key]) => key !== modelKey));
}

/** Stable row order for rendering: alphabetical by model key. */
export function modelPriceRows(table: ModelPriceTable): { modelKey: string; entry: ModelPriceEntry }[] {
  return Object.keys(table)
    .sort((a, b) => a.localeCompare(b))
    .map((modelKey) => ({ modelKey, entry: table[modelKey] }));
}

/** Compact "in $X / out $Y" summary for a table row. */
export function modelPriceSummary(entry: ModelPriceEntry): string {
  const parts = [`in $${entry.input}`, `out $${entry.output}`];
  if (entry.cacheRead !== undefined) parts.push(`cache read $${entry.cacheRead}`);
  if (entry.cacheWrite !== undefined) parts.push(`cache write $${entry.cacheWrite}`);
  return `${parts.join(' · ')} per 1M tokens`;
}
