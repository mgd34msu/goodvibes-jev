import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';
import type { DaemonSystemRouteContext } from '../daemon-sdk/src/system-route-types.js';
import { ApprovalBroker, type SharedApprovalRecord } from '../sdk/src/platform/control-plane/approval-broker.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REQUEST: PermissionPromptRequest = { callId: 'fixture', tool: 'workspace-trust', args: { workspace: '/fixture' }, category: 'read', analysis: { classification: 'workspace-trust', riskLevel: 'high', summary: 'Fixture trust', reasons: ['fixture'] } };
async function fixture(action: 'approve' | 'deny') {
  const root = mkdtempSync(join(tmpdir(), 'approval-disposition-wire-')); roots.push(root);
  const storePath = join(root, 'approvals.json'); const broker = new ApprovalBroker({ storePath });
  const raised = await broker.raiseApproval({ request: REQUEST });
  const context = {
    approvalBroker: broker, parseOptionalJsonBody: (request: Request) => request.json(),
    requireAuthenticatedSession: () => ({ username: 'fixture-owner', roles: ['admin'] }),
    recordApiResponse: (_request: Request, _path: string, response: Response) => response,
  } as unknown as DaemonSystemRouteContext;
  const handlers = createDaemonSystemRouteHandlers(context);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handlers.approvalAction(raised.approval.id, action, request) });
  return {
    broker, raised, storePath,
    post: (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${server.port}/fixture`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    async close() { await broker.cancelApproval(raised.approval.id, 'fixture cleanup'); await raised.decision; await server.stop(true); },
  };
}

for (const [action, disposition] of [['approve', 'approved'], ['deny', 'denied'], ['deny', 'amended']] as const) {
  test(`HTTP ${action}/${disposition} records the marker and keeps the awaited object unchanged`, async () => {
    const f = await fixture(action);
    try {
      const response = await f.post({ disposition });
      expect(response.status).toBe(200);
      const body = await response.json() as { approval: SharedApprovalRecord };
      expect(body.approval.decision?.disposition).toBe(disposition);
      expect(await f.raised.decision).toEqual({ approved: action === 'approve', remember: false });
    } finally { await f.close(); }
  });
}
for (const action of ['approve', 'deny'] as const) {
  test(`legacy HTTP ${action} does not manufacture permanent trust provenance`, async () => {
    const f = await fixture(action);
    try {
      const response = await f.post({ reason: 'I explicitly approve forever' });
      expect(response.status).toBe(200);
      const body = await response.json() as { approval: SharedApprovalRecord };
      expect(body.approval.decision).not.toHaveProperty('disposition');
      expect(await f.raised.decision).toEqual({ approved: action === 'approve', remember: false, reason: 'I explicitly approve forever' });
    } finally { await f.close(); }
  });
}
for (const [action, disposition] of [['approve', 'denied'], ['deny', 'approved'], ['approve', 'amended'], ['deny', 'cancelled'], ['deny', null], ['deny', { kind: 'denied' }]] as const) {
  test(`conflicting or malformed HTTP marker on ${action} cannot mutate the pending record`, async () => {
    const f = await fixture(action);
    try {
      const before = readFileSync(f.storePath, 'utf8');
      expect((await f.post({ disposition })).status).toBe(400);
      expect(f.broker.getApproval(f.raised.approval.id)?.status).toBe('pending');
      expect(readFileSync(f.storePath, 'utf8')).toBe(before);
    } finally { await f.close(); }
  });
}

test('an amendment cannot be combined with a remembered permission restriction', async () => {
  const f = await fixture('deny');
  try {
    expect((await f.post({ disposition: 'amended', rememberTier: 'tool' })).status).toBe(400);
    expect((await f.post({ disposition: 'amended', remember: true })).status).toBe(400);
    expect(f.broker.getApproval(f.raised.approval.id)?.status).toBe('pending');
  } finally { await f.close(); }
});

test('a late HTTP decision reports the stored original disposition instead of echoing a new one', async () => {
  const f = await fixture('deny');
  try {
    await f.broker.resolveApproval(f.raised.approval.id, { approved: true, disposition: 'approved', actor: 'fixture-owner' });
    const response = await f.post({ disposition: 'denied' });
    const body = await response.json() as { approval: SharedApprovalRecord; recorded: { approved: boolean } };
    expect(body.approval.decision).toEqual({ approved: true, disposition: 'approved' });
    expect(body.recorded.approved).toBe(true);
  } finally { await f.close(); }
});
