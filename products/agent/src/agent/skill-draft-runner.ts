import { existsSync, readFileSync } from 'node:fs';
import { writeStoreJson } from '@/utils/store-file.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { buildLearningCandidates } from '../tools/agent-harness-learning-curator-proposals.ts';
import type { AgentSkillRegistry } from './skill-registry.ts';
import { proposeSkillDrafts } from './skill-draft-proposer.ts';
import type { SkillDraftPayload } from './skill-draft-proposer.ts';

// ---------------------------------------------------------------------------
// Ledger types
// ---------------------------------------------------------------------------

export interface SkillDraftLedgerEntry {
  /** Stable ledger entry id, matches the persisted skill id assigned by the registry. */
  readonly skillId: string;
  /** Kebab-slug name of the proposed skill. */
  readonly name: string;
  /** Learning candidate that originated this proposal. */
  readonly candidateId: string;
  /** ISO timestamp when the draft was proposed. */
  readonly proposedAt: string;
}

interface SkillDraftLedgerFile {
  readonly version: 1;
  readonly entries: readonly SkillDraftLedgerEntry[];
}

const LEDGER_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SkillDraftRunResult {
  /** Number of new draft skills persisted this pass. */
  readonly proposed: number;
  /** Number of candidates that were eligible but skipped (dedup / secret). */
  readonly skipped: number;
  /** Entries written to the ledger this pass. */
  readonly entries: readonly SkillDraftLedgerEntry[];
  /** Skill ids created this pass. */
  readonly skillIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Ledger I/O
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLedger(ledgerPath: string): SkillDraftLedgerFile {
  if (!existsSync(ledgerPath)) return { version: LEDGER_VERSION, entries: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    if (!isRecord(raw)) return { version: LEDGER_VERSION, entries: [] };
    const entries = Array.isArray(raw.entries)
      ? (raw.entries as unknown[])
          .filter(isRecord)
          .filter(
            (e): e is Record<string, string> =>
              typeof e.skillId === 'string' &&
              typeof e.name === 'string' &&
              typeof e.candidateId === 'string' &&
              typeof e.proposedAt === 'string',
          )
          .map((e) => ({
            skillId: e.skillId,
            name: e.name,
            candidateId: e.candidateId,
            proposedAt: e.proposedAt,
          } satisfies SkillDraftLedgerEntry))
      : [];
    return { version: LEDGER_VERSION, entries };
  } catch {
    return { version: LEDGER_VERSION, entries: [] };
  }
}

function writeLedger(ledgerPath: string, file: SkillDraftLedgerFile): void {
  writeStoreJson(ledgerPath, file);
}

// ---------------------------------------------------------------------------
// Ledger path resolution
// ---------------------------------------------------------------------------

/**
 * Derive the ledger path from the registry's skills store path, placing the
 * ledger file as a sibling: `.../skills/skill-draft-ledger.json`.
 */
function ledgerPathFromRegistry(registry: AgentSkillRegistry): string {
  // AgentSkillRegistry exposes the store path via snapshot().path
  const snapshot = registry.snapshot();
  return snapshot.path.replace(/skills\.json$/, 'skill-draft-ledger.json');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run one skill-draft-proposal pass.
 *
 * 1. Builds learning candidates from the current CommandContext.
 * 2. Loads existing skill names and ledger (previously proposed names).
 * 3. Calls proposeSkillDrafts (pure).
 * 4. Persists each accepted draft via registry.create().
 * 5. Appends new entries to the ledger.
 *
 * Returns a result summary. Never throws on partial failure, errors for
 * individual proposals are caught so one bad candidate does not abort the pass.
 */
export function runSkillDraftProposer(
  context: CommandContext,
  registry: AgentSkillRegistry,
): SkillDraftRunResult {
  const ledgerPath = ledgerPathFromRegistry(registry);
  const ledger = readLedger(ledgerPath);

  // Build name sets for dedup
  const existingSkillNames = new Set(
    registry.list().map((s) => s.name.trim().toLowerCase()),
  );
  const previouslyProposedNames = new Set(
    ledger.entries.map((e) => e.name.trim().toLowerCase()),
  );

  // Gather candidates from the live learning curator
  const candidates = buildLearningCandidates(context);

  // Count eligible before calling proposer so we can report skipped
  const eligibleCount = candidates.filter(
    (c) =>
      (c.status === 'proposal-ready' || c.status === 'ready-to-promote') &&
      c.proposalTarget === 'skill',
  ).length;

  const drafts = proposeSkillDrafts({ candidates, existingSkillNames, previouslyProposedNames });

  const newEntries: SkillDraftLedgerEntry[] = [];
  const skillIds: string[] = [];

  for (const draft of drafts) {
    try {
      const skill = registry.create({
        name: draft.name,
        description: draft.description,
        procedure: draft.procedure,
        triggers: draft.triggers,
        tags: draft.tags,
        requirements: draft.requirements,
        enabled: false, // hard rule: drafts are never auto-enabled
        source: 'agent',
        provenance: draft.provenance,
      });
      const entry: SkillDraftLedgerEntry = {
        skillId: skill.id,
        name: skill.name,
        candidateId: draft.candidateId,
        proposedAt: new Date().toISOString(),
      };
      newEntries.push(entry);
      skillIds.push(skill.id);
    } catch {
      // Individual failures (e.g. name collision race) do not abort the pass
    }
  }

  if (newEntries.length > 0) {
    writeLedger(ledgerPath, {
      version: LEDGER_VERSION,
      entries: [...ledger.entries, ...newEntries],
    });
  }

  return {
    proposed: newEntries.length,
    // skipped = eligible candidates that were not persisted (dedup + secret + cap + individual failures)
    skipped: eligibleCount - newEntries.length,
    entries: newEntries,
    skillIds,
  };
}

// ---------------------------------------------------------------------------
// Ledger read helper, for harness tool inspection
// ---------------------------------------------------------------------------

/**
 * Read the current ledger for inspection without running a proposal pass.
 */
export function readSkillDraftLedger(registry: AgentSkillRegistry): readonly SkillDraftLedgerEntry[] {
  const ledgerPath = ledgerPathFromRegistry(registry);
  return readLedger(ledgerPath).entries;
}
