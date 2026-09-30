import type { JsonValue } from '@goodvibes-jev/judgment';
export type HomeGraphQualityQuestion = 'batteryApplicable' | 'manualApplicable' | 'manufacturerPresent' | 'modelPresent' | 'batteryTypePresent';
export interface HomeGraphQualityInput {
  readonly reference: string;
  readonly subject: Readonly<Record<string, JsonValue>>;
  readonly entities: readonly Readonly<Record<string, JsonValue>>[];
  readonly facts: readonly Readonly<Record<string, JsonValue>>[];
  readonly questions: readonly HomeGraphQualityQuestion[];
}
export interface HomeGraphQualityReading {
  readonly reference: string;
  readonly answers: Readonly<Partial<Record<HomeGraphQualityQuestion, boolean>>>;
  readonly provenance: Readonly<Partial<Record<HomeGraphQualityQuestion, {
    readonly battery: string; readonly version: number; readonly probability: number;
    readonly decisionId?: string | undefined; readonly model: string; readonly requestedModel: string;
  }>>>;
  readonly decisionIds: readonly string[];
  readonly batteries: readonly { readonly name: string; readonly version: number }[];
  readonly model?: string | undefined;
  readonly requestedModel?: string | undefined;
}
export type HomeGraphQualityHoldReason = 'unconfigured' | 'unavailable' | 'unsettled' | 'malformed' | 'stale' | 'aborted' | 'budget' | 'protected-input';
export class HomeGraphQualityHeldError extends Error {
  override readonly name = 'HomeGraphQualityHeldError';
  constructor(readonly reason: HomeGraphQualityHoldReason) {
    super(`Home Graph derived quality held (${reason}); existing issues and passport fields were not replaced.`);
  }
}
export const HOME_GRAPH_QUALITY_LIMITS = Object.freeze({ devices: 1_000, entities: 1_000, facts: 500, concurrency: 4, timeoutMs: 60_000, defaultTimeoutMs: 30_000 });
