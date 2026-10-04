import { openLegacyImportOperator, LegacyImportJournal, resolveLegacyImportJournalLocation,
  type LegacyImportEntry, type LegacyImportOperatorSession } from '@goodvibes-jev/engine/terminal-shell/legacy-work-ledger-import';
import type { JevDecision } from '@goodvibes-jev/judgment/decisions';

declare const entry: LegacyImportEntry;
const decisions: readonly JevDecision[] = entry.decisions;
const result: Promise<LegacyImportOperatorSession> = openLegacyImportOperator({
  resolve: () => ({ reason: 'type-only consumer' }), projectId: 'project', journalPath: '/private/journal',
});
void [decisions, result, LegacyImportJournal, resolveLegacyImportJournalLocation];
