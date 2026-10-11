/**
 * A fake judgment port for the compaction readings: the quality readings
 * (runtime/compaction/quality-score.ts), the `engine.compaction.retention`
 * rubric (question `substance`, levels 0 to 3) and the
 * `engine.compaction.fidelity` check (question `relation`), and the collapse
 * strategy's `engine.compaction.collapse-keep` reading (one `keep_<n>`
 * question per message). Tests of the scorer, the compaction manager, the
 * collapse strategy and the guarded compactor use it so they never call the
 * live Jev API.
 */
import { afterEach, beforeEach } from 'bun:test';
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';

export interface CompactionReadings {
  /** The retention level read (0 none to 3 all); default 3. */
  readonly substance?: number;
  /** How the written text relates to the source; default 'supports'. */
  readonly relation?: 'supports' | 'contradicts' | 'says_nothing';
  /** The keep probability for message number `n` of a collapsed conversation; default 0.05 (not kept). */
  readonly keep?: (n: number) => number;
}

/** A port answering both compaction readings from `readings`, recording every request. */
export function compactionQualityPort(readings: CompactionReadings = {}) {
  return fakePort((name: string, question: Question) => {
    if (name.startsWith('dependency_')) return noulAnswer(0.01);
    if (name.startsWith('selected_c2_')) return noulAnswer(0.01);
    if (name === 'selected' || name.startsWith('selected_')) return noulAnswer(0.99);
    if (name === 'substance') return scoreAnswer(question, readings.substance ?? 3, 0.95);
    if (name === 'relation') return choiceAnswer(question, readings.relation ?? 'supports', 0.95);
    if (name.startsWith('keep_')) return noulAnswer(readings.keep?.(Number(name.slice('keep_'.length))) ?? 0.05);
    throw new Error(`compaction quality port: unexpected question ${name}`);
  });
}

/**
 * Installs a {@link compactionQualityPort} around every test in the calling
 * file (or describe block) and restores the previous port afterwards. The
 * returned object's `requests` is the current test's request log.
 */
export function useCompactionQuality(readings: CompactionReadings = {}): { readonly requests: ReadonlyArray<{ readonly state: unknown; readonly questions: object }> } {
  const log: { requests: ReadonlyArray<{ readonly state: unknown; readonly questions: object }> } = { requests: [] };
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    const { port, requests } = compactionQualityPort(readings);
    log.requests = requests;
    previous = installJudgmentPort(port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });
  return log;
}
