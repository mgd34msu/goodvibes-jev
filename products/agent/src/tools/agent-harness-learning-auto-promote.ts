import type { CommandContext } from '../input/command-registry.ts';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { ShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../agent/skill-registry.ts';
import { runSkillDraftProposer } from '../agent/skill-draft-runner.ts';
import { buildLearningCandidates } from './agent-harness-learning-curator-proposals.ts';
import type { LearningCandidate } from './agent-harness-learning-curator-types.ts';
import {
  deleteDuplicate,
  domainForCandidate,
  markDuplicateStale,
  updateSurvivor,
} from './agent-learning-consolidation-core.ts';
import type { MemoryRegistry } from '@goodvibes-jev/engine/sdk/platform/state';

const AUTO_PROMOTE_PROVENANCE = 'learning-curator-auto-promote';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AutoPromoteResult {
  /** Total candidates seen as ready-to-promote or needs-consolidation. */
  readonly eligible: number;
  /** Records successfully promoted this pass. */
  readonly promoted: number;
  /** Candidates skipped due to errors, missing data, or secret-scan rejection. */
  readonly skipped: number;
  /** Duplicate records consolidated (staled + deleted). */
  readonly consolidated: number;
  /** Per-domain breakdown. */
  readonly domains: Record<string, number>;
  /** Brief log lines for each promoted or consolidated item. */
  readonly log: readonly string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractProposalFields(
  candidate: LearningCandidate,
): Record<string, string> {
  return candidate.proposalFields ?? {};
}

async function tryPromoteMemory(
  memoryApi: MemoryApi,
  candidate: LearningCandidate,
): Promise<string> {
  const fields = extractProposalFields(candidate);
  const summary = (fields.summary ?? fields.detail ?? candidate.label).trim();
  if (!summary) throw new Error('Missing summary for memory candidate.');
  const detail = (fields.detail ?? '').trim();
  const cls = (fields.cls ?? 'fact').trim() as Parameters<typeof memoryApi.add>[0]['cls'];
  const scope = (fields.scope ?? 'project').trim() as Parameters<typeof memoryApi.add>[0]['scope'];
  const tags = fields.tags
    ? fields.tags.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  // assertNoSecretLikeText is called inside memoryApi.add
  const record = await memoryApi.add({
    scope,
    cls,
    summary,
    detail,
    tags,
    provenance: [{ kind: 'event', ref: AUTO_PROMOTE_PROVENANCE }],
  });
  return `memory:${record.id}  ${summary.slice(0, 60)}`;
}

function tryPromotePersona(
  shellPaths: ShellPathService,
  candidate: LearningCandidate,
): string {
  const fields = extractProposalFields(candidate);
  const name = (fields.name ?? candidate.label).trim();
  if (!name) throw new Error('Missing name for persona candidate.');
  const description = (fields.description ?? name).trim();
  const body = (fields.body ?? fields.detail ?? '').trim();
  if (!body) throw new Error('Missing body for persona candidate.');
  const triggers = fields.triggers
    ? fields.triggers.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  const tags = fields.tags
    ? fields.tags.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  // assertNoSecretLikeText is called inside AgentPersonaRegistry.create
  const record = AgentPersonaRegistry.fromShellPaths(shellPaths).create({
    name,
    description,
    body,
    triggers,
    tags,
    source: 'agent',
    provenance: AUTO_PROMOTE_PROVENANCE,
  });
  return `persona:${record.id}  ${name.slice(0, 60)}`;
}

function tryPromoteRoutine(
  shellPaths: ShellPathService,
  candidate: LearningCandidate,
): string {
  const fields = extractProposalFields(candidate);
  const name = (fields.name ?? candidate.label).trim();
  if (!name) throw new Error('Missing name for routine candidate.');
  const description = (fields.description ?? name).trim();
  const steps = (fields.steps ?? fields.notes ?? fields.detail ?? '').trim();
  if (!steps) throw new Error('Missing steps for routine candidate.');
  const triggers = fields.triggers
    ? fields.triggers.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  const tags = fields.tags
    ? fields.tags.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  // assertNoSecretLikeText is called inside AgentRoutineRegistry.create
  const record = AgentRoutineRegistry.fromShellPaths(shellPaths).create({
    name,
    description,
    steps,
    triggers,
    tags,
    enabled: true,
    source: 'agent',
    provenance: AUTO_PROMOTE_PROVENANCE,
  });
  return `routine:${record.id}  ${name.slice(0, 60)}`;
}

/**
 * Consolidate a duplicate candidate for non-memory domains (persona/skill/routine).
 * Memory domain consolidation is skipped here because it requires MemoryRegistry,
 * which is not accessible from CommandContext (it is a service-level dependency).
 */
function tryConsolidateNonMemoryCandidate(
  shellPaths: ShellPathService,
  candidate: LearningCandidate,
): readonly string[] {
  const plan = candidate.consolidation;
  if (!plan) throw new Error('No consolidation plan on candidate.');
  const domain = domainForCandidate(candidate);

  // Use a no-op MemoryRegistry sentinel, it is never called because domain
  // is already checked above (domainForCandidate throws for non-consolidatable domains).
  const nullMemory = null as unknown as MemoryRegistry;
  const lines: string[] = [];

  if (plan.updateFields) {
    updateSurvivor(shellPaths, nullMemory, domain, plan.survivorId, plan.updateFields);
    lines.push(`merged survivor ${domain}:${plan.survivorId}`);
  }

  for (const dupId of plan.duplicateIds) {
    try {
      markDuplicateStale(shellPaths, nullMemory, domain, dupId, plan.survivorId);
      deleteDuplicate(shellPaths, nullMemory, domain, dupId);
      lines.push(`consolidated duplicate ${domain}:${dupId} -> ${plan.survivorId}`);
    } catch (err) {
      lines.push(`skipped duplicate ${domain}:${dupId}: ${String(err)}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Run the promotion pass. Promotes `ready-to-promote` candidates and resolves
 * `needs-consolidation` duplicates (non-memory domains).
 *
 * The caller (agent_harness mode:"learning_auto_promote") gates this pass behind
 * an explicit user request plus confirm:true, because it creates and deletes
 * memory records, personas, and routines. This function assumes that gate has
 * already been cleared.
 *
 * Secret scanning is enforced by each registry's create() method, this
 * function does NOT bypass it.
 *
 * Memory domain consolidation is intentionally skipped: MemoryRegistry is a
 * service-level dependency not available in CommandContext. Memory promotions
 * (new records from proposal candidates) ARE supported via MemoryApi.
 */
export async function runAutoPromoter(
  context: CommandContext,
  skillRegistry: AgentSkillRegistry,
  memoryApi: MemoryApi,
): Promise<AutoPromoteResult> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      eligible: 0,
      promoted: 0,
      skipped: 0,
      consolidated: 0,
      domains: {},
      log: ['No active workspace; promotion skipped.'],
    };
  }

  const all = buildLearningCandidates(context);
  const promotionCandidates = all.filter((c) => c.status === 'ready-to-promote');
  // Only consolidate non-memory domains (MemoryRegistry not available here)
  const consolidationCandidates = all.filter(
    (c) => c.status === 'needs-consolidation' && c.consolidation !== undefined && c.domain !== 'memory',
  );
  const eligible = promotionCandidates.length + consolidationCandidates.length;

  const log: string[] = [];
  const domains: Record<string, number> = {};
  let promoted = 0;
  let skipped = 0;
  let consolidated = 0;

  function bump(domain: string): void {
    domains[domain] = (domains[domain] ?? 0) + 1;
  }

  // --- Skill promotions via runSkillDraftProposer (handles dedup + ledger) ---
  const skillResult = runSkillDraftProposer(context, skillRegistry);
  if (skillResult.proposed > 0) {
    for (const entry of skillResult.entries) {
      log.push(`promoted skill:${entry.skillId}  ${entry.name}`);
      bump('skill');
    }
    promoted += skillResult.proposed;
  }
  skipped += skillResult.skipped;

  // --- Non-skill ready-to-promote candidates ---
  for (const candidate of promotionCandidates) {
    if (candidate.proposalTarget === 'skill') continue; // handled above

    try {
      let line: string;
      switch (candidate.proposalTarget) {
        case 'memory': {
          line = await tryPromoteMemory(memoryApi, candidate);
          promoted += 1;
          bump('memory');
          break;
        }
        case 'persona': {
          line = tryPromotePersona(shellPaths, candidate);
          promoted += 1;
          bump('persona');
          break;
        }
        case 'routine': {
          line = tryPromoteRoutine(shellPaths, candidate);
          promoted += 1;
          bump('routine');
          break;
        }
        default: {
          // No create path for this target (e.g. notes-to-knowledge is a
          // workspace action that requires a browser session, skip it).
          skipped += 1;
          continue;
        }
      }
      log.push(`promoted ${line}`);
    } catch (err) {
      log.push(`skipped ${candidate.label}: ${String(err)}`);
      skipped += 1;
    }
  }

  // --- Non-memory consolidation candidates ---
  for (const candidate of consolidationCandidates) {
    try {
      const lines = tryConsolidateNonMemoryCandidate(shellPaths, candidate);
      const dupeCount = candidate.consolidation?.duplicateIds.length ?? 0;
      consolidated += dupeCount;
      promoted += dupeCount;
      bump(candidate.domain);
      log.push(...lines);
    } catch (err) {
      log.push(`skipped ${candidate.label}: ${String(err)}`);
      skipped += 1;
    }
  }

  return { eligible, promoted, skipped, consolidated, domains, log };
}
