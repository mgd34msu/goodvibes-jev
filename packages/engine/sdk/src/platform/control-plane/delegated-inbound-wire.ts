/** Owner choices only. No source body, token, caller-minted provenance or implicit defaults. */
import { z } from 'zod/v4';
const id = z.string().min(1).max(256);
const duration = z.number().int().min(1).max(2_147_483_647);
export const delegatedSourceRefSchema = z.object({ sessionId: id, inputId: id, sourceId: id, sourceRevision: id, requestId: id }).strict();
export const delegatedTelegramConfigureSchema = z.object({
  chatId: id, threadId: id.optional(), accountId: id,
  pendingRetention: z.literal('memory-only-until-deadline'), pendingRetentionMs: duration, configurationLifetimeMs: duration,
  onExpiry: z.literal('release-original-and-hold'),
}).strict();
export const delegatedInboundChoicesSchema = z.object({
    processingPurpose: z.literal('accept-external-message-for-owner-review'),
    sourceRetention: z.literal('memory-only-until-review-close-or-deadline'), sourceRetentionMs: duration,
    derivedRecord: z.literal('external-source-reference-only-v1'), derivedRecordRetentionMs: duration,
    execution: z.literal('none'), ownerMayReadOriginal: z.literal(true),
  }).strict();
export const delegatedTelegramDecisionSchema = z.object({
  approvalId: id, ref: delegatedSourceRefSchema,
  approved: z.boolean(),
  choices: delegatedInboundChoicesSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.choices && value.choices.derivedRecordRetentionMs < value.choices.sourceRetentionMs) ctx.addIssue({ code: 'custom', message: 'Review record must outlive its original-source memory window.' });
  if (value.approved !== (value.choices !== undefined)) ctx.addIssue({ code: 'custom', message: 'Approval requires explicit choices; denial must not carry a grant.' });
});
export const delegatedTelegramLookupSchema = z.object({ ref: delegatedSourceRefSchema }).strict();
export const delegatedTelegramRevokeSchema = z.object({ configurationId: id }).strict();
export type DelegatedTelegramConfiguration = z.infer<typeof delegatedTelegramConfigureSchema>;
export type DelegatedTelegramDecision = z.infer<typeof delegatedTelegramDecisionSchema>;
export type DelegatedInboundChoices = NonNullable<DelegatedTelegramDecision['choices']>;

export const delegatedReviewRecordSchema = z.object({
  id, ref: delegatedSourceRefSchema,
  origin: z.object({ kind: z.literal('external-original'), accountId: id, accountRevision: id, routeId: id, routeRevision: id }).strict(),
  configurationId: id, ownerRevision: id, workspaceRevision: id, approvalId: id, choices: delegatedInboundChoicesSchema,
  acceptedAt: z.number(), sourceExpiresAt: z.number(), recordExpiresAt: z.number(),
  state: z.enum(['accepted-for-review', 'cancelled']), execution: z.literal('not-started'),
}).strict();
export const delegatedTelegramResultSchema = z.object({
  outcome: z.string().optional(), reason: z.string().optional(), ref: delegatedSourceRefSchema.optional(),
  configurationId: id.optional(), expiresAt: z.number().optional(), pendingRetentionMs: duration.optional(),
  processing: z.string().optional(), restart: z.string().optional(), route: z.string().optional(),
  execution: z.literal('not-started').optional(), approvalId: id.optional(), source: z.string().optional(), recovery: z.string().optional(),
  record: delegatedReviewRecordSchema.optional(), records: z.array(delegatedReviewRecordSchema).optional(),
  pending: z.array(z.object({ ref: delegatedSourceRefSchema, approvalId: id, sourceExpiresAt: z.number(), outcome: z.string() }).strict()).optional(),
  original: z.object({ text: z.string(), unsupportedSources: z.array(z.object({ kind: z.string(), label: z.string() }).strict()) }).strict().optional(),
}).strict();
