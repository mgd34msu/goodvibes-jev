import { z, toJSONSchema } from 'zod/v4';
import { methodDescriptor } from './method-catalog-shared.js';
import { delegatedTelegramResultSchema, delegatedTelegramConfigureSchema, delegatedTelegramDecisionSchema, delegatedTelegramLookupSchema, delegatedTelegramRevokeSchema } from './delegated-inbound-wire.js';
const operations = { configure: delegatedTelegramConfigureSchema, decide: delegatedTelegramDecisionSchema, status: delegatedTelegramLookupSchema, revoke: delegatedTelegramRevokeSchema, list: z.object({}).strict(), read: delegatedTelegramLookupSchema, cancel: delegatedTelegramLookupSchema };
export const builtinDelegatedInboundMethodDescriptors = Object.entries(operations).map(([operation, schema]) => methodDescriptor({
  id: `inbound.telegram.${operation}`, title: `Telegram Delegated Intake ${operation}`, category: 'inbound',
  description: 'Explicit paired-owner command for bounded in-memory original-source intake. Configure chooses the pending source lifetime; decide approves one exact external message and metadata-only review receipt. No execution, standing processing grant, or owner-text capture.',
  access: 'admin', scopes: ['read:work-ledger', 'write:work-ledger'], metadata: { requiresFreshOperatorAuth: true },
  http: { method: 'POST', path: `/api/inbound/telegram/${operation}` },
  inputSchema: toJSONSchema(schema), outputSchema: toJSONSchema(delegatedTelegramResultSchema),
}));
