import { toJSONSchema, type z } from 'zod/v4';
import { nativeHostedTurnRequestSchema, nativeHostedTurnLookupSchema } from '../hosted-sessions/native-turn-wire.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';
const json = (schema: z.ZodType): Record<string, unknown> => toJSONSchema(schema, {
  override({ jsonSchema }) { if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; } },
});
export const builtinGatewayNativeHostedTurnMethodDescriptors: readonly GatewayMethodDescriptor[] = (['start', 'status', 'cancel'] as const).map(operation => methodDescriptor({
  id: `workLedger.turn.${operation}`, title: `${operation[0]!.toUpperCase()}${operation.slice(1)} Native Hosted Turn`, category: 'work-ledger',
  description: operation === 'start' ? 'Deliver an already admitted native conversation input at most once through a host-owned broker identity and durable dispatch claim. Accepts source identity only. Ambiguous dispatch requires inspection and is never replayed.'
    : operation === 'status' ? 'Read native hosted dispatch status. Does not admit, claim, retry or execute.'
    : 'Persist cancellation of the exact native hosted dispatch and drain its owned turn. Cancellation does not undo effects already performed.',
  access: 'admin', scopes: ['read:work-ledger', 'write:work-ledger', 'write:sessions'], metadata: { requiresFreshOperatorAuth: true },
  http: { method: 'POST', path: `/api/work-ledger/turn/${operation}` },
  inputSchema: json(nativeHostedTurnRequestSchema), outputSchema: json(nativeHostedTurnLookupSchema),
}));
