import { assertNoSecretLikeText } from './persona-registry.ts';
import type { LearningCandidate } from '../tools/agent-harness-learning-curator-types.ts';
import type { AgentSkillCreateInput } from './skill-registry-types.ts';

/**
 * The create-input payload produced for each proposed skill draft.
 * Passed directly to AgentSkillRegistry.create().
 */
export interface SkillDraftPayload extends AgentSkillCreateInput {
  /** Candidate that originated this draft, for ledger bookkeeping. */
  readonly candidateId: string;
  /** Human-readable label carried from the learning candidate. */
  readonly candidateLabel: string;
}

export interface ProposeSkillDraftsInput {
  /** Full ranked candidate list from buildLearningCandidates. */
  readonly candidates: readonly LearningCandidate[];
  /** Lower-cased name set of skills already in the registry (dedup guard). */
  readonly existingSkillNames: ReadonlySet<string>;
  /** Lower-cased name set of skills proposed in earlier passes (dedup guard). */
  readonly previouslyProposedNames: ReadonlySet<string>;
}

/** Maximum draft proposals emitted per pass. */
const MAX_PROPOSALS = 3;

const PROVENANCE = 'auto-proposed-skill-draft';

/** Convert an arbitrary string to a URL-safe kebab-case slug. */
function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

/**
 * Extract a one-line description from the proposalFields carried on the candidate.
 * Prefers an explicit `description` field; falls back to the candidate label.
 */
function extractDescription(candidate: LearningCandidate): string {
  const fields = candidate.proposalFields ?? {};
  const desc = (fields.description ?? '').trim();
  if (desc) return desc.split('\n')[0]?.trim() || desc;
  return candidate.label.split('->')[0]?.trim() || candidate.label;
}

/**
 * Build a stepwise procedure body from available candidate evidence.
 * Uses proposalFields.notes / detail / triggers when present.
 */
function buildProcedureBody(candidate: LearningCandidate): string {
  const fields = candidate.proposalFields ?? {};
  const sections: string[] = [];

  // Context block, reason and source
  sections.push(`# ${extractDescription(candidate)}`);
  sections.push('');
  if (candidate.reason) {
    sections.push(`## Origin`);
    sections.push(candidate.reason.trim());
    sections.push('');
  }

  // Triggers, derived from proposalFields.triggers or candidate.proposalTarget
  const triggerHint = (fields.triggers ?? '').trim();
  if (triggerHint) {
    sections.push(`## When to use`);
    sections.push(triggerHint);
    sections.push('');
  }

  // Steps / body, prefer notes, then detail
  const notes = (fields.notes ?? '').trim();
  const detail = (fields.detail ?? '').trim();
  const body = notes || detail;
  if (body) {
    sections.push(`## Steps`);
    sections.push(body);
    sections.push('');
  }

  // Tags / extra context
  const tags = (fields.tags ?? '').trim();
  if (tags) {
    sections.push(`## Tags`);
    sections.push(tags);
    sections.push('');
  }

  sections.push(`## Notes`);
  sections.push('This skill was auto-proposed from a learning candidate and created enabled. Refine steps or disable via the skill registry as needed.');

  return sections.join('\n').trim();
}

/**
 * Derive inferred trigger phrases from proposal fields and candidate metadata.
 */
function buildTriggers(candidate: LearningCandidate): readonly string[] {
  const fields = candidate.proposalFields ?? {};
  const raw = (fields.triggers ?? '').trim();
  if (!raw) return [];
  return raw
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Derive tags from proposal fields and provenance.
 */
function buildTags(candidate: LearningCandidate): readonly string[] {
  const fields = candidate.proposalFields ?? {};
  const raw = (fields.tags ?? '').trim();
  const base = raw
    ? raw.split(/[,;]+/).map((t) => t.trim()).filter(Boolean)
    : [];
  // Always include the auto-proposal marker so it's filterable
  if (!base.includes('auto-proposed')) base.push('auto-proposed');
  return base;
}

/**
 * Pure function: given the current learning candidates and name registries, select
 * up to MAX_PROPOSALS skill-worthy candidates and return their draft payloads.
 *
 * Hard rules:
 * - Only 'proposal-ready' or 'ready-to-promote' candidates with proposalTarget === 'skill'
 * - Max 3 proposals per pass
 * - Dedupe against existingSkillNames, previouslyProposedNames, and names proposed this pass
 *   (all comparisons use the kebab slug of the name, case-insensitive)
 * - Skip any candidate whose text fields contain secret-like content
 * - Skip any candidate whose derived name or description is empty
 * - All drafts are created with enabled: true (autonomous promotion; registry enforces reviewState 'fresh')
 */
export function proposeSkillDrafts(input: ProposeSkillDraftsInput): readonly SkillDraftPayload[] {
  const { candidates, existingSkillNames, previouslyProposedNames } = input;

  const proposals: SkillDraftPayload[] = [];
  // Within-pass dedup: track slugified names already proposed in this call.
  const proposedThisPass = new Set<string>();

  // Filter to skill-proposal candidates, sorted by priority desc (candidates
  // from buildLearningCandidates are already sorted but we enforce it here for
  // purity, the function should not depend on caller sort order).
  const eligible = [...candidates]
    .filter(
      (c) =>
        (c.status === 'proposal-ready' || c.status === 'ready-to-promote') &&
        c.proposalTarget === 'skill',
    )
    .sort((a, b) => b.priority - a.priority);

  for (const candidate of eligible) {
    if (proposals.length >= MAX_PROPOSALS) break;

    const description = extractDescription(candidate);
    // Guard: skip candidates whose description is empty after extraction.
    if (!description.trim()) continue;

    const rawName = description.slice(0, 120); // registry normalizes further
    // Guard: skip candidates whose derived name is empty.
    if (!rawName.trim()) continue;

    const name = slugify(rawName);
    const nameLower = name.toLowerCase(); // slugify already lowercases

    // Dedup against existing, previously proposed, and within-pass proposed.
    if (
      existingSkillNames.has(nameLower) ||
      previouslyProposedNames.has(nameLower) ||
      proposedThisPass.has(nameLower)
    ) continue;

    // Secret scan, skip candidate rather than throw, as individual dirty
    // candidates should not block the whole pass
    const procedure = buildProcedureBody(candidate);
    const triggers = buildTriggers(candidate);
    const tags = buildTags(candidate);
    const fieldsToScan = [name, description, procedure, ...triggers, ...tags];
    try {
      assertNoSecretLikeText(fieldsToScan, 'Skill draft proposer');
    } catch {
      continue;
    }

    proposedThisPass.add(nameLower);
    proposals.push({
      candidateId: candidate.id,
      candidateLabel: candidate.label,
      name,
      description,
      procedure,
      triggers: triggers.length > 0 ? triggers : undefined,
      tags: tags.length > 0 ? tags : undefined,
      enabled: true,
      source: 'agent',
      provenance: PROVENANCE,
    });
  }

  return proposals;
}
