/**
 * ecosystem-recommendations.test.ts
 *
 * Marketplace recommendations: which needs are live is code (installed
 * counts, three or more denials, MCP servers waiting on auth); which
 * uninstalled entries answer a need is the `engine.ecosystem.recommendation-fit`
 * reading, one request per (need, entry) pair. Pins that only strong yes
 * readings recommend, the order by probability, dedupe and the cap, the
 * wording carried through, and that a read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  buildEcosystemRecommendations,
  collectRecommendationCandidates,
  MAX_RECOMMENDATIONS,
} from '../sdk/src/platform/runtime/ecosystem/recommendations.ts';
import { RECOMMENDATION_NEEDS } from '../sdk/src/platform/runtime/ecosystem/batteries/recommendation-fit.ts';
import {
  installEcosystemCatalogEntry,
  upsertEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from '../sdk/src/platform/runtime/ecosystem/catalog.ts';
import type { RuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createSystemObservabilityReadModels } from '../sdk/src/platform/runtime/ui-read-models-observability-system.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

type FitState = { readonly need: string; readonly entry: { readonly id: string } };

/** A port reading each (need, entry) pair through `probability`, recording every request. */
function fitPort(probability: (state: FitState) => number) {
  return fakePort((name: string, _question: Question, state: EntryType) => {
    if (name !== 'helps') throw new Error(`recommendation port: unexpected question ${name}`);
    return noulAnswer(probability(state as unknown as FitState));
  });
}

function storeWith(denialCount: number, authRequired: number): RuntimeStore {
  const servers = new Map(Array.from({ length: authRequired }, (_, i) => [`s${i}`, { status: 'auth_required' }]));
  return { getState: () => ({ permissions: { denialCount }, mcp: { servers } }) } as unknown as RuntimeStore;
}

function entry(kind: EcosystemEntryKind, id: string): EcosystemCatalogEntry {
  return { id, kind, name: id, summary: `${id} summary`, source: 'catalog', tags: [] };
}

let options: { cwd: string; homeDir: string };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  const root = makeProjectTempDir('eco-rec-');
  options = { cwd: root, homeDir: root };
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

describe('live needs', () => {
  test('each trigger condition adds its need, in the listed order, with only uninstalled entries', () => {
    const source = join(options.cwd, 'p1-source');
    mkdirSync(source);
    upsertEcosystemCatalogEntry({ ...entry('plugin', 'p1'), source }, options);
    upsertEcosystemCatalogEntry(entry('plugin', 'p2'), options);
    upsertEcosystemCatalogEntry(entry('policy-pack', 'strict'), options);
    upsertEcosystemCatalogEntry(entry('hook-pack', 'oauth'), options);

    expect(collectRecommendationCandidates(storeWith(2, 0), options).map((c) => c.need)).toEqual(['pluginPosture', 'skillPosture']);
    const all = collectRecommendationCandidates(storeWith(3, 2), options);
    expect(all.map((c) => c.need)).toEqual(['pluginPosture', 'skillPosture', 'policyPosture', 'mcpAuthHooks', 'mcpAuthPlugins']);
    expect(all.find((c) => c.need === 'mcpAuthHooks')!.reason).toBe('2 MCP servers require authentication or reconnect help.');

    expect(installEcosystemCatalogEntry('plugin', 'p1', options).ok).toBe(true);
    const afterInstall = collectRecommendationCandidates(storeWith(0, 1), options);
    expect(afterInstall.map((c) => c.need)).toEqual(['skillPosture', 'mcpAuthHooks', 'mcpAuthPlugins']);
    expect(afterInstall.find((c) => c.need === 'mcpAuthPlugins')!.entries.map((e) => e.id)).toEqual(['p2']);
    expect(afterInstall.find((c) => c.need === 'mcpAuthPlugins')!.reason).toBe('1 MCP server require authentication or reconnect help.');
  });
});

