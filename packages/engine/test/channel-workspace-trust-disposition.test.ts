/** The channel producer's actual record provenance controls persistent workspace trust. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelIngressPolicyInput } from '../sdk/src/platform/channels/index.js';
import { ChannelPolicyManager } from '../sdk/src/platform/channels/policy-manager.js';
import { ApprovalBroker, type SharedApprovalRecord } from '../sdk/src/platform/control-plane/approval-broker.js';
import { tryResolveApprovalReplyFromChannel } from '../sdk/src/platform/daemon/approval-reply.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';
import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.js';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser } from '../sdk/src/platform/runtime/workspace-trust-approval.js';
import { useApprovalReadings } from './helpers/approval-readings.js';

const readings = useApprovalReadings();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const WRITE: PermissionPromptRequest = {
  callId: 'channel-trust-write', tool: 'edit', args: { path: 'fixture.txt' }, category: 'write',
  analysis: { classification: 'file-write', riskLevel: 'medium', summary: 'Fixture write', reasons: ['fixture'] },
};

for (const choice of ['approve', 'reject', 'amend', 'cancelled'] as const) {
  test(`channel ${choice} preserves the workspace trust distinction through the real broker`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-workspace-trust-')); roots.push(root);
    const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
    const policy = new ChannelPolicyManager({ storePath: join(root, 'policy.json') });
    const input: ChannelIngressPolicyInput = { surface: 'slack', userId: 'fixture-owner', text: 'My answer to this workspace question.', conversationKind: 'direct' };
    const channelDecision = await policy.evaluateIngress(input);
    const paths = { projectGoodVibesRoot: join(root, '.goodvibes'), resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts) };
    const manager = new WorkspaceTrustManager({ shellPaths: paths, surfaceRoot: 'tui' });
    let report!: (record: SharedApprovalRecord) => void;
    const raised = new Promise<SharedApprovalRecord>((resolve) => { report = resolve; });
    const unsubscribe = broker.subscribe((record) => { if (record.status === 'pending') { unsubscribe(); report(record); } });
    const ask = createWorkspaceTrustDecisionAsk({ broker, workingDirectory: root, timeoutMs: 5000 });
    let toolAsks = 0;
    const gate = trustGatedApprovalRaiser(manager, async () => { toolAsks++; return { approved: true }; }, ask);
    const result = gate({ request: WRITE }).then(
      (decision) => ({ decision, error: undefined }),
      (error: unknown) => ({ decision: undefined, error }),
    );
    const pending = await raised;
    readings.set({
      reply: choice === 'cancelled' ? 'approve' : choice,
      ...(choice === 'cancelled' ? { beforeReply: async () => { await broker.cancelApproval(pending.id, 'other-owner'); } } : {}),
    });
    expect(await tryResolveApprovalReplyFromChannel(input, channelDecision, {
      approvalBroker: broker, routeBindings: { getBinding: () => undefined },
    })).toBe(choice !== 'cancelled');
    const settled = await result;
    const disposition = choice === 'approve' ? 'approved' : choice === 'reject' ? 'denied' : choice === 'amend' ? 'amended' : 'cancelled';
    const record = broker.getApproval(pending.id)!;
    expect(record.decision).toMatchObject({ approved: choice === 'approve', disposition });
    expect(record.decision).not.toHaveProperty('rememberTier');
    expect(pending.status).toBe('pending');
    if (choice === 'approve' || choice === 'reject') {
      expect(settled.error).toBeUndefined();
      expect(settled.decision?.approved).toBe(choice === 'approve');
      expect(manager.isDecided()).toBe(true);
      expect(manager.isCategoryAllowed('write')).toBe(choice === 'approve');
      expect(existsSync(paths.resolveProjectPath('tui', 'trust.json'))).toBe(true);
    } else {
      expect(settled.error).toMatchObject({ code: 'WORKSPACE_TRUST_DECISION_UNSETTLED' });
      expect(manager.isDecided()).toBe(false);
      expect(existsSync(paths.resolveProjectPath('tui', 'trust.json'))).toBe(false);
    }
    expect(toolAsks).toBe(choice === 'approve' ? 1 : 0);
  });
}
