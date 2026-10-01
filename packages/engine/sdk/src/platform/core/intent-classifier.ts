/** Semantic intent is a recorded Jev reading, never a keyword or length score. */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { CallOptions, Outcome, ScoreReading, YesNoReading } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { turnShape } from './batteries/turn-shape.js';

export type Intent = 'chat' | 'task' | 'project';

export interface ClassificationResult {
  intent: Intent;
  /** The choice reading's confidence, not a score invented from text features. */
  confidence: number;
  /** Named reading conclusions retained for callers displaying classification details. */
  signals: string[];
  outcome: Outcome;
  needsPlan: YesNoReading;
  risk: ScoreReading;
  decisionId: string | undefined;
  recordAction(action: string): void;
}

/** Read the complete request once; callers may share this result within its turn. */
export async function classifyIntent(message: string, options: CallOptions = {}): Promise<ClassificationResult> {
  assertJudgmentInput({ work: message });
  options.signal?.throwIfAborted();
  const run = await turnShape.run(judgmentPort('engine.core.turn'), { purpose: 'conversation', work: message }, { site: 'engine.core.turn', ...options });
  options.signal?.throwIfAborted();
  const { intent, needs_plan: needsPlan, risk } = run.readings;
  return {
    intent: intent.choice,
    confidence: intent.confidence,
    signals: [`intent:${intent.choice}`, `planning:${needsPlan.verdict}`, `outcome:${intent.outcome}`],
    outcome: intent.outcome,
    needsPlan,
    risk,
    decisionId: run.result.decisionId,
    recordAction: run.recordAction,
  };
}
