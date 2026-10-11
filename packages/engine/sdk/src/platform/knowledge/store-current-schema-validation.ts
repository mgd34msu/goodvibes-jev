import type { SqlDatabase } from '../state/sqlite-store.js';
import { validateWorkLedgerTable } from './store-work-ledger.js';
import { validateNativeWorkExecutionTable, validateNativeWorkExecutionIntentTable, validateNativeWorkSettlementTable } from './store-native-work-execution.js';
import { validateNativeConversationCaptureTable } from './store-native-intake.js';
import { validateNativeCiContinuationTable } from './store-native-ci-continuation.js';
import { validateKnowledgeEdgeChanges } from './store-edge-generations.js';

/** The same complete validator remains the default for current native images. */
export function validateCurrentKnowledgeSchema(db: Pick<SqlDatabase, 'exec'>): void {
  validateWorkLedgerTable(db);
  validateNativeWorkExecutionTable(db);
  validateNativeWorkExecutionIntentTable(db);
  validateNativeConversationCaptureTable(db);
  validateNativeWorkSettlementTable(db);
  validateNativeCiContinuationTable(db);
  validateKnowledgeEdgeChanges(db);
}
