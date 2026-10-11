import type { SqlDatabase } from './sqlite-store.js';
import { validateCurrentKnowledgeSchema } from '../knowledge/store-current-schema-validation.js';
import { knowledgeSchemaColumns, executionAttemptColumns, conversationRequestColumns, knowledgeEdgeChangeTriggers } from '../knowledge/store-schema-validation-data.js';

const planBrand: unique symbol = Symbol('native-knowledge-schema-read-plan');
export interface NativeKnowledgeSchemaReadPlan { readonly [planBrand]: true }
interface Plan {
  readonly schemaVersion: 10;
  readonly validator: typeof validateCurrentKnowledgeSchema;
}
const plans = new WeakMap<object, Plan>();

/** No caller data or function can define the conditions of this native plan. */
export function prepareNativeKnowledgeSchemaReadPlan(): NativeKnowledgeSchemaReadPlan {
  const token = Object.freeze({ [planBrand]: true as const });
  plans.set(token, Object.freeze({ schemaVersion: 10, validator: validateCurrentKnowledgeSchema }));
  return token;
}

export function nativeKnowledgeSchemaReadPlanMatches(
  token: NativeKnowledgeSchemaReadPlan | undefined,
  validator: ((db: SqlDatabase) => void) | undefined,
  schemaVersion: number,
): boolean {
  const plan = token ? plans.get(token) : undefined;
  return Boolean(plan && plan.schemaVersion === schemaVersion && plan.validator === validator);
}

const layouts = Object.freeze([
  Object.freeze(['work_ledgers', knowledgeSchemaColumns.workLedger] as const),
  Object.freeze(['native_work_executions', knowledgeSchemaColumns.execution] as const),
  Object.freeze(['native_work_execution_intents', knowledgeSchemaColumns.intent] as const),
  Object.freeze(['native_conversation_captures', knowledgeSchemaColumns.conversation] as const),
  Object.freeze(['native_work_execution_settlements', knowledgeSchemaColumns.settlement] as const),
  Object.freeze(['native_ci_continuations', knowledgeSchemaColumns.continuation] as const),
  Object.freeze(['knowledge_edge_changes', knowledgeSchemaColumns.edgeChange] as const),
]);
const uniqueIndexes = Object.freeze([
  Object.freeze(['native_work_executions', executionAttemptColumns] as const),
  Object.freeze(['native_conversation_captures', conversationRequestColumns] as const),
]);
// Only these empty tables make all row/association validation loops vacuous.
const emptyTables = Object.freeze(['work_ledgers', 'native_work_executions', 'native_work_execution_intents', 'native_conversation_captures',
  'native_work_execution_settlements', 'native_ci_continuations'] as const);

/** Fixed readonly SQL and data comparisons, never a borrowed validation callback.
 * A populated authority table requires the original full validator and clone. */
export function validateNativeKnowledgeReadSchema(db: Pick<SqlDatabase, 'exec'>): boolean {
  const layoutResults = db.exec(layouts.map(([table]) => `PRAGMA table_info(${table})`).join(';'));
  // sql.js omits empty statement results. Never attribute a shifted result to
  // the next table when one layout or index list is missing.
  if (layoutResults.length !== layouts.length) return false;
  for (const [ordinal, [, expected]] of layouts.entries()) {
    const rows = layoutResults[ordinal]?.values;
    if (!rows || rows.length !== expected.length || expected.some(([name, type, required, primary]) => {
      const row = rows.find(value => value[1] === name);
      return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
    })) return false;
  }
  const indexResults = db.exec(uniqueIndexes.map(([table]) => `PRAGMA index_list(${table})`).join(';'));
  if (indexResults.length !== uniqueIndexes.length) return false;
  for (const [ordinal, [, expected]] of uniqueIndexes.entries()) {
    const indexes = indexResults[ordinal]?.values ?? [];
    if (!indexes.some(index => index[2] === 1 && index[4] === 0
      && JSON.stringify(db.exec(`PRAGMA index_info('${String(index[1]).replaceAll("'", "''")}')`)[0]?.values.map(row => row[2])) === JSON.stringify(expected))) return false;
  }
  const installed = db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='knowledge_edges'")[0]?.values ?? [];
  for (const [name, sql] of knowledgeEdgeChangeTriggers) {
    if (installed.find(row => row[0] === name)?.[1] !== sql.replace('IF NOT EXISTS ', '')) return false;
  }
  const authorityResults = db.exec(emptyTables.map(table => `SELECT 1 FROM ${table} LIMIT 1`).join(';'));
  return authorityResults.every(result => result.values.length === 0);
}
