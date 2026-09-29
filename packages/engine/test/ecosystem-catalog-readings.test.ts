/**
 * ecosystem-catalog-readings.test.ts
 *
 * Catalog search and review. Which entries answer a search query is the
 * `engine.ecosystem.catalog-search` reading, one request per entry; whether a
 * trust note raises the risk label is the `engine.ecosystem.trust-note-caution`
 * reading. Pins that a blank query and a note-free or remote entry ask
 * nothing, that only strong readings act (a strong no hides a search row, a
 * strong yes raises the risk), that kept rows stay in name order, that
 * install takes no reading, and that a read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  installEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  searchEcosystemCatalog,
  upsertEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
} from '../sdk/src/platform/runtime/ecosystem/catalog.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

type SearchState = { readonly query: string; readonly entry: { readonly id: string } };
type NoteState = { readonly name: string; readonly trustNotes: string };

/** A port answering one named question through `probability`, recording every request. */
function portFor<S>(question: string, probability: (state: S) => number) {
  return fakePort((name: string, _question: Question, state: EntryType) => {
    if (name !== question) throw new Error(`catalog port: unexpected question ${name}`);
    return noulAnswer(probability(state as unknown as S));
  });
}

function plugin(id: string, name: string, extra: Partial<EcosystemCatalogEntry> = {}): EcosystemCatalogEntry {
  return { id, kind: 'plugin', name, summary: `${name} summary`, source: 'catalog', tags: [], ...extra };
}

let options: { cwd: string; homeDir: string };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  const root = makeProjectTempDir('eco-catalog-');
  options = { cwd: root, homeDir: root };
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

describe('catalog search', () => {
  test('one request per entry; only a strong no hides a row; kept rows stay in name order', async () => {
    upsertEcosystemCatalogEntry(plugin('zeta', 'Zeta pull requests'), options);
    upsertEcosystemCatalogEntry(plugin('alpha', 'Alpha author stats'), options);
    upsertEcosystemCatalogEntry(plugin('mid', 'Mid code host'), options);
    const readings: Record<string, number> = { zeta: 0.9, alpha: 0.1, mid: 0.43 }; // mid is a weak no: kept
    const { port, requests } = portFor<SearchState>('wanted', (state) => readings[state.entry.id]!);
    installJudgmentPort(port);

    const found = await searchEcosystemCatalog('plugin', '  github ', options);
    expect(found.map((entry) => entry.id)).toEqual(['mid', 'zeta']);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => (request.state as unknown as SearchState).query)).toEqual(['github', 'github', 'github']);
  });

  test('the question sees the entry words, not its source', async () => {
    upsertEcosystemCatalogEntry(plugin('p', 'P', { source: '/secret/path', trustNotes: 'note', installHint: 'hint', tags: ['t'] }), options);
    const { port, requests } = portFor<SearchState>('wanted', () => 0.9);
    installJudgmentPort(port);
    await searchEcosystemCatalog('plugin', 'p', options);
    expect(requests[0]!.state).toEqual({
      query: 'p',
      entry: { kind: 'plugin', id: 'p', name: 'P', summary: 'P summary', tags: ['t'], installHint: 'hint', trustNotes: 'note' },
    });
  });

  test('a blank query lists every entry and asks nothing', async () => {
    upsertEcosystemCatalogEntry(plugin('b', 'Beta'), options);
    upsertEcosystemCatalogEntry(plugin('a', 'Alpha'), options);
    const { port, requests } = portFor<SearchState>('wanted', () => 0.1);
    installJudgmentPort(port);
    expect((await searchEcosystemCatalog('plugin', '   ', options)).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(requests).toHaveLength(0);
  });

  test('a search with no judgment port installed throws', async () => {
    upsertEcosystemCatalogEntry(plugin('a', 'Alpha'), options);
    await expect(searchEcosystemCatalog('plugin', 'alpha', options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('catalog review risk', () => {
  test('a strong yes on the trust note is medium; a weak yes or a no stays low', async () => {
    const readings: Record<string, number> = { warns: 0.9, weak: 0.57, reassures: 0.1 };
    const { port, requests } = portFor<NoteState>('cautions', (state) => readings[state.name]!);
    installJudgmentPort(port);

    expect((await reviewEcosystemCatalogEntry(plugin('w', 'warns', { trustNotes: 'Runs shell commands unasked.' }), options)).riskLevel).toBe('medium');
    expect((await reviewEcosystemCatalogEntry(plugin('k', 'weak', { trustNotes: 'Beta quality.' }), options)).riskLevel).toBe('low');
    expect((await reviewEcosystemCatalogEntry(plugin('r', 'reassures', { trustNotes: 'Maintained by the core team.' }), options)).riskLevel).toBe('low');
    expect(requests).toHaveLength(3);
    expect(requests[0]!.state).toEqual({ name: 'warns', kind: 'plugin', trustNotes: 'Runs shell commands unasked.' });
  });

  test('no trust note, or a remote source, asks nothing; remote is medium', async () => {
    const { port, requests } = portFor<NoteState>('cautions', () => 0.9);
    installJudgmentPort(port);
    expect((await reviewEcosystemCatalogEntry(plugin('a', 'A'), options)).riskLevel).toBe('low');
    expect((await reviewEcosystemCatalogEntry(plugin('b', 'B', { trustNotes: '  ' }), options)).riskLevel).toBe('low');
    const remote = await reviewEcosystemCatalogEntry(plugin('c', 'C', { source: 'git+https://example.com/c.git', trustNotes: 'Unreviewed.' }), options);
    expect(remote.riskLevel).toBe('medium');
    expect(remote.sourceKind).toBe('remote');
    expect(requests).toHaveLength(0);
  });

  test('a review of a noted entry with no judgment port installed throws', async () => {
    await expect(reviewEcosystemCatalogEntry(plugin('a', 'A', { trustNotes: 'Unreviewed.' }), options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('install takes no reading, even for an entry with a trust note', () => {
    const source = join(options.cwd, 'noted-source');
    mkdirSync(source);
    upsertEcosystemCatalogEntry(plugin('noted', 'Noted', { source, trustNotes: 'Unreviewed third-party code.' }), options);
    expect(installEcosystemCatalogEntry('plugin', 'noted', options).ok).toBe(true);
  });
});
