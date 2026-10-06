import type { JudgmentPort, YesNoReading } from '@goodvibes-jev/judgment';

/** Provider-neutral semantic input; the complete supplied object is inspected before projection. */
export interface TriageInput {
  readonly id: string;
  readonly surface: string;
  readonly subject?: string;
  readonly snippet?: string;
  readonly conversationKind?: 'direct' | 'group' | 'channel' | 'thread' | 'service';
  readonly unread?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export type TriageLabel = 'spam' | 'priority' | 'normal';
export interface TriageBinding {
  readonly id: string;
  readonly inputHash: string;
  readonly battery: string;
  readonly batteryVersion: number;
  readonly model: string;
}
export interface TriageEvidence extends TriageBinding {
  readonly status: 'settled';
  readonly spam: YesNoReading;
  readonly urgency: YesNoReading;
  readonly label: TriageLabel;
  readonly score: number;
  readonly tags: readonly string[];
  readonly signals: Readonly<{ spam: number; urgency: number }>;
}
export type TriageReceipt = TriageEvidence | (TriageBinding & {
  readonly status: 'held' | 'unavailable';
});
export interface TriageStoredRecord {
  readonly latest: TriageReceipt;
  /** Last settled evidence is historical when latest is held/unavailable. */
  readonly settled: TriageEvidence | null;
}
/** A single atomic write contains both settled evidence and latest-attempt receipts. */
export interface TriageStore {
  readBatch(ids: readonly string[]): Promise<ReadonlyMap<string, TriageStoredRecord>>;
  commit(receipts: readonly TriageReceipt[], signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface RunInboxTriageOptions {
  readonly port?: JudgmentPort;
  readonly store?: TriageStore;
  readonly workingDirectory?: string;
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}
