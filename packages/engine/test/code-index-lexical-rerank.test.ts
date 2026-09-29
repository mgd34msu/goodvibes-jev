/**
 * code-index-lexical-rerank.test.ts
 *
 * CodeIndexStore's lexical search (used when the embedding provider no
 * longer matches the index): the SQL LIKE recall over symbol and path stays
 * code; the `engine.state.code-search` rerank orders the recalled chunks,
 * each read against its code (read back from the file), and chunks read as
 * not matching are left out. Pins the order, the drop, the limit, what the
 * rerank sees, and that a read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { CodeIndexStore } from '../sdk/src/platform/state/code-index-store.js';
import { MemoryEmbeddingProviderRegistry, embedMemoryText, type MemoryEmbeddingProvider } from '../sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

type PairState = { readonly query: string; readonly candidate: { readonly symbol?: string; readonly path: string; readonly code?: string } };

function provider(id: string): MemoryEmbeddingProvider {
  const embed = (text: string, dimensions: number) => ({ vector: embedMemoryText(text, dimensions), dimensions });
  return {
    id,
    label: `Test Provider ${id}`,
    dimensions: 384,
    deterministic: true,
    embedSync: (request) => embed(request.text, request.dimensions),
    embed: async (request) => embed(request.text, request.dimensions),
  };
}

let root: string;
let store: CodeIndexStore;
let previous: ReturnType<typeof installJudgmentPort>;

/** A store built under one provider and then switched to another, so search takes the lexical path. */
beforeEach(async () => {
  previous = installJudgmentPort(undefined);
  root = mkdtempSync(join(tmpdir(), 'gv-code-lexical-'));
  writeFileSync(join(root, 'retry.ts'), [
    'export function retryWithBackoff(fn: () => Promise<void>): Promise<void> {',
    '  return fn();',
    '}',
    '',
    "export const RETRY_LABEL = 'Retry';",
    '',
  ].join('\n'));
  writeFileSync(join(root, 'backoff-colors.ts'), "export const backoffColor = '#ccc';\n");
  writeFileSync(join(root, 'unrelated.ts'), 'export function parseConfig(): void {}\n');
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, '.config') }) });
  registry.register(provider('prov-x'), { makeDefault: true });
  store = new CodeIndexStore(root, ':memory:', registry);
  await store.init();
  await store.buildFull();
  registry.register(provider('prov-y'), { makeDefault: true });
  expect(store.stats().embeddingProviderMismatch).toBeDefined();
});

afterEach(() => {
  installJudgmentPort(previous);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function pairPort(probability: (state: PairState) => number) {
  return fakePort((name: string, _question, state: EntryType) => {
    if (name !== 'match') throw new Error(`code search port: unexpected question ${name}`);
    return noulAnswer(probability(state as unknown as PairState));
  });
}

describe('lexical code search', () => {
  test('recall is the symbol/path match; the rerank orders it and drops what it reads as not matching', async () => {
    const readings: Record<string, number> = { retryWithBackoff: 0.92, RETRY_LABEL: 0.5, backoffColor: 0.2 };
    const { port, requests } = pairPort((state) => readings[state.candidate.symbol ?? ''] ?? 0.1);
    installJudgmentPort(port);

    const hits = await store.search('retry backoff', { limit: 5 });

    // parseConfig shares no token with the query and is never recalled.
    const asked = requests.map((request) => (request.state as unknown as PairState).candidate.symbol).sort();
    expect(asked).toEqual(['RETRY_LABEL', 'backoffColor', 'retryWithBackoff']);
    // backoffColor (0.2) reads as a no and is left out; 0.5 is uncertain and stays.
    expect(hits.map((hit) => hit.chunk.symbol)).toEqual(['retryWithBackoff', 'RETRY_LABEL']);
    expect(hits.every((hit) => hit.label === 'lexical')).toBe(true);
    expect(hits[0]!.similarity).toBe(0.92);
    expect(hits[0]!.distance).toBeCloseTo(0.16, 10);
  });

  test("the rerank reads each chunk's code from its file", async () => {
    const { port, requests } = pairPort(() => 0.9);
    installJudgmentPort(port);
    await store.search('retryWithBackoff', { limit: 5 });
    const retry = requests.map((request) => (request.state as unknown as PairState)).find((state) => state.candidate.symbol === 'retryWithBackoff')!;
    expect(retry.query).toBe('retryWithBackoff');
    expect(retry.candidate.path).toBe('retry.ts');
    expect(retry.candidate.code).toContain('export function retryWithBackoff(fn: () => Promise<void>): Promise<void> {');
    expect(retry.candidate.code).not.toContain('RETRY_LABEL');
  });

  test('returns at most `limit` chunks', async () => {
    installJudgmentPort(pairPort(() => 0.9).port);
    expect(await store.search('retry backoff', { limit: 1 })).toHaveLength(1);
  });

  test('a read with no judgment port installed throws', async () => {
    await expect(store.search('retry backoff', { limit: 5 })).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
