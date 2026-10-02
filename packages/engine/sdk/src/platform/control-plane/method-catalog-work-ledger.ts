import { z } from 'zod';
import { ledgerWorkSchema, ledgerAttemptSchema, ledgerEvidenceSchema, ledgerEventSchema } from '../workflow/work-ledger/types.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';

/** Dedicated capability. Never reuse fleet, workspace, or generic event scopes. */
export const WORK_LEDGER_READ_SCOPE = 'read:work-ledger';
export const WORK_LEDGER_HISTORY_PAGE_SIZE = 100;
export const WORK_LEDGER_READ_MAX_BYTES = 1_048_576;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const projectId = z.string().min(1).max(200);
const readView = z.strictObject({
  work: ledgerWorkSchema,
  attempt: ledgerAttemptSchema.nullable(),
  verification: z.strictObject({
    state: z.enum(['unverified', 'verified', 'failed', 'unavailable', 'stale']),
    reason: z.string(),
    evidence: ledgerEvidenceSchema.nullable(),
  }),
  attention: z.array(z.strictObject({ kind: z.enum(['blocked', 'verification']), reason: z.string() })),
});
export const workLedgerReadSnapshotSchema = z.strictObject({
  projectId, revision: sequence, cursor: sequence, works: z.array(readView),
});
export const workLedgerHistoryPageSchema = z.strictObject({
  projectId, afterSequence: sequence, cursor: sequence, throughSequence: sequence,
  hasMore: z.boolean(), events: z.array(ledgerEventSchema).max(WORK_LEDGER_HISTORY_PAGE_SIZE),
});
export type WorkLedgerHistoryPage = z.infer<typeof workLedgerHistoryPageSchema>;
const json = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema);

export const builtinGatewayWorkLedgerMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workLedger.snapshot', title: 'Read Native Work Ledger', category: 'work-ledger',
    description: 'Read the selected host project ledger, without mutation authority or allowedActions. Requires an owner operator and the dedicated read scope.',
    access: 'admin', scopes: [WORK_LEDGER_READ_SCOPE],
    metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'GET', path: '/api/work-ledger/snapshot' },
    inputSchema: json(z.strictObject({ projectId })), outputSchema: json(workLedgerReadSnapshotSchema),
  }),
  methodDescriptor({
    id: 'workLedger.history', title: 'Read Native Work Ledger History', category: 'work-ledger',
    description: 'Read at most 100 events after an exclusive cursor, pinned to a history high-water mark. Advance with cursor while hasMore is true. No mutations or execution.',
    access: 'admin', scopes: [WORK_LEDGER_READ_SCOPE],
    metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'GET', path: '/api/work-ledger/history' },
    inputSchema: json(z.strictObject({ projectId, afterSequence: sequence, throughSequence: sequence.optional() })),
    outputSchema: json(workLedgerHistoryPageSchema),
  }),
];
