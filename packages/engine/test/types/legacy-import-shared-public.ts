import { openLegacyImportOperator, LegacyImportJournal, resolveLegacyImportJournalLocation,
  type LegacyImportBinding, type LegacyImportCommand, type LegacyImportEntry, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';

declare const entry: LegacyImportEntry;
const decisions: readonly JevDecision[] = entry.decisions;
const result: Promise<LegacyImportOperatorSession> = openLegacyImportOperator({
  resolve: () => ({ reason: 'type-only consumer' }), projectId: 'project', journalPath: '/private/journal',
});
void [decisions, result, LegacyImportJournal, resolveLegacyImportJournalLocation];

declare const journal: LegacyImportJournal;
declare const binding: LegacyImportBinding;
declare const command: LegacyImportCommand;
journal.cancel(binding, command);
journal.dispatch(binding, command);
journal.record(binding, command, { kind: 'rejected', code: 'conflict', reason: 'type-only result', revision: null });
// @ts-expect-error A stable selection is not the admitted command identity.
journal.dispatch(binding);
// @ts-expect-error Cancellation must identify the exact command it owns.
journal.cancel(binding);
// @ts-expect-error Rejected results do not supply their request identity.
journal.record(binding, { kind: 'rejected', code: 'conflict', reason: 'type-only result', revision: null });
