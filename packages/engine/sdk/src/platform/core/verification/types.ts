import type { CallOptions, JudgmentPort } from '@goodvibes-jev/judgment';
import type { CompletionFinding } from '../response-completion-findings.js';

export interface VerificationSource {
  readonly id: string;
  readonly kind: 'instruction' | 'observation' | 'answer';
  readonly reference: string;
  readonly text: string;
  readonly messageRole?: 'user' | 'assistant' | 'tool' | 'system';
  readonly completeMessage?: boolean;
  readonly execution?: Readonly<Record<string, unknown>>;
  /** Native call identities on every interval of an assistant tool request. */
  readonly toolCallIds?: readonly string[];
}
export interface VerificationFact {
  readonly text: string;
  readonly sources: readonly string[];
}
export interface VerificationSummary {
  readonly facts: readonly VerificationFact[];
  readonly concerns: readonly VerificationFact[];
}
export interface VerificationRequirement {
  readonly id: string;
  readonly text: string;
  readonly sources: readonly string[];
}
export interface VerificationReceipt {
  readonly id: string;
  readonly summary: VerificationSummary;
  readonly children: readonly string[];
  readonly sourceIds: readonly string[];
  readonly representation?: 'jev-qualified' | 'exact-original' | 'source-index';
}
export interface VerificationWriterRequest {
  readonly operation: 'requirements' | 'evidence' | 'merge' | 'findings';
  readonly context: unknown;
  readonly repair?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}
export type VerificationWriter = (request: VerificationWriterRequest) => Promise<string>;
export interface VerificationAccess extends CallOptions {
  readonly port: JudgmentPort;
  readonly identity: object;
  readonly assertCurrent: () => void;
}
export class VerificationHeldError extends Error {
  constructor(readonly stage: string, options?: ErrorOptions) { super(`Source-backed verification is held at ${stage}.`, options); }
}
/** Semantic uncertainty needs a specific evidence repair, not outage retries. */
export class VerificationUnsettledError extends Error {
  constructor(readonly stage: string, readonly findings: readonly CompletionFinding[]) {
    super(`Source-backed verification is held at ${stage}.`);
  }
}
export class VerificationSubdivisionError extends Error {
  constructor() { super('The evidence reduction needs a smaller source frame.'); }
}
