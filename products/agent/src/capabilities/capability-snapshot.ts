import type { CapabilityIndexReport } from './capability-types.ts';

/**
 * The session's resolved capability index.
 *
 * Resolved once at startup and kept here so the prompt composer, which runs on
 * every turn, synchronously, can read it without re-probing the filesystem
 * each time. Callers that need a fresh answer re-resolve and set it again.
 *
 * Null means "not resolved yet", which is deliberately different from "nothing
 * is available". Everything that reads this must preserve that distinction:
 * reporting an unresolved index as an empty one is the exact mistake this whole
 * module set exists to end.
 */
let snapshot: CapabilityIndexReport | null = null;

export function setCapabilitySnapshot(report: CapabilityIndexReport): void {
  snapshot = report;
}

export function capabilitySnapshot(): CapabilityIndexReport | null {
  return snapshot;
}

export function resetCapabilitySnapshotForTests(): void {
  snapshot = null;
}
