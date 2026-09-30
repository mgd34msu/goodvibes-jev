import type { JsonValue } from '@goodvibes-jev/judgment';
export interface TriageReadInput {
  readonly reference: string;
  readonly issue: { readonly code: string; readonly message: string; readonly severity: string };
  readonly subject?: Readonly<Record<string, JsonValue>> | undefined;
  readonly ruleGuidance?: string | undefined;
}
export interface TriageReadingPlan {
  readonly reference: string;
  readonly action: 'reject' | 'review';
  readonly probability: number;
  readonly facts: Readonly<Record<string, boolean | string>>;
  readonly decisionIds: readonly string[];
  readonly model: string;
  readonly requestedModel: string;
  readonly origin: 'automatic-judgment';
  readonly batteries: readonly { readonly name: string; readonly version: number }[];
}
export type TriageHoldReason = 'unconfigured' | 'unavailable' | 'unsettled' | 'unsupported-fact' | 'owner-threshold' | 'malformed' | 'stale' | 'aborted' | 'budget' | 'operator-reviewed';
export class HomeGraphTriageHeldError extends Error {
  override readonly name = 'HomeGraphTriageHeldError';
  constructor(readonly reason: TriageHoldReason) {
    super(`Home Graph triage held (${reason}); no automatic fact, issue or cache write was authorized.`);
  }
}
export const TRIAGE_READING_LIMITS = Object.freeze({ inputs: 100, concurrency: 4, timeoutMs: 60_000, defaultTimeoutMs: 30_000 });
