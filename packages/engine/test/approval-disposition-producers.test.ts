import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.js';
import { createOperatorClient } from '../sdk/src/platform/runtime/operator-client.js';
import type { OperatorClientServices } from '../sdk/src/platform/runtime/foundation-services.js';
import { createHttpTransport } from '../sdk/src/platform/runtime/transports/daemon-http-client.js';
import { createClientApprovalRaiser } from '../sdk/src/platform/runtime/client/approval-raiser.js';
import type { PermissionPromptRequest } from '../sdk/src/platform/permissions/prompt.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REQUEST: PermissionPromptRequest = { callId: 'fixture', tool: 'workspace-trust', args: { workspace: '/fixture' }, category: 'read', analysis: { classification: 'workspace-trust', riskLevel: 'high', summary: 'Fixture trust', reasons: ['fixture'] } };
function broker() {
  const root = mkdtempSync(join(tmpdir(), 'approval-producer-fixture-')); roots.push(root);
  return new ApprovalBroker({ storePath: join(root, 'approvals.json') });
}

for (const action of ['approve', 'deny'] as const) {
  test(`the explicit direct ${action} operation records its known choice`, async () => {
    const actual = broker(); const raised = await actual.raiseApproval({ request: REQUEST });
    const client = createOperatorClient({ approvalBroker: actual } as unknown as OperatorClientServices);
    const record = await client.approvals[action](raised.approval.id, 'fixture-owner');
    expect(record?.decision?.disposition).toBe(action === 'approve' ? 'approved' : 'denied');
    expect(await raised.decision).toEqual({ approved: action === 'approve' });
  });
  test(`the explicit HTTP transport ${action} operation sends its known marker without live I/O`, async () => {
    const calls: Record<string, unknown>[] = [];
    const actual = broker();
    const raised = await actual.raiseApproval({ request: REQUEST });
    const record = await actual.resolveApproval(raised.approval.id, {
      approved: action === 'approve', disposition: action === 'approve' ? 'approved' : 'denied', actor: 'fixture-owner',
    });
    await raised.decision;
    const fetchImpl = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ approval: record });
    }, { preconnect() {} });
    const transport = createHttpTransport({ baseUrl: 'http://127.0.0.1:1', fetchImpl });
    await transport.operator.approvals[action]('fixture', 'fixture-owner');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.disposition).toBe(action === 'approve' ? 'approved' : 'denied');
  });
}

test('generic direct resolution keeps legacy provenance absent', async () => {
  const actual = broker(); const raised = await actual.raiseApproval({ request: REQUEST });
  const client = createOperatorClient({ approvalBroker: actual } as unknown as OperatorClientServices);
  const record = await client.approvals.resolve(raised.approval.id, { approved: true, actor: 'fixture-callback' });
  expect(record?.decision).toEqual({ approved: true });
  expect(await raised.decision).toEqual({ approved: true });
});

for (const approved of [true, false]) {
  test(`generic callback ${approved} is reported without manufacturing an explicit marker`, async () => {
    const reports: { methodId: string; input: unknown }[] = [];
    let recorded!: () => void;
    const recording = new Promise<void>((resolve) => { recorded = resolve; });
    const raise = createClientApprovalRaiser({
      actor: 'fixture-callback', localPrompt: () => async () => ({ approved, reason: 'unattributed fixture reason' }),
      subscribeApprovalUpdates: async () => ({ close() {} }),
      verbs: {
        probe: () => ({ available: true as const }),
        async invoke<T>(methodId: string, input?: unknown): Promise<T> {
          if (methodId === 'approvals.raise') return { approval: { id: 'fixture' } } as T;
          if (methodId === 'approvals.list') return [] as T;
          reports.push({ methodId, input }); recorded(); return {} as T;
        },
      },
    });
    expect(await raise({ request: REQUEST })).toEqual({ approved, reason: 'unattributed fixture reason' });
    await recording;
    expect(reports[0]?.methodId).toBe(approved ? 'approvals.approve' : 'approvals.deny');
    expect(reports[0]?.input).not.toHaveProperty('disposition');
  });
}
