/**
 * quality-score.ts
 *
 * Compaction quality scoring: evaluates the output of a compaction strategy on
 * two axes, how much it shrank the conversation and how much of the
 * conversation's substance it kept.
 *
 * Score range: 0.0 (worst) to 1.0 (best)
 * Auto-switch threshold: scores below LOW_QUALITY_THRESHOLD trigger a strategy
 * escalation to the next more-aggressive strategy.
 *
 * How the score is composed:
 * - compressionScore (code): the fraction of tokens removed, scaled so an 80%
 *   reduction or more is a full score.
 * - retentionScore (Jev): two readings of the compaction against the
 *   conversation it replaced, asked concurrently.
 *     - `engine.compaction.retention`, a rated rubric: how much of what the
 *       work depends on the compacted conversation still carries. Its
 *       probability-weighted score over the levels, normalised to 0 to 1, is
 *       the substance carried.
 *     - `engine.compaction.fidelity`, the fidelity pattern: whether the text
 *       the compaction wrote (its handoff note or summary) contradicts the
 *       conversation. A compaction that misstates what happened is worse than
 *       one that dropped it, because the agent resumes on the false version.
 *   retentionScore = substance x (1 - probability the written text contradicts
 *   the source): the substance carried, counted only to the extent the
 *   compacted conversation can be trusted. No written text means nothing is
 *   claimed and nothing is asked.
 *   Structural facts gate the readings: an output with no messages, no
 *   tokens, or more messages than the input carries nothing a compaction
 *   should keep, so its retention is 0 without asking.
 * - score: the geometric mean of the two axes, sqrt(compression x retention).
 *   A compaction is only good when it both shrinks the conversation and keeps
 *   its substance; the geometric mean is 0 when either axis is 0, needs no
 *   chosen weight between them, and stays on the same 0 to 1 scale as each axis.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Fidelity } from '@goodvibes-jev/judgment';
import type { StrategyInput, StrategyOutput, CompactionStrategy } from './types.js';
import { compactionViews } from './judged-views.js';
import { compactionFidelity } from './batteries/compaction-fidelity.js';
import { compactionRetention } from './batteries/compaction-retention.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Compaction runs scoring below this value are considered low-quality and
 * trigger an automatic strategy switch.
 */
export const LOW_QUALITY_THRESHOLD = 0.4;

/** Decision site for the compaction quality readings. */
export const COMPACTION_QUALITY_SITE = 'runtime.compaction.quality-score';

/**
 * Minimum meaningful compression ratio. A run with zero or negative compression
 * scores 0 on the compression axis.
 */
const MIN_COMPRESSION_RATIO = 0;

/**
 * Compression ratio above which the compression dimension is fully saturated.
 * Anything at or above this (e.g. 80% reduction) receives a perfect compression score.
 */
export const MAX_COMPRESSION_RATIO = 0.8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Letter grade derived from the composite quality score. */
export type CompactionQualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** The retention evidence behind a score. */
export interface SemanticRetentionSignals {
  /** How the text the compaction wrote relates to the conversation; 'none' when it wrote nothing or nothing was asked. */
  fidelity: Fidelity | 'none';
  /** Probability that the written text contradicts the conversation (0 when nothing was asked). */
  contradictionProbability: number;
  /** Substance of the conversation the compacted output carries, 0 to 1 (0 when nothing was asked). */
  substance: number;
  /** The output has at least one message and no more messages than the input. */
  messageCountSane: boolean;
  /** The output token count is positive. */
  positiveTokenCount: boolean;
}

/** Full quality score breakdown for a compaction run. */
export interface CompactionQualityScore {
  /** Fraction of tokens removed: (tokensBefore - tokensAfter) / tokensBefore. */
  compressionRatio: number;
  /** Normalised compression dimension score (0–1). */
  compressionScore: number;
  /** Semantic retention dimension score (0–1). */
  retentionScore: number;
  /** Composite quality score: geometric mean of compression and retention (0–1). */
  score: number;
  /** Letter grade derived from score. */
  grade: CompactionQualityGrade;
  /** The retention evidence. */
  signals: SemanticRetentionSignals;
  /** True when score < LOW_QUALITY_THRESHOLD and strategy escalation should occur. */
  isLowQuality: boolean;
  /** Human-readable description of the score for diagnostics. */
  description: string;
}

