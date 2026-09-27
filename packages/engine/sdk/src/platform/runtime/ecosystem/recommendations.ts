/**
 * Ecosystem recommendations. Which needs are live is code: no plugins
 * installed, no skills installed, three or more permission denials, MCP
 * servers waiting on auth. Which uninstalled catalog entries answer a live
 * need is read by Jev (`engine.ecosystem.recommendation-fit`), one yes/no per
 * (need, entry) pair. Only strong yes readings become recommendations,
 * ordered by the yes probability, deduplicated by entry and capped at
 * MAX_RECOMMENDATIONS.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import type { RuntimeStore } from '../store/index.js';
import {
  type EcosystemCatalogPathOptions,
  listInstalledEcosystemEntries,
  loadEcosystemCatalog,
  type EcosystemCatalogEntry,
  type EcosystemEntryKind,
} from './catalog.js';
import {
  RECOMMENDATION_NEEDS,
  recommendationEntryView,
  recommendationFit,
  type RecommendationNeed,
} from './batteries/recommendation-fit.js';

export interface EcosystemRecommendation {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
  readonly kind: EcosystemEntryKind;
  readonly entry: EcosystemCatalogEntry;
  readonly command: string;
}

/** Most recommendations one listing shows. */
export const MAX_RECOMMENDATIONS = 8;

/** Denials in one session that make the policy-pack need live. */
const DENIALS_FOR_POLICY_NEED = 3;

/** (need, entry) readings in flight at once. */
const FIT_CONCURRENCY = 8;

const RECOMMENDATION_SITE = 'runtime.ecosystem.recommendations';

/** One live need and the uninstalled catalog entries of the kind that could answer it. */
export interface RecommendationCandidates {
  readonly need: RecommendationNeed;
  readonly kind: EcosystemEntryKind;
  readonly title: string;
  readonly reason: string;
  readonly entries: readonly EcosystemCatalogEntry[];
}

function uninstalledEntries(kind: EcosystemEntryKind, options: EcosystemCatalogPathOptions): EcosystemCatalogEntry[] {
  const installed = new Set(listInstalledEcosystemEntries(kind, options).map((receipt) => receipt.entry.id));
  return loadEcosystemCatalog(kind, options).filter((entry) => !installed.has(entry.id));
}

/**
 * The live needs, in the order they have always been listed, each with the
 * uninstalled entries of its kind. Code only: counts and thresholds.
 */
export function collectRecommendationCandidates(
  runtimeStore: RuntimeStore | undefined,
  options: EcosystemCatalogPathOptions,
): RecommendationCandidates[] {
  const state = runtimeStore?.getState();
  const live: Array<Omit<RecommendationCandidates, 'entries'>> = [];

  if (listInstalledEcosystemEntries('plugin', options).length === 0) {
    live.push({
      need: 'pluginPosture',
      kind: 'plugin',
      title: 'Seed the plugin posture',
      reason: 'No curated plugins are installed yet. Start with a project-scoped integration or workflow plugin.',
    });
  }
  if (listInstalledEcosystemEntries('skill', options).length === 0) {
    live.push({
      need: 'skillPosture',
      kind: 'skill',
      title: 'Seed the skill posture',
      reason: 'No curated skills are installed yet. Add a skill pack that matches your project workflow.',
    });
  }
  if ((state?.permissions.denialCount ?? 0) >= DENIALS_FOR_POLICY_NEED) {
    live.push({
      need: 'policyPosture',
      kind: 'policy-pack',
      title: 'Review policy-pack options',
      reason: 'Repeated denials suggest a reusable policy pack or trust posture adjustment may help.',
    });
  }
  const authRequired = [...(state?.mcp.servers.values() ?? [])].filter((server) => server.status === 'auth_required').length;
  if (authRequired > 0) {
    const reason = `${authRequired} MCP server${authRequired === 1 ? '' : 's'} require authentication or reconnect help.`;
    live.push({ need: 'mcpAuthHooks', kind: 'hook-pack', title: 'Review MCP auth helpers', reason });
    live.push({ need: 'mcpAuthPlugins', kind: 'plugin', title: 'Review MCP-aware plugins', reason });
  }

  return live.map((candidate) => ({ ...candidate, entries: uninstalledEntries(candidate.kind, options) }));
}

/**
 * Asks, for every (need, entry) pair, whether installing the entry would help
 * with the need, and keeps the strong yes readings: best first, one
 * recommendation per entry (the one read most strongly), at most
 * MAX_RECOMMENDATIONS.
 */
export async function rankRecommendationCandidates(
  candidates: readonly RecommendationCandidates[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<EcosystemRecommendation[]> {
  const pairs = candidates.flatMap((candidate) => candidate.entries.map((entry) => ({ candidate, entry })));
  if (pairs.length === 0) return [];
  const port = judgmentPort(RECOMMENDATION_SITE);
  const run = { site: RECOMMENDATION_SITE, ...(options.signal ? { signal: options.signal } : {}) };

  const read = await mapLimit(pairs, FIT_CONCURRENCY, async ({ candidate, entry }) => {
    const fit = await recommendationFit.run(port, { need: RECOMMENDATION_NEEDS[candidate.need], entry: recommendationEntryView(entry) }, run);
    const reading = fit.readings.helps;
    const recommended = reading.verdict === 'yes' && reading.outcome === 'act';
    fit.recordAction(recommended ? 'recommended' : 'not-recommended');
    return { candidate, entry, probability: reading.probability, recommended };
  });

  const seen = new Set<string>();
  const recommendations: EcosystemRecommendation[] = [];
  for (const { candidate, entry } of read.filter((pair) => pair.recommended).sort((a, b) => b.probability - a.probability)) {
    const id = `${candidate.kind}:${entry.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    recommendations.push({
      id,
      title: candidate.title,
      reason: candidate.reason,
      kind: candidate.kind,
      entry,
      command: `/marketplace review ${candidate.kind} ${entry.id}`,
    });
    if (recommendations.length === MAX_RECOMMENDATIONS) break;
  }
  return recommendations;
}

export async function buildEcosystemRecommendations(
  runtimeStore: RuntimeStore | undefined,
  options: EcosystemCatalogPathOptions,
): Promise<EcosystemRecommendation[]> {
  return rankRecommendationCandidates(collectRecommendationCandidates(runtimeStore, options));
}
