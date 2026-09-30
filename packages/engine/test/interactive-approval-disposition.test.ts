import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import { handleInteractiveApprovalAction } from '../sdk/src/platform/daemon/facade-approval-action.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REQUEST: PermissionPromptRequest = { callId: 'fixture', tool: 'workspace-trust', args: { workspace: '/fixture' }, category: 'read', analysis: { classification: 'workspace-trust', riskLevel: 'high', summary: 'Fixture trust', reasons: ['fixture'] } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'interactive-approval-fixture-')); roots.push(root);
  const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  const paths: string[] = [];
  const context = { broker, async parseBody() { return { note: 'fixture note', remember: true, disposition: 'untrusted ignored value' }; }, actor: () => 'fixture-owner', record: (_req: Request, path: string, response: Response) => { paths.push(path); return response; } };
  return { broker, context, paths };
}
for (const action of ['approve', 'deny'] as const) {
  test(`explicit interactive ${action} stamps from its action and retains attribution and ordinary result`, async () => {
    const f = fixture(); const raised = await f.broker.raiseApproval({ request: REQUEST });
    const response = await handleInteractiveApprovalAction(f.context, raised.approval.id, action, new Request('http://127.0.0.1/fixture'));
    expect(response.status).toBe(200);
    expect(f.broker.getApproval(raised.approval.id)?.decision).toEqual({ approved: action === 'approve', disposition: action === 'approve' ? 'approved' : 'denied', remember: true });
    expect(f.broker.getApproval(raised.approval.id)?.resolvedBy).toBe('fixture-owner');
    expect(await raised.decision).toEqual({ approved: action === 'approve', remember: true });
    expect(f.paths).toEqual([`/api/approvals/${raised.approval.id}/${action}`]);
  });
}
test('interactive claim remains pending; cancel is nonpersistent provenance', async () => {
  const f = fixture(); const raised = await f.broker.raiseApproval({ request: REQUEST });
  const req = new Request('http://127.0.0.1/fixture');
  expect((await handleInteractiveApprovalAction(f.context, raised.approval.id, 'claim', req)).status).toBe(200);
  expect(f.broker.getApproval(raised.approval.id)?.status).toBe('claimed');
  expect(f.broker.getApproval(raised.approval.id)?.decision).toBeUndefined();
  expect((await handleInteractiveApprovalAction(f.context, raised.approval.id, 'cancel', req)).status).toBe(200);
  expect(f.broker.getApproval(raised.approval.id)?.decision?.disposition).toBe('cancelled');
  expect(await raised.decision).toEqual({ approved: false, remember: false });
  expect((await handleInteractiveApprovalAction(f.context, 'missing', 'approve', req)).status).toBe(404);
});
