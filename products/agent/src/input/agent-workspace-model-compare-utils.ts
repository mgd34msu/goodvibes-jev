import type { AgentModelCompareExportWorkspaceToolArgs, AgentModelCompareReviewWorkspaceToolArgs } from './agent-workspace-model-compare-types.ts';

export function readList(value: string): readonly string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function readPositiveInteger(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.trunc(parsed));
}

export function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true';
}

export function compareExportMode(value: string): AgentModelCompareExportWorkspaceToolArgs['mode'] {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'handoff' || normalized === 'reviewerhandoff') return 'handoff';
  if (normalized === 'archive' || normalized === 'zip' || normalized === 'handoffarchive' || normalized === 'handoffzip') return 'handoffArchive';
  return 'export';
}

export function compareReviewMode(value: string): AgentModelCompareReviewWorkspaceToolArgs['mode'] {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'sidebyside' || normalized === 'side') return 'sideBySide';
  if (normalized === 'handoffdiff' || normalized === 'diff' || normalized === 'visualdiff') return 'handoffDiff';
  return 'review';
}

export function quoteBlock(value: string): string {
  return value.trim() || '(blank)';
}
