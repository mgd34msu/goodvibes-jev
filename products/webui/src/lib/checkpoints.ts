/**
 * checkpoints.ts, display helpers for checkpoints.*
 * (packages/sdk/src/platform/control-plane/method-catalog-fleet.ts /
 * WorkspaceCheckpointManager).
 */

import type { CheckpointsRestorePreviewResult, WorkspaceCheckpoint } from './goodvibes';

/** CHECKPOINT_KIND_SCHEMA (operator-contract-schemas-fleet.ts). */
export const KNOWN_CHECKPOINT_KINDS = ['turn', 'agent-run', 'manual'] as const;

/** RETENTION_CLASS_SCHEMA (operator-contract-schemas-fleet.ts). */
export const KNOWN_RETENTION_CLASSES = ['short', 'standard', 'forensic'] as const;

export function kindLabel(kind: string): string {
  return kind.trim() || 'unknown';
}

export function retentionLabel(retentionClass: string): string {
  return retentionClass.trim() || 'unknown';
}

export function sortCheckpointsNewestFirst(checkpoints: readonly WorkspaceCheckpoint[]): WorkspaceCheckpoint[] {
  return [...checkpoints].sort((a, b) => b.createdAt - a.createdAt);
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/**
 * The exact honest wording for a create() response that reported noop:true
 * (WorkspaceCheckpointManager: tree identical to the most recent checkpoint,
 * no commit, ref, or manifest entry created). Never phrased as a failure.
 */
export const CHECKPOINT_NOOP_MESSAGE = 'Nothing to snapshot: the workspace tree is unchanged since the last checkpoint.';

/**
 * The restore confirm's title: the question, naming the checkpoint. Named here
 * (not inlined at the call site) so the CheckpointsPanel test can assert on it
 * without duplicating the copy.
 */
export function restoreConfirmTitle(checkpoint: WorkspaceCheckpoint): string {
  return `Restore the workspace to “${checkpoint.label || checkpoint.id}”?`;
}

/**
 * The restore confirm's one sentence of consequence when no preview is
 * available (the preview call failed for a reason other than not-found).
 */
export function restoreConfirmMessage(): string {
  return 'Files changed since then are replaced.';
}

/**
 * The restore confirm's one sentence enriched with a checkpoints.restorePreview
 * result: how many files the restore would change, or that nothing would.
 */
export function restoreConfirmMessageWithPreview(
  preview: CheckpointsRestorePreviewResult['preview'],
): string {
  const count = preview.affectedPathCount;
  if (count <= 0) return 'The workspace already matches it, so no files change.';
  return `Files changed since then are replaced; ${count} ${count === 1 ? 'file changes' : 'files change'}.`;
}