describe('ranking', () => {
  test('one request per pair; only strong yes readings recommend, best first, one per entry', async () => {
    for (const id of ['github', 'theme', 'bridge']) upsertEcosystemCatalogEntry(entry('plugin', id), options);
    const readings: Record<string, number> = {
      [`${RECOMMENDATION_NEEDS.pluginPosture}|github`]: 0.8,
      [`${RECOMMENDATION_NEEDS.pluginPosture}|theme`]: 0.57, // a yes, but not strong enough to act on
      [`${RECOMMENDATION_NEEDS.pluginPosture}|bridge`]: 0.7,
      [`${RECOMMENDATION_NEEDS.mcpAuthPlugins}|bridge`]: 0.95,
      [`${RECOMMENDATION_NEEDS.mcpAuthPlugins}|github`]: 0.2,
      [`${RECOMMENDATION_NEEDS.mcpAuthPlugins}|theme`]: 0.1,
    };
    const { port, requests } = fitPort((state) => readings[`${state.need}|${state.entry.id}`] ?? 0.05);
    installJudgmentPort(port);
    upsertEcosystemCatalogEntry(entry('skill', 'review'), options);

    const recommendations = await buildEcosystemRecommendations(storeWith(0, 1), options);
    // plugin posture 3 + skill posture 1 + hook-pack 0 + MCP plugins 3
    expect(requests).toHaveLength(7);
    expect(recommendations.map((r) => [r.id, r.title])).toEqual([
      ['plugin:bridge', 'Review MCP-aware plugins'],
      ['plugin:github', 'Seed the plugin posture'],
    ]);
    expect(recommendations[0]!.command).toBe('/marketplace review plugin bridge');
    expect(recommendations[0]!.reason).toBe('1 MCP server require authentication or reconnect help.');
    expect(recommendations[1]!.reason).toBe('No curated plugins are installed yet. Start with a project-scoped integration or workflow plugin.');
  });

  test('at most MAX_RECOMMENDATIONS', async () => {
    for (let i = 0; i < 12; i++) upsertEcosystemCatalogEntry(entry('plugin', `p${String(i).padStart(2, '0')}`), options);
    installJudgmentPort(fitPort(() => 0.9).port);
    const recommendations = await buildEcosystemRecommendations(storeWith(0, 0), options);
    expect(recommendations).toHaveLength(MAX_RECOMMENDATIONS);
  });

  test('no live need or no candidate entries asks nothing', async () => {
    const { port, requests } = fitPort(() => 0.9);
    installJudgmentPort(port);
    expect(await buildEcosystemRecommendations(storeWith(0, 0), options)).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  test('a read with no judgment port installed throws', async () => {
    upsertEcosystemCatalogEntry(entry('plugin', 'github'), options);
    await expect(buildEcosystemRecommendations(storeWith(0, 0), options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('marketplace read model', () => {
  test('the snapshot carries the last ranking; a new ranking starts only when the needs or entries change', async () => {
    upsertEcosystemCatalogEntry(entry('plugin', 'github'), options);
    const { port, requests } = fitPort(() => 0.9);
    installJudgmentPort(port);
    const store = storeWith(0, 0);
    const runtimeStore = {
      getState: () => ({ ...(store.getState() as object), mcp: { servers: new Map() } }),
      subscribe: () => () => {},
    };
    const services = {
      runtimeStore,
      shellPaths: { workingDirectory: options.cwd, homeDirectory: options.homeDir },
    } as unknown as Parameters<typeof createSystemObservabilityReadModels>[0];
    const { marketplace } = createSystemObservabilityReadModels(services);

    let notified = 0;
    const settled = new Promise<void>((resolve) => {
      marketplace.subscribe(() => {
        notified++;
        resolve();
      });
    });
    expect(marketplace.getSnapshot().recommendations).toEqual([]);
    await settled;
    expect(notified).toBe(1);
    expect(marketplace.getSnapshot().recommendations.map((r) => r.id)).toEqual(['plugin:github']);
    expect(requests).toHaveLength(1);

    upsertEcosystemCatalogEntry(entry('plugin', 'bridge'), options);
    marketplace.getSnapshot();
    expect(requests).toHaveLength(3);
  });
});
