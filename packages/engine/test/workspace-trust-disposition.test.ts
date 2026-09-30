import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker, type SharedApprovalRecord } from '../sdk/src/platform/control-plane/approval-broker.js';
import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.js';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser } from '../sdk/src/platform/runtime/workspace-trust-approval.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const WRITE: PermissionPromptRequest = { callId: 'fixture-write', tool: 'edit', args: { path: 'fixture.txt' }, category: 'write', analysis: { classification: 'file-write', riskLevel: 'medium', summary: 'Fixture write', reasons: ['fixture'] } };
function fixture(timeoutMs = 5000) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-trust-disposition-')); roots.push(root);
  const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  const paths = { projectGoodVibesRoot: join(root, '.goodvibes'), resolveProjectPath: (...parts: string[]) => join(root, '.goodvibes', ...parts) };
  const manager = new WorkspaceTrustManager({ shellPaths: paths, surfaceRoot: 'tui' });
  let report!: (record: SharedApprovalRecord) => void;
  const raised = new Promise<SharedApprovalRecord>((resolve) => { report = resolve; });
  const unsubscribe = broker.subscribe((record) => { if (record.status === 'pending') { unsubscribe(); report(record); } });
  const ask = createWorkspaceTrustDecisionAsk({ broker, workingDirectory: root, timeoutMs });
  const gate = trustGatedApprovalRaiser(manager, async () => ({ approved: true }), ask);
  const result = gate({ request: WRITE }).then((decision) => ({ decision, error: undefined }), (error: unknown) => ({ decision: undefined, error }));
  return { root, broker, manager, raised, result, trustPath: paths.resolveProjectPath('tui', 'trust.json') };
}

for (const [approved, disposition, allowed] of [[true, 'approved', true], [false, 'denied', false]] as const) {
  test(`only a fresh explicit ${disposition} record persists the operator's trust choice`, async () => {
    const f = fixture(); const pending = await f.raised;
    await f.broker.resolveApproval(pending.id, { approved, disposition, actor: 'fixture-owner', reason: 'Unrelated fixture prose must not be interpreted' });
    const result = await f.result;
    expect(result.error).toBeUndefined();
    expect(result.decision?.approved).toBe(allowed);
    expect(pending.status).toBe('pending');
    expect(f.manager.isDecided()).toBe(true);
    expect(f.manager.isCategoryAllowed('write')).toBe(allowed);
    expect(existsSync(f.trustPath)).toBe(true);
  });
}

for (const kind of ['legacy-approve', 'legacy-deny', 'amended', 'cancelled', 'expired'] as const) {
  test(`${kind} refuses the current run and creates no persistent trust choice`, async () => {
    const f = fixture(kind === 'expired' ? 20 : 5000); const pending = await f.raised;
    if (kind === 'cancelled') await f.broker.cancelApproval(pending.id, 'fixture-owner');
    else if (kind !== 'expired') await f.broker.resolveApproval(pending.id, {
      approved: kind === 'legacy-approve', ...(kind === 'amended' ? { disposition: 'amended' as const } : {}),
      actor: 'fixture-owner', reason: 'I explicitly approve this workspace',
    });
    const result = await f.result;
    expect(result.error).toMatchObject({ code: 'WORKSPACE_TRUST_DECISION_UNSETTLED' });
    expect(f.manager.isDecided()).toBe(false);
    expect(existsSync(f.trustPath)).toBe(false);
  });
}

test('a remembered denial of another ask cannot permanently restrict this workspace', async () => {
  const f = fixture(); const pending = await f.raised;
  const other = await f.broker.raiseApproval({ request: { ...pending.request, callId: 'other-fixture', args: { workspace: join(f.root, 'other') } } });
  await f.broker.resolveApproval(other.approval.id, { approved: false, disposition: 'denied', rememberTier: 'tool', actor: 'fixture-owner' });
  await other.decision;
  expect(f.broker.getApproval(pending.id)?.decision?.disposition).toBe('remembered');
  expect((await f.result).error).toMatchObject({ code: 'WORKSPACE_TRUST_DECISION_UNSETTLED' });
  expect(f.manager.isDecided()).toBe(false);
  expect(existsSync(f.trustPath)).toBe(false);
});

const corruptions: ReadonlyArray<readonly [string, (record: SharedApprovalRecord) => SharedApprovalRecord | null]> = [
  ['missing record', () => null],
  ['still pending', (record) => ({ ...record, status: 'pending' })],
  ['another approval', (record) => ({ ...record, id: 'different-approval' })],
  ['another call', (record) => ({ ...record, callId: 'different-call' })],
  ['another creation', (record) => ({ ...record, createdAt: record.createdAt + 1 })],
  ['another request call', (record) => ({ ...record, request: { ...record.request, callId: 'different-call' } })],
  ['another tool', (record) => ({ ...record, request: { ...record.request, tool: 'unrelated' } })],
  ['another category', (record) => ({ ...record, request: { ...record.request, category: 'write' } })],
  ['another workspace', (record) => ({ ...record, request: { ...record.request, args: { workspace: 'different-workspace' } } })],
  ['contradictory boolean', (record) => ({ ...record, decision: { approved: false, disposition: 'approved' } })],
  ['contradictory status', (record) => ({ ...record, status: 'denied' })],
];
for (const [label, corrupt] of corruptions) {
  test(`${label} is held before trust mutation`, async () => {
    const f = fixture(); const pending = await f.raised;
    const originalRead = f.broker.getApproval.bind(f.broker);
    const read = spyOn(f.broker, 'getApproval').mockImplementation((id) => {
      const record = originalRead(id); return record ? corrupt(record) : null;
    });
    try {
      await f.broker.resolveApproval(pending.id, { approved: true, disposition: 'approved', actor: 'fixture-owner' });
      expect((await f.result).error).toMatchObject({ code: 'WORKSPACE_TRUST_DECISION_UNSETTLED' });
      expect(f.manager.isDecided()).toBe(false);
      expect(existsSync(f.trustPath)).toBe(false);
    } finally { read.mockRestore(); }
  });
}
