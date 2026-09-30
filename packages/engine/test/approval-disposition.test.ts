import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import type { ExplicitApprovalDisposition } from '../sdk/src/platform/control-plane/approval-disposition.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'approval-disposition-fixture-')); roots.push(root);
  const storePath = join(root, 'approvals.json');
  return { broker: new ApprovalBroker({ storePath }), storePath };
}
function request(callId = 'fixture', path = 'fixture.txt'): PermissionPromptRequest {
  return { callId, tool: 'edit', args: { path }, category: 'write', analysis: { classification: 'file-write', riskLevel: 'medium', summary: 'Fixture write', reasons: ['fixture'] } };
}

for (const [approved, disposition] of [[true, 'approved'], [false, 'denied'], [false, 'amended']] as const) {
  test(`explicit ${disposition} is recorded without widening the awaited legacy decision`, async () => {
    const { broker, storePath } = fixture();
    const raised = await broker.raiseApproval({ request: request() });
    await broker.resolveApproval(raised.approval.id, { approved, disposition, reason: 'fixture feedback', actor: 'fixture-owner' });
    expect(await raised.decision).toEqual({ approved, reason: 'fixture feedback' });
    expect(raised.approval.status).toBe('pending');
    expect(broker.getApproval(raised.approval.id)?.decision).toEqual({ approved, disposition, reason: 'fixture feedback' });
    const reopened = new ApprovalBroker({ storePath }); await reopened.start();
    expect(reopened.getApproval(raised.approval.id)?.decision?.disposition).toBe(disposition);
  });
}

for (const approved of [true, false]) {
  test(`legacy ${approved} remains valid, exact and markerless`, async () => {
    const { broker } = fixture();
    const modifiedArgs = { path: 'adjusted-fixture.txt' };
    const result = await broker.requestApproval({ request: request(), localPrompt: async () => ({ approved, remember: true, rememberTier: 'session', reason: 'fixture', modifiedArgs }) });
    expect(result).toEqual({ approved, remember: true, rememberTier: 'session', reason: 'fixture', modifiedArgs });
    expect(broker.listApprovals()[0]?.decision).toEqual(result);
    expect(broker.listApprovals()[0]?.decision).not.toHaveProperty('disposition');
  });
}

test('cancellation and expiry are recorded separately while awaited refusals stay exact', async () => {
  const { broker } = fixture();
  const cancelled = await broker.raiseApproval({ request: request('cancelled') });
  await broker.cancelApproval(cancelled.approval.id, 'fixture-owner');
  expect(await cancelled.decision).toEqual({ approved: false, remember: false });
  expect(broker.getApproval(cancelled.approval.id)?.decision?.disposition).toBe('cancelled');
  const expired = await broker.raiseApproval({ request: request('expired'), timeoutMs: 20 });
  expect(await expired.decision).toEqual({ approved: false, remember: false });
  expect(broker.getApproval(expired.approval.id)?.decision?.disposition).toBe('expired');
});

test('a remembered sweep does not claim each covered ask was explicitly answered', async () => {
  const { broker } = fixture();
  const first = await broker.raiseApproval({ request: request('first', 'one.txt') });
  const second = await broker.raiseApproval({ request: request('second', 'two.txt') });
  await broker.resolveApproval(first.approval.id, { approved: false, disposition: 'denied', rememberTier: 'tool', actor: 'fixture-owner' });
  expect(await first.decision).toEqual({ approved: false, rememberTier: 'tool' });
  expect(await second.decision).toEqual({ approved: false });
  expect(broker.getApproval(first.approval.id)?.decision?.disposition).toBe('denied');
  expect(broker.getApproval(second.approval.id)?.decision?.disposition).toBe('remembered');
});

for (const [approved, disposition] of [
  [true, 'denied'], [true, 'amended'], [false, 'approved'], [false, 'expired'],
  [false, 'remembered'], [false, 'unknown'], [false, null], ['true', 'approved'],
] as const) {
  test(`invalid decision pair ${String(approved)}/${String(disposition)} is rejected before mutation`, async () => {
    const { broker, storePath } = fixture();
    const raised = await broker.raiseApproval({ request: request() });
    const before = readFileSync(storePath, 'utf8');
    try {
      const input = { approved, disposition, actor: 'fixture-owner' } as unknown as Parameters<ApprovalBroker['resolveApproval']>[1];
      await expect(broker.resolveApproval(raised.approval.id, input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
      expect(broker.getApproval(raised.approval.id)?.status).toBe('pending');
      expect(readFileSync(storePath, 'utf8')).toBe(before);
    } finally { await broker.cancelApproval(raised.approval.id, 'fixture cleanup'); await raised.decision; }
  });
}

test('a persisted contradictory marker is refused rather than normalized into authority', async () => {
  const { broker, storePath } = fixture();
  const raised = await broker.raiseApproval({ request: request() });
  await broker.resolveApproval(raised.approval.id, { approved: true, disposition: 'approved', actor: 'fixture-owner' });
  await raised.decision;
  const snapshot = JSON.parse(readFileSync(storePath, 'utf8')) as { approvals: Array<{ decision: unknown }> };
  snapshot.approvals[0]!.decision = { approved: true, disposition: 'denied' satisfies ExplicitApprovalDisposition };
  writeFileSync(storePath, JSON.stringify(snapshot));
  await expect(new ApprovalBroker({ storePath }).start()).rejects.toThrow('snapshot is invalid');
});
