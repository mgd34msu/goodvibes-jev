import { toJSONSchema, type z } from 'zod/v4';
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema,
  nativeConversationIntakeTransitionRequestSchema, nativeConversationIntakeResultSchema, nativeConversationIntakeLookupResultSchema,
} from '../workflow/work-ledger/native-intake-wire.js';
import { WORK_LEDGER_WRITE_SCOPE } from './method-catalog-native-work-submission.js';
import { methodDescriptor, type GatewayMethodDescriptor } from './method-catalog-shared.js';
const json = (schema: z.ZodType): Record<string, unknown> => toJSONSchema(schema, {
  override({ jsonSchema }) { if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; } },
});
const descriptions = {
  capture: 'Persist exact original conversation text and unsupported-source disclosures on the selected authoritative host. Exact replay preserves the original source identity. Does not route, admit work, or execute. Complete encoded input is limited to 262144 bytes without truncation.',
  get: 'Read the current conversation intake or immutable admitted-work receipt by original input ID. Does not route, retry, resume, admit, or execute.',
  admit: 'Start the single initial semantic admission of captured conversation text. Replay joins the current operation or reports recovery required. Does not start execution.',
  resume: 'Explicitly recover captured conversation admission with a fresh semantic operation after interruption. Preserves source identity and terminal outcomes. Does not start execution.',
  cancel: 'Persist a terminal intake cancellation before work admission. If admission already committed, return its immutable work receipt. Does not claim cancellation of admitted work or execution.',
} as const;
export const builtinGatewayNativeConversationIntakeMethodDescriptors: readonly GatewayMethodDescriptor[] = (['capture', 'get', 'admit', 'resume', 'cancel'] as const).map(operation => methodDescriptor({
  id: `workLedger.intake.${operation}`, title: `${operation[0]!.toUpperCase()}${operation.slice(1)} Native Conversation Intake`, category: 'work-ledger',
  description: descriptions[operation], access: 'admin', scopes: ['read:work-ledger', WORK_LEDGER_WRITE_SCOPE], metadata: { requiresFreshOperatorAuth: true },
  http: { method: 'POST', path: `/api/work-ledger/intake/${operation}` },
  inputSchema: json(operation === 'capture' ? nativeConversationIntakeCaptureRequestSchema : operation === 'get' ? nativeConversationIntakeLookupRequestSchema : nativeConversationIntakeTransitionRequestSchema),
  outputSchema: json(operation === 'get' ? nativeConversationIntakeLookupResultSchema : nativeConversationIntakeResultSchema),
}));
