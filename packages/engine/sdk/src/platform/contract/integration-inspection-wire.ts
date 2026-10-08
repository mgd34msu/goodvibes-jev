/** Ephemeral, read-only integration facts. This browser-safe vocabulary carries no authority. */
import { array, boolean, enum as enumSchema, literal, number, strictObject, string, union, type z } from 'zod/v4';
import { CHECK_RESULTS, CHECK_TRIGGERS, CONTRACT_UNIT_STATUSES } from '../../events/contract.js';

/** Leave room for the authenticated execution envelope within its existing 16 KiB limit. */
export const CONTRACT_INTEGRATION_MAX_BYTES = 12_288;
const id = string().min(1).max(200);
const path = string().max(CONTRACT_INTEGRATION_MAX_BYTES);
const count = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const contractIntegrationItemSchema = union([
  strictObject({
    state: literal('recorded'), itemId: id, workstreamId: id,
    integration: enumSchema(['unrecorded', 'pending', 'merged', 'conflict']),
    mergeHash: string().min(1).max(200).optional(),
    worktreePath: path.optional(), worktreeBranch: path.optional(), worktreeKept: boolean().optional(),
    // Absence means not recorded, not an empty/conflict-free path list.
    conflictFiles: array(path).max(256).optional(),
  }),
  strictObject({ state: literal('unavailable'), reason: enumSchema(['missing-item', 'invalid-join']) }),
  strictObject({ state: literal('not-applicable'), reason: literal('best-of-n-plan') }),
]);

export const contractIntegrationUnitSchema = strictObject({
  unitId: id, groupId: id, attemptOf: id.optional(), attemptIndex: count.optional(),
  unitStatus: enumSchema(CONTRACT_UNIT_STATUSES),
  latestCheck: strictObject({ id, at: count, trigger: enumSchema(CHECK_TRIGGERS), result: enumSchema(CHECK_RESULTS) }).nullable(),
  item: contractIntegrationItemSchema,
});

export const contractIntegrationInspectionSchema = union([
  strictObject({ state: literal('live'), contractId: id, isolation: literal('worktree'), units: array(contractIntegrationUnitSchema).max(256) }),
  strictObject({ state: literal('unavailable'), reason: enumSchema(['not-live', 'no-engine', 'no-receipt', 'stale-attempt', 'recovery-required', 'unsupported-runner', 'invalid-data', 'limit']) }),
  strictObject({ state: literal('not-applicable'), contractId: id, reason: enumSchema(['session-mode', 'shared-isolation']) }),
]);
export type ContractIntegrationItem = z.infer<typeof contractIntegrationItemSchema>;
export type ContractIntegrationUnit = z.infer<typeof contractIntegrationUnitSchema>;
export type ContractIntegrationInspection = z.infer<typeof contractIntegrationInspectionSchema>;
