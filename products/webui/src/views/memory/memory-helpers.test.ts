import { describe, expect, test } from 'bun:test';
import type { MemoryRecord } from '../../lib/goodvibes';
import {
  RECALL_CONFIDENCE_FLOOR,
  formatConfidence,
  formatProvenanceLink,
  isBelowRecallFloor,
  isFlaggedReviewState,
  isPersonaRecord,
  reviewStateTone,
  splitTags,
} from './memory-helpers';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    scope: 'project',
    cls: 'fact',
    summary: 'The daemon owns the memory store',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('isPersonaRecord: the client-side VIBE.md persona projection', () => {
  test('true only for a constraint record tagged "vibe"', () => {
    expect(isPersonaRecord(record({ cls: 'constraint', tags: ['vibe'] }))).toBe(true);
  });

  test('false for a constraint record without the vibe tag', () => {
    expect(isPersonaRecord(record({ cls: 'constraint', tags: ['other'] }))).toBe(false);
  });

  test('false for a vibe-tagged record of a different class', () => {
    expect(isPersonaRecord(record({ cls: 'fact', tags: ['vibe'] }))).toBe(false);
  });
});

describe('the recall-honesty floor', () => {
  test('a record below the given recall floor is flagged as below the floor', () => {
    expect(isBelowRecallFloor(record({ confidence: 59 }), RECALL_CONFIDENCE_FLOOR)).toBe(true);
    expect(isBelowRecallFloor(record({ confidence: 60 }), RECALL_CONFIDENCE_FLOOR)).toBe(false);
    expect(isBelowRecallFloor(record({ confidence: 100 }), RECALL_CONFIDENCE_FLOOR)).toBe(false);
  });

  test('isBelowRecallFloor honors a live wire floor that differs from the documented baseline', () => {
    expect(isBelowRecallFloor(record({ confidence: 70 }), 75)).toBe(true);
    expect(isBelowRecallFloor(record({ confidence: 70 }), 50)).toBe(false);
  });
});

describe('review-state honesty', () => {
  test('stale and contradicted are flagged; fresh and reviewed are not', () => {
    expect(isFlaggedReviewState('stale')).toBe(true);
    expect(isFlaggedReviewState('contradicted')).toBe(true);
    expect(isFlaggedReviewState('fresh')).toBe(false);
    expect(isFlaggedReviewState('reviewed')).toBe(false);
  });

  test('review-state tone matches severity: reviewed=ok, fresh=neutral, stale=warning, contradicted=bad', () => {
    expect(reviewStateTone('reviewed')).toBe('ok');
    expect(reviewStateTone('fresh')).toBe('neutral');
    expect(reviewStateTone('stale')).toBe('warning');
    expect(reviewStateTone('contradicted')).toBe('bad');
  });
});

describe('formatting helpers', () => {
  test('formatConfidence rounds to a whole percent', () => {
    expect(formatConfidence(59.6)).toBe('60%');
    expect(formatConfidence(0)).toBe('0%');
  });

  test('formatProvenanceLink renders a path-shaped ref as plain text, never a link', () => {
    const text = formatProvenanceLink({ kind: 'file', ref: '/home/user/.env' });
    expect(text).toContain('/home/user/.env');
    expect(text).not.toContain('<a');
    expect(text).not.toContain('href');
  });

  test('formatProvenanceLink includes the label when present', () => {
    const text = formatProvenanceLink({ kind: 'session', ref: 's-1', label: 'Refactor session' });
    expect(text).toContain('Refactor session');
    expect(text).toContain('s-1');
  });

  test('splitTags trims, drops blanks, comma-separates', () => {
    expect(splitTags(' a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(splitTags('')).toEqual([]);
  });
});