/** Options for one scoring. */
export interface QualityScoreOptions {
  readonly signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Reads how much of the conversation the compacted output keeps, and whether
 * what it wrote contradicts the conversation. Structural failures settle
 * retention at 0 without a request.
 */
async function readRetention(
  input: StrategyInput,
  output: StrategyOutput,
  options: QualityScoreOptions,
): Promise<{ signals: SemanticRetentionSignals; retentionScore: number }> {
  const messageCountSane = output.messages.length >= 1 && output.messages.length <= input.messages.length;
  const positiveTokenCount = output.tokensAfter > 0;
  if (!messageCountSane || !positiveTokenCount) {
    return {
      signals: { fidelity: 'none', contradictionProbability: 0, substance: 0, messageCountSane, positiveTokenCount },
      retentionScore: 0,
    };
  }

  const views = compactionViews(input.messages, output.messages);
  const port = judgmentPort(COMPACTION_QUALITY_SITE);
  const run = { site: COMPACTION_QUALITY_SITE, ...(options.signal ? { signal: options.signal } : {}) };
  const [retention, fidelity] = await Promise.all([
    compactionRetention.run(port, { source: views.source, compacted: views.compacted }, run),
    views.written.length > 0 ? compactionFidelity.check(port, views.written, views.source, undefined, run) : undefined,
  ]);

  const substance = Math.min(1, Math.max(0, retention.readings.substance.normalized));
  const contradictionProbability = fidelity?.reading?.probabilities.contradicts ?? 0;
  return {
    signals: {
      fidelity: fidelity?.fidelity ?? 'none',
      contradictionProbability,
      substance,
      messageCountSane,
      positiveTokenCount,
    },
    retentionScore: substance * (1 - contradictionProbability),
  };
}

/**
 * Normalises a raw compression ratio to a 0–1 score.
 *
 * A ratio of 0 (no reduction) → score 0.
 * A ratio at MAX_COMPRESSION_RATIO (e.g. 80%) → score 1.
 * Values above MAX_COMPRESSION_RATIO are clamped at 1.
 * Negative ratios (output larger than input) are clamped at 0.
 */
function scoreCompression(ratio: number): number {
  if (ratio <= MIN_COMPRESSION_RATIO) return 0;
  const normalised = (ratio - MIN_COMPRESSION_RATIO) / (MAX_COMPRESSION_RATIO - MIN_COMPRESSION_RATIO);
  return Math.min(1, Math.max(0, normalised));
}

/**
 * Maps a composite score to a letter grade.
 */
function gradeScore(score: number): CompactionQualityGrade {
  if (score >= 0.85) return 'A';
  if (score >= 0.70) return 'B';
  if (score >= 0.55) return 'C';
  if (score >= LOW_QUALITY_THRESHOLD) return 'D';
  return 'F';
}

/**
 * Produces a human-readable diagnostic description for a quality score.
 */
export function describeScore(score: CompactionQualityScore): string {
  const parts: string[] = [
    `score=${score.score.toFixed(2)} (${score.grade})`,
    `compression=${(score.compressionRatio * 100).toFixed(1)}%`,
    `retention=${(score.retentionScore * 100).toFixed(0)}%`,
  ];
  if (score.isLowQuality) {
    parts.push('LOW_QUALITY, strategy switch triggered');
  }
  return parts.join(', ');
}

/**
 * Computes the quality score for a completed compaction strategy run.
 *
 * @param input  - The strategy input (pre-compaction state).
 * @param output - The strategy output (post-compaction state).
 * @returns A full CompactionQualityScore breakdown, description filled in.
 */
export async function computeQualityScore(
  input: StrategyInput,
  output: StrategyOutput,
  options: QualityScoreOptions = {},
): Promise<CompactionQualityScore> {
  // Compression ratio: fraction of tokens removed
  const compressionRatio =
    input.tokensBefore > 0
      ? Math.max(0, (input.tokensBefore - output.tokensAfter) / input.tokensBefore)
      : 0;
  const compressionScore = scoreCompression(compressionRatio);

  const { signals, retentionScore } = await readRetention(input, output, options);
  const score = Math.sqrt(compressionScore * retentionScore);

  const full: CompactionQualityScore = {
    compressionRatio,
    compressionScore,
    retentionScore,
    score,
    grade: gradeScore(score),
    signals,
    isLowQuality: score < LOW_QUALITY_THRESHOLD,
    description: '',
  };
  full.description = describeScore(full);
  return full;
}

// ---------------------------------------------------------------------------
// Strategy escalation
// ---------------------------------------------------------------------------

/**
 * Returns the next more-aggressive strategy for escalation when quality is low.
 *
 * Escalation path:
 *   microcompact → autocompact → collapse → collapse (ceiling)
 *   reactive     → reactive (already maximum)
 *
 * @param current - The strategy that produced the low-quality result.
 * @returns The escalated strategy to re-run with.
 */
export function escalateStrategy(current: CompactionStrategy): CompactionStrategy {
  switch (current) {
    case 'microcompact': return 'autocompact';
    case 'autocompact':  return 'collapse';
    case 'collapse':     return 'collapse'; // already most aggressive
    case 'reactive':     return 'reactive'; // emergency, cannot escalate further
    default: {
      const _exhaustive: never = current;
      throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
    }
  }
}
