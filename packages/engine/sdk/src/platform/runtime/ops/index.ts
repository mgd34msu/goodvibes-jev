/**
 * Operational runbook registry for the GoodVibes platform runtime.
 *
 * Provides a machine-readable playbook registry consumed by the diagnostics
 * panel. Each playbook describes symptoms, diagnostic checks, resolution
 * steps, and escalation criteria for a specific failure scenario.
 *
 * @example
 * ```ts
 * import { getPlaybookRegistry, getPlaybook } from './index.js';
 *
 * const registry = getPlaybookRegistry();
 * const playbook = getPlaybook('stuck-turn');
 * if (playbook) {
 *   for (const check of playbook.checks) {
 *     const result = await check.run();
 *     console.log(check.label, result.passed ? 'PASS' : 'FAIL', result.summary);
 *   }
 * }
 * ```
 */

// Re-export types
export type {
  DiagnosticSeverity,
  DiagnosticCheckResult,
  DiagnosticCheck,
  PlaybookStepKind,
  PlaybookStep,
  Playbook,
  PlaybookRegistryEntry,
  PlaybookRegistry,
} from './types.js';

// Re-export all playbooks
export {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from './playbooks/index.js';

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Playbook, PlaybookRegistry, PlaybookRegistryEntry } from './types.js';
import { playbookCandidate, playbookSearch } from './batteries/playbook-search.js';
import {
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
} from './playbooks/index.js';

/** All registered playbooks in definition order. */
const ALL_PLAYBOOKS: readonly Playbook[] = [
  stuckTurnPlaybook,
  reconnectFailurePlaybook,
  permissionDeadlockPlaybook,
  pluginDegradationPlaybook,
  exportRecoveryPlaybook,
  sessionUnrecoverablePlaybook,
  compactionFailurePlaybook,
] as const;

/** Registry version, bump when playbooks are added or updated. */
export const REGISTRY_VERSION = '1.0.0';

/**
 * Build and return the playbook registry.
 *
 * The registry is a Map keyed by playbook ID for O(1) lookup.
 */
export function getPlaybookRegistry(): PlaybookRegistry {
  const registry: PlaybookRegistry = new Map<string, PlaybookRegistryEntry>();
  for (const playbook of ALL_PLAYBOOKS) {
    registry.set(playbook.id, {
      playbook,
      version: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
    });
  }
  return registry;
}

/**
 * Look up a single playbook by ID.
 *
 * @param id - The playbook ID (e.g. 'stuck-turn').
 * @returns The playbook, or undefined if not found.
 */
export function getPlaybook(id: string): Playbook | undefined {
  return ALL_PLAYBOOKS.find((p) => p.id === id);
}

/**
 * Find playbooks whose tags overlap with the provided set.
 *
 * @param tags - One or more tag strings to match.
 * @returns Playbooks that have at least one matching tag.
 */
export function findPlaybooksByTag(...tags: string[]): Playbook[] {
  const tagSet = new Set(tags);
  return ALL_PLAYBOOKS.filter((p) => p.tags.some((t) => tagSet.has(t)));
}

/** Decision site for the symptom search. */
export const PLAYBOOK_SEARCH_SITE = 'runtime.ops.playbook-search';

/**
 * Find the playbooks that address a symptom described in free text.
 *
 * Each playbook is read against the query by Jev (`engine.ops.playbook-search`,
 * the rerank pattern, one request per playbook); a playbook is returned when
 * the reading is a confident yes.
 *
 * @param query - The symptom in the operator's own words.
 * @returns Matching playbooks, best match first.
 */
export async function findPlaybooksBySymptom(query: string, options: { signal?: AbortSignal } = {}): Promise<Playbook[]> {
  const { ranked } = await playbookSearch.rerank(
    judgmentPort(PLAYBOOK_SEARCH_SITE),
    query,
    ALL_PLAYBOOKS.map(playbookCandidate),
    { site: PLAYBOOK_SEARCH_SITE, ...(options.signal ? { signal: options.signal } : {}) },
  );
  const byId = new Map(ALL_PLAYBOOKS.map((p) => [p.id, p]));
  return ranked.filter((r) => r.reading.verdict === 'yes').map((r) => byId.get(r.id)!);
}
