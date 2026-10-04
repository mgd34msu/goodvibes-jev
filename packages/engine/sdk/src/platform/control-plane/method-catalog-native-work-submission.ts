import { toJSONSchema, type z } from 'zod/v4';
import {
  nativeWorkSubmissionRequestSchema,
  nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionResultSchema,
  nativeWorkSubmissionLookupResultSchema,
} from '../workflow/work-ledger/native-submission-wire.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';

/** Dedicated native-write capability; never aliases import, fleet, or execution authority. */
export const WORK_LEDGER_WRITE_SCOPE = 'write:work-ledger';

const json = (schema: z.ZodType): Record<string, unknown> => toJSONSchema(schema, {
  override({ jsonSchema }) { if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; } },
});

export const builtinGatewayNativeWorkSubmissionMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'workLedger.submit', title: 'Submit Native Work', category: 'work-ledger',
    description: 'Persist one bounded explicit-source goal and ordered criteria on the selected authoritative host. Exact request replay returns the immutable submission receipt. Does not start execution or grant verification authority. Complete encoded input is limited to 262144 bytes without truncation.',
    access: 'admin', scopes: ['read:work-ledger', WORK_LEDGER_WRITE_SCOPE], metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'POST', path: '/api/work-ledger/submissions' },
    inputSchema: json(nativeWorkSubmissionRequestSchema), outputSchema: json(nativeWorkSubmissionResultSchema),
  }),
  methodDescriptor({
    id: 'workLedger.submission.get', title: 'Read Native Work Submission', category: 'work-ledger',
    description: 'Look up an immutable native submission receipt by the original request ID on the selected authoritative host. Use after a lost submit response. Does not submit, retry, resume, or start execution.',
    access: 'admin', scopes: ['read:work-ledger', WORK_LEDGER_WRITE_SCOPE], metadata: { requiresFreshOperatorAuth: true },
    http: { method: 'POST', path: '/api/work-ledger/submissions/get' },
    inputSchema: json(nativeWorkSubmissionLookupRequestSchema), outputSchema: json(nativeWorkSubmissionLookupResultSchema),
  }),
];
