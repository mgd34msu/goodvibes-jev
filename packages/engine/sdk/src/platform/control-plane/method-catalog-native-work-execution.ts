import { strictObject, toJSONSchema, type z } from 'zod/v4';
import {
  nativeWorkExecutionRequestSchema,
  nativeWorkExecutionSnapshotSchema,
  nativeWorkLedgerProjectSchema,
} from '../workflow/work-ledger/native-execution-wire.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';

const json = (schema: z.ZodType): Record<string, unknown> => toJSONSchema(schema, {
  override({ jsonSchema }) { if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; } },
});

const operations = [
  ['start', 'Start Native Work Execution', 'Start one existing complete native work attempt using host-owned source and paired authority. Exact replays preserve identity; interrupted or refused intents require explicit resume, and cancelled intents never restart.'],
  ['status', 'Read Native Work Execution', 'Inspect a bounded execution or admission-intent projection for an existing native attempt. Intent projections contain no receipt or execution progress. Returns stored revisions even if the caller revision is stale.'],
  ['cancel', 'Cancel Native Work Execution', 'Persist cancellation for the selected existing attempt, including a pending initial admission. A distinct prevented-before-admission result carries no receipt; admitted execution cancellation waits for actual drainage. A lost response does not establish success.'],
  ['resume', 'Resume Native Work Execution', 'Explicitly resume an interrupted/refused intent with a fresh evaluation or recover one prepared execution under current paired authority. Original target stays fixed. Cancelled intents require a new legitimate attempt; launch-claimed effects are never replayed.'],
] as const;

export const builtinGatewayNativeWorkExecutionMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workLedger.project', title: 'Read Native Work Project', category: 'work-ledger',
    description: 'Read only the selected host project identity. Does not confer execution eligibility or authority.',
    access: 'admin', scopes: ['read:work-ledger'], metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'GET', path: '/api/work-ledger/project' },
    inputSchema: json(strictObject({})), outputSchema: json(nativeWorkLedgerProjectSchema),
  }),
  ...operations.map(
    ([operation, title, description]) => methodDescriptor({
      id: `workLedger.execution.${operation}`,
      title, description, category: 'work-ledger',
      access: 'admin', scopes: ['read:work-ledger', 'write:fleet'],
      metadata: { requiresFreshOperatorAuth: true },
      http: { method: 'POST', path: `/api/work-ledger/execution/${operation}` },
      inputSchema: json(nativeWorkExecutionRequestSchema),
      outputSchema: json(nativeWorkExecutionSnapshotSchema),
    }),
  ),
];
