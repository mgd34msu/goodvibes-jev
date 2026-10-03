import { array, boolean, literal, union, enum as enumSchema, number, strictObject, string, toJSONSchema, type z } from 'zod/v4';
import { ledgerWorkSchema, ledgerAttemptSchema, ledgerEvidenceSchema, workLedgerReadEventSchema, ledgerEventSchema, legacyWorkLedgerManifestSchema } from '../workflow/work-ledger/types.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';

/** Dedicated capability. Never reuse fleet, workspace, or generic event scopes. */
export const WORK_LEDGER_READ_SCOPE = 'read:work-ledger';
export const WORK_LEDGER_IMPORT_SCOPE = 'write:work-ledger-import';
export const WORK_LEDGER_HISTORY_PAGE_SIZE = 100;
export const WORK_LEDGER_READ_MAX_BYTES = 1_048_576;
const sequence = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectId = string().min(1).max(200);
const readView = strictObject({
  work: ledgerWorkSchema,
  attempt: ledgerAttemptSchema.nullable(),
  verification: strictObject({
    state: enumSchema(['unverified', 'verified', 'failed', 'unavailable', 'stale']),
    reason: string(),
    evidence: ledgerEvidenceSchema.nullable(),
  }),
  attention: array(strictObject({ kind: enumSchema(['blocked', 'verification']), reason: string() })),
});
export const workLedgerReadSnapshotSchema = strictObject({
  projectId, revision: sequence, cursor: sequence, provenance: enumSchema(['available', 'requires_read_knowledge']).optional(), works: array(readView),
});
export const workLedgerHistoryPageSchema = strictObject({
  projectId, afterSequence: sequence, cursor: sequence, throughSequence: sequence, provenance: enumSchema(['available', 'requires_read_knowledge']).optional(),
  hasMore: boolean(), events: array(workLedgerReadEventSchema).max(WORK_LEDGER_HISTORY_PAGE_SIZE),
});
export type WorkLedgerHistoryPage = z.infer<typeof workLedgerHistoryPageSchema>;
// Structural transport shape; complete-source canonical validation runs on the host.
const manifestJsonSchema = { type: 'object' as const, additionalProperties: true };
const json = (schema: z.ZodType): Record<string, unknown> => toJSONSchema(schema, {
  override({ zodSchema, jsonSchema }) {
    if (Object.is(zodSchema, legacyWorkLedgerManifestSchema)) Object.assign(jsonSchema, manifestJsonSchema);
    if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
  },
});

export const builtinGatewayWorkLedgerMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workLedger.prepareLegacyImport', title: 'Prepare Legacy Work Import', category: 'work-ledger',
    description: 'Capture bounded complete legacy sources on the selected authoritative host. Preparation does not write or grant execution authority.',
    access: 'admin', scopes: [WORK_LEDGER_READ_SCOPE, 'read:knowledge'], metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'POST', path: '/api/work-ledger/legacy-import/prepare' },
    inputSchema: json(strictObject({ projectId, sourceIds: array(string().min(1).max(200)).min(1).max(500) })),
    outputSchema: json(union([
      strictObject({ kind: literal('prepared'), manifest: legacyWorkLedgerManifestSchema }),
      strictObject({ kind: literal('blocked'), code: string(), reason: string() }),
    ])),
  }),
  methodDescriptor({
    id: 'workLedger.importLegacy', title: 'Import Legacy Work Atomically', category: 'work-ledger',
    description: 'Import one reviewed versioned legacy manifest with durable exact-request replay. Preserves source records, grants no execution or verification authority.',
    access: 'admin', scopes: [WORK_LEDGER_IMPORT_SCOPE, 'read:knowledge'], metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'POST', path: '/api/work-ledger/legacy-import' },
    inputSchema: { type: 'object', additionalProperties: false, required: ['type','requestId','expectedRevision','manifest'],
      properties: { type: { type: 'string', enum: ['import_legacy'] }, requestId: { type: 'string', minLength: 1, maxLength: 200 }, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, manifest: manifestJsonSchema } },
    outputSchema: json(union([
      strictObject({ kind: literal('accepted'), replayed: boolean(), event: ledgerEventSchema }),
      strictObject({ kind: literal('rejected'), code: string(), reason: string(), revision: sequence.nullable() }),
      strictObject({ kind: literal('indeterminate'), requestId: projectId, actorId: projectId, reason: string() }),
    ])),
  }),
  methodDescriptor({
    id: 'workLedger.snapshot', title: 'Read Native Work Ledger', category: 'work-ledger',
    description: 'Read the selected host project ledger, without mutation authority or allowedActions. Requires an owner operator and the dedicated read scope.',
    access: 'admin', scopes: [WORK_LEDGER_READ_SCOPE],
    metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'GET', path: '/api/work-ledger/snapshot' },
    inputSchema: json(strictObject({ projectId })), outputSchema: json(workLedgerReadSnapshotSchema),
  }),
  methodDescriptor({
    id: 'workLedger.history', title: 'Read Native Work Ledger History', category: 'work-ledger',
    description: 'Read at most 100 events after an exclusive cursor, pinned to a history high-water mark. Advance with cursor while hasMore is true. No mutations or execution.',
    access: 'admin', scopes: [WORK_LEDGER_READ_SCOPE],
    metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'GET', path: '/api/work-ledger/history' },
    inputSchema: json(strictObject({ projectId, afterSequence: sequence, throughSequence: sequence.optional() })),
    outputSchema: json(workLedgerHistoryPageSchema),
  }),
];
