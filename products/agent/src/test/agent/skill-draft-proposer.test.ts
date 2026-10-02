import { describe, expect, test } from 'bun:test';
import { proposeSkillDrafts } from '../../agent/skill-draft-proposer.ts';
import type { ProposeSkillDraftsInput } from '../../agent/skill-draft-proposer.ts';
import type { LearningCandidate } from '../../tools/agent-harness-learning-curator-types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<LearningCandidate> = {}): LearningCandidate {
  return {
    id: 'c-1',
    label: 'Do something useful',
    domain: 'skill',
    recordId: null,
    status: 'proposal-ready',
    priority: 50,
    reason: 'Seen repeatedly in sessions',
    next: 'propose as skill',
    scores: { usefulness: 0.8, freshness: 0.7, sourceQuality: 0.9, risk: 0.1 },
    proposalTarget: 'skill',
    proposalFields: { description: 'Do something useful every day' },
    inspectRoute: '/api/learning/c-1',
    modelRoute: '/api/learning/c-1/model',
    ...overrides,
  };
}

function makeInput(overrides: Partial<ProposeSkillDraftsInput> = {}): ProposeSkillDraftsInput {
  return {
    candidates: [],
    existingSkillNames: new Set(),
    previouslyProposedNames: new Set(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Target / status filtering
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: filtering', () => {
  test('only accepts proposal-ready + skill target', () => {
    const candidates = [
      makeCandidate({ id: 'c-1', status: 'proposal-ready', proposalTarget: 'skill' }),
      makeCandidate({ id: 'c-2', status: 'needs-review', proposalTarget: 'skill' }),
      makeCandidate({ id: 'c-3', status: 'proposal-ready', proposalTarget: 'memory' }),
      makeCandidate({ id: 'c-4', status: 'ready', proposalTarget: 'skill' }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(1);
    expect(result[0]?.candidateId).toBe('c-1');
  });

  test('accepts ready-to-promote + skill target', () => {
    const candidates = [
      makeCandidate({ id: 'c-1', status: 'ready-to-promote', proposalTarget: 'skill' }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(1);
  });

  test('returns empty array when no eligible candidates', () => {
    const candidates = [
      makeCandidate({ id: 'c-1', status: 'needs-setup', proposalTarget: 'skill' }),
    ];
    expect(proposeSkillDrafts(makeInput({ candidates }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: cap', () => {
  test('emits at most 3 proposals per pass', () => {
    const candidates = Array.from({ length: 6 }, (_, i) =>
      makeCandidate({
        id: `c-${i}`,
        label: `skill ${i}`,
        proposalFields: { description: `do thing ${i}` },
      }),
    );
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Dedup, existing names
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: dedup vs existing names', () => {
  test('skips candidates whose slug matches an existing skill name (case-insensitive)', () => {
    // The proposer slugifies the description. "Do Something Useful Every Day"
    // becomes "do-something-useful-every-day"
    const candidates = [
      makeCandidate({
        id: 'c-1',
        proposalFields: { description: 'Do Something Useful Every Day' },
      }),
    ];
    const existingSkillNames = new Set(['do-something-useful-every-day']);
    const result = proposeSkillDrafts(makeInput({ candidates, existingSkillNames }));
    expect(result).toHaveLength(0);
  });

  test('accepts candidate when slug does not match existing names', () => {
    const candidates = [
      makeCandidate({
        id: 'c-1',
        proposalFields: { description: 'Something Brand New' },
      }),
    ];
    const existingSkillNames = new Set(['other-skill']);
    const result = proposeSkillDrafts(makeInput({ candidates, existingSkillNames }));
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Dedup, previously proposed names
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: dedup vs previously proposed names', () => {
  test('skips candidates whose slug appears in previouslyProposedNames', () => {
    const candidates = [
      makeCandidate({
        id: 'c-1',
        proposalFields: { description: 'Triage Inbox Daily' },
      }),
    ];
    const previouslyProposedNames = new Set(['triage-inbox-daily']);
    const result = proposeSkillDrafts(makeInput({ candidates, previouslyProposedNames }));
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Within-pass dedup
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: within-pass dedup', () => {
  test('two candidates that resolve to the same slug yield only one proposal', () => {
    const candidates = [
      makeCandidate({
        id: 'c-1',
        priority: 90,
        proposalFields: { description: 'Summarize the week' },
      }),
      makeCandidate({
        id: 'c-2',
        priority: 80,
        // Same slug when slugified: "summarize-the-week"
        proposalFields: { description: 'Summarize The Week' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(1);
    // Higher priority candidate wins
    expect(result[0]?.candidateId).toBe('c-1');
  });
});

// ---------------------------------------------------------------------------
// Secret skip, no abort
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: secret skip', () => {
  test('skips a candidate containing secret-like text without aborting the pass', () => {
    const candidates = [
      makeCandidate({
        id: 'c-secret',
        priority: 100,
        proposalFields: { description: 'routine with password=hunter2 embedded' },
      }),
      makeCandidate({
        id: 'c-clean',
        priority: 50,
        proposalFields: { description: 'Send the weekly digest email' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    // The secret candidate must be skipped; the clean one must proceed
    expect(result.some((p) => p.candidateId === 'c-secret')).toBe(false);
    expect(result.some((p) => p.candidateId === 'c-clean')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty name / description guard
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: empty guards', () => {
  test('skips a candidate whose description resolves to an empty string', () => {
    // Both the proposalFields.description and label produce empty after trim
    const candidates = [
      makeCandidate({
        id: 'c-empty',
        label: '  ',
        proposalFields: { description: '  ' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(0);
  });

  test('uses label fallback when proposalFields.description is absent', () => {
    const candidates = [
      makeCandidate({
        id: 'c-label',
        label: 'Quick Capture Note',
        proposalFields: {},
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('quick-capture-note');
  });
});

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: payload shape', () => {
  test('emitted payload has enabled:true (autonomous), source:agent, provenance:auto-proposed-skill-draft', () => {
    const candidates = [
      makeCandidate({
        id: 'c-1',
        proposalFields: { description: 'Write the daily summary' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result).toHaveLength(1);
    const payload = result[0]!;
    expect(payload.enabled).toBe(true);
    expect(payload.source).toBe('agent');
    expect(payload.provenance).toBe('auto-proposed-skill-draft');
  });

  test('name is derived from description as a kebab slug', () => {
    const candidates = [
      makeCandidate({
        id: 'c-1',
        proposalFields: { description: 'Check Morning Emails' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result[0]?.name).toBe('check-morning-emails');
  });

  test('candidateId and candidateLabel are carried through', () => {
    const candidates = [
      makeCandidate({
        id: 'c-abc',
        label: 'original label text',
        proposalFields: { description: 'Automate daily log' },
      }),
    ];
    const result = proposeSkillDrafts(makeInput({ candidates }));
    expect(result[0]?.candidateId).toBe('c-abc');
    expect(result[0]?.candidateLabel).toBe('original label text');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('proposeSkillDrafts: determinism', () => {
  test('same input always produces the same output (no Date.now / Math.random)', () => {
    const candidates = [
      makeCandidate({ id: 'c-1', proposalFields: { description: 'First proposal' } }),
      makeCandidate({ id: 'c-2', proposalFields: { description: 'Second proposal' } }),
    ];
    const input = makeInput({ candidates });
    const r1 = proposeSkillDrafts(input);
    const r2 = proposeSkillDrafts(input);
    expect(r1).toEqual(r2);
  });
});
