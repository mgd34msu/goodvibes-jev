import type { PermissionPromptDecision } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { ApprovalBroker, type SharedApprovalDecision, type SharedApprovalDisposition } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createWorkspaceTrustDecisionAsk } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

declare const ordinary: PermissionPromptDecision;
// @ts-expect-error Provenance is intentionally not added to the ordinary awaited result.
ordinary.disposition;
const recorded: SharedApprovalDecision = { approved: false, disposition: 'amended' };
const disposition: SharedApprovalDisposition | undefined = recorded.disposition;
declare const broker: ApprovalBroker;
const ask: () => Promise<'trusted' | 'restricted'> = createWorkspaceTrustDecisionAsk({ broker, workingDirectory: '/fixture' });
const legacy: Promise<PermissionPromptDecision> = broker.requestApproval({
  request: { callId: 'fixture', tool: 'read', args: {}, category: 'read', analysis: { classification: 'fixture', riskLevel: 'low', summary: 'fixture', reasons: [] } },
});
export { recorded, disposition, ask, legacy };
