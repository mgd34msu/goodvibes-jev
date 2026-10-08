import type { NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { NativeWorkExecutionState } from './native-work-execution.ts';

type IntegrationInspection = NonNullable<Extract<NativeWorkExecutionSnapshot, { kind: 'execution' }>['integration']>;
export interface NativeWorkIntegrationView {
  readonly status: string;
  readonly rows: readonly { readonly id: string; readonly label: string; readonly selectable: false }[];
}

// Escape terminal controls rather than dropping them: a path with a newline,
// escape sequence or bidi control must remain distinguishable from another path.
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const path = (value: string | undefined): string => value === undefined ? 'not recorded' : safe(JSON.stringify(value));

/** Read-only facts from the native status response; never derive integration from a unit's verdict. */
export function nativeWorkIntegrationView(state: NativeWorkExecutionState | undefined): NativeWorkIntegrationView {
  const rows: { id: string; label: string; selectable: false }[] = [];
  const snapshot = state?.snapshot;
  if (!snapshot) return { status: state?.busy ? 'Integration unavailable while the native request is pending.'
    : 'Integration unavailable. Select a Work control row and press i for status.', rows };
  const identity = [snapshot.projectId, snapshot.workId, snapshot.attemptId];
  const add = (scope: readonly unknown[], role: string, label: string, index?: number): void => {
    rows.push({ id: JSON.stringify(['integration', identity, scope, role, index ?? null]), label: safe(label), selectable: false });
  };
  add([], 'execution', `Work ${snapshot.workId} · ${snapshot.kind === 'execution' ? 'execution attempt' : 'admission intent'} ${snapshot.attemptId}`);
  if (snapshot.kind !== 'execution') return { status: 'Integration unavailable: no admitted execution receipt.', rows };
  const inspection: IntegrationInspection | undefined = snapshot.integration;
  if (!inspection) return { status: 'Integration unavailable: this host did not report integration inspection.', rows };
  if (inspection.state === 'unavailable') return { status: `Integration unavailable: ${inspection.reason}.`, rows };
  const contract = [inspection.contractId];
  add(contract, 'contract', `Contract ${inspection.contractId}`);
  if (inspection.state === 'not-applicable') return { status: `Integration not applicable: ${inspection.reason}.`, rows };
  add(contract, 'units', `Worktree isolation · ${inspection.units.length} recorded units`);
  for (const unit of inspection.units) {
    const item = unit.item;
    // Use the actual join, including absent versus zero attempt indexes. IDs and
    // suffix-looking user strings cannot collide with role or child boundaries.
    const scope = [...contract, unit.unitId, unit.groupId, unit.attemptOf ?? null, unit.attemptIndex ?? null,
      item.state === 'recorded' ? [item.itemId, item.workstreamId] : null];
    add(scope, 'unit', `Unit ${unit.unitId} · group ${unit.groupId}`);
    add(scope, 'attempt', `Attempt of: ${unit.attemptOf ?? 'not recorded'} · attempt index: ${unit.attemptIndex ?? 'not recorded'}`);
    add(scope, 'status', `Current unit status: ${unit.unitStatus}`);
    const check = unit.latestCheck;
    add(scope, 'check', check ? `Latest check ${check.id} · ${check.trigger} · ${check.result} · at ${check.at}` : 'Latest check: not recorded');
    if (item.state !== 'recorded') {
      add(scope, 'item', `Item ${item.state === 'unavailable' ? 'unavailable' : 'not applicable'}: ${item.reason}`);
      continue;
    }
    add(scope, 'item', `Item ${item.itemId} · workstream ${item.workstreamId}`);
    add(scope, 'integration', `Recorded integration: ${item.integration}${item.integration === 'merged' && item.mergeHash === undefined ? ' (no changes)' : ''}`);
    add(scope, 'hash', `Merge hash: ${item.mergeHash ?? 'not recorded'}`);
    add(scope, 'path', `Worktree path: ${path(item.worktreePath)}`);
    add(scope, 'branch', `Worktree branch: ${path(item.worktreeBranch)}`);
    add(scope, 'kept', `Worktree kept: ${item.worktreeKept === undefined ? 'not recorded' : String(item.worktreeKept)}`);
    add(scope, 'conflicts', item.conflictFiles === undefined ? 'Conflict files: not recorded'
      : `Conflict files: ${item.conflictFiles.length}${item.conflictFiles.length === 0 ? ' (recorded empty)' : ''}`);
    item.conflictFiles?.forEach((file, index) => add(scope, 'conflict-file', `Conflict file ${index + 1}: ${path(file)}`, index));
  }
  return { status: 'Integration: live worktree snapshot. Read-only; Jev owns runtime decisions.', rows };
}
