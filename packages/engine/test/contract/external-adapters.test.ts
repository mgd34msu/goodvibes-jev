/**
 * The two external work adapters (docs/design/contract-runner.md 8.4): the
 * in-process hosted adapter and the operator adapter over `contracts.*`.
 * Each dispatches a contract, polls it through running, waiting on its owner
 * and passing, fetches the result, and cancels; both report a contract the
 * same way, since they share the contracts package's mapping.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { registerContractGatewayMethods } from '../../sdk/src/platform/control-plane/routes/contracts.js';
import {
  CONTRACT_WORK_STATUS,
  createContractOperatorService,
  type ContractExternalWorkAdapter,
  type ContractOperatorService,
} from '../../sdk/src/platform/contract/index.js';
import { createHostedContractWorkAdapter, EXTERNAL_CANCEL_REASON } from '../../sdk/src/platform/hosted-sessions/contract-work-adapter.js';
import type { CreateHostedSessionInput } from '../../sdk/src/platform/hosted-sessions/types.js';
import type { HostedSessionRecord } from '../../sdk/src/platform/hosted-sessions/types.js';
import { createOperatorContractWorkAdapter, OPERATOR_WORK_CANCEL_REASON } from '../../operator-sdk/src/index.js';
import type { OperatorRemoteClient } from '../../operator-sdk/src/client-core.js';
import { escalate, fakeRunner, pass, type FakeRunner } from './operator-support.js';

const WORKDIR = '/srv/daemon-work';

interface Harness {
  readonly service: ContractOperatorService;
  readonly daemon: FakeRunner;
  readonly floor: FakeRunner;
  readonly created: CreateHostedSessionInput[];
  readonly live: Set<string>;
}

/** An operator service over a daemon runner and one floor that serves every live hosted session. */
function harness(): Harness {
  const daemon = fakeRunner();
  const floor = fakeRunner();
  const live = new Set<string>(['hosted-1']);
  const created: CreateHostedSessionInput[] = [];
  const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
  service.attachHosted({
    runners: () => [floor],
    forSession: async (sessionId) => (live.has(sessionId) ? { runner: floor, workspaceRoot: '/work/hosted' } : null),
  });
  return { service, daemon, floor, created, live };
}

function hostedAdapter(h: Harness, workspaceRoot?: string): ContractExternalWorkAdapter {
  return createHostedContractWorkAdapter({
    runner: h.service,
    hostedSessions: {
      hosts: (sessionId) => h.live.has(sessionId),
      create: async (input) => {
        h.created.push(input);
        const id = `hosted-${h.created.length + 1}`;
        h.live.add(id);
        return { id, workspaceRoot: input.workspaceRoot } as HostedSessionRecord;
      },
    },
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
}

/** An operator client whose `invoke` runs the real contracts.* handlers in process. */
function operatorAdapter(service: ContractOperatorService): { adapter: ContractExternalWorkAdapter; calls: string[] } {
  const catalog = new GatewayMethodCatalog();
  registerContractGatewayMethods(catalog, service);
  const calls: string[] = [];
  const invoke = (async (methodId: string, input?: Record<string, unknown>) => {
    calls.push(methodId);
    return catalog.invoke(methodId, { body: input ?? {}, context: { scopes: ['read:fleet', 'write:fleet'] } });
  }) as OperatorRemoteClient['invoke'];
  return { adapter: createOperatorContractWorkAdapter({ invoke }), calls };
}

/** Dispatch, poll running, poll waiting on the owner, poll and fetch after it passed: the same for both adapters. */
async function exerciseLifecycle(adapter: ContractExternalWorkAdapter, runner: FakeRunner, metadata: Record<string, unknown>): Promise<string> {
  const handle = await adapter.dispatch({ task: 'Add a --json flag to export.', contractId: 'ctr-00000abc', status: 'running', metadata });
  expect(handle.status).toBe('queued');
  expect(handle.metadata).toMatchObject({ contractId: handle.externalTaskId, requestingContractId: 'ctr-00000abc', requestingStatus: 'running' });
  const id = handle.externalTaskId;

  runner.contracts.get(id)!.status = 'running';
  expect(await adapter.status(id)).toMatchObject({ externalTaskId: id, status: 'running', progress: `Contract ${id}: running` });
  await expect(adapter.result(id)).rejects.toThrow('has not ended');

  const escalationId = escalate(runner, id, `Contract ${id} needs a decision on the flag name.`);
  const waiting = await adapter.status(id);
  expect(waiting).toMatchObject({ status: 'blocked', progress: `Contract ${id} waits on its owner: Contract ${id} needs a decision on the flag name.` });
  expect(waiting.metadata).toMatchObject({ escalationId });

  pass(runner, id, 'The flag is added, with tests.');
  const done = await adapter.status(id);
  expect(done).toMatchObject({ status: 'completed', progress: `Contract ${id} passed: 1 of 1 criterion met` });
  expect(typeof done.updatedAt).toBe('string');
  expect(await adapter.result(id)).toMatchObject({
    externalTaskId: id,
    status: 'completed',
    summary: `Contract ${id} passed: 1 of 1 criterion met`,
    output: 'The flag is added, with tests.',
  });
  return id;
}

describe('the status table', () => {
  test('every runner status maps: working statuses run, waiting on the owner blocks, ends end', () => {
    expect(CONTRACT_WORK_STATUS).toEqual({
      queued: 'queued', shaping: 'running', planning: 'running', 'checking-plan': 'running', running: 'running', judging: 'running',
      fixing: 'running', committing: 'running', 'awaiting-owner': 'blocked', passed: 'completed', failed: 'failed', cancelled: 'cancelled',
    });
  });
});

describe('the hosted adapter', () => {
  test('dispatches into a named hosted session, polls, fetches the result and cancels', async () => {
    const h = harness();
    const adapter = hostedAdapter(h);
    await exerciseLifecycle(adapter, h.floor, { sessionId: 'hosted-1' });
    expect(h.floor.started[0]).toMatchObject({ sessionId: 'hosted-1', origin: 'hosted', projectRoot: '/work/hosted' });
    expect(h.created).toEqual([]);

    const second = await adapter.dispatch({ task: 'Tidy the logger.', metadata: { sessionId: 'hosted-1' } });
    await adapter.cancel(second.externalTaskId);
    expect(h.floor.cancelled).toEqual([{ contractId: second.externalTaskId, reason: EXTERNAL_CANCEL_REASON }]);
    expect(await adapter.result(second.externalTaskId)).toMatchObject({ status: 'cancelled', summary: `Contract ${second.externalTaskId} cancelled: ${EXTERNAL_CANCEL_REASON}` });
  });

  test('creates a hosted session when none is named, in the request\'s workspace or the default one', async () => {
    const h = harness();
    await hostedAdapter(h, '/work/default').dispatch({ task: 'Do the thing.' });
    await hostedAdapter(h, '/work/default').dispatch({ task: 'Do another thing.', metadata: { workspaceRoot: '/work/named' } });
    expect(h.created).toEqual([{ workspaceRoot: '/work/default' }, { workspaceRoot: '/work/named' }]);
    expect(h.floor.started.map((input) => input.sessionId)).toEqual(['hosted-2', 'hosted-3']);
  });

  test('refuses a session it does not host, a dispatch with nowhere to work, and an unknown task id', async () => {
    const h = harness();
    await expect(hostedAdapter(h).dispatch({ task: 'Do it.', metadata: { sessionId: 'hosted-nobody' } })).rejects.toThrow('hosts no live session');
    await expect(hostedAdapter(h).dispatch({ task: 'Do it.' })).rejects.toThrow('needs metadata.workspaceRoot');
    await expect(hostedAdapter(h).status('ctr-ffffffff')).rejects.toThrow('No contract');
    await expect(hostedAdapter(h).cancel('ctr-ffffffff')).rejects.toThrow('No contract');
  });
});

describe('the operator adapter', () => {
  test('dispatches through contracts.start, polls and fetches through contracts.get, cancels through contracts.cancel', async () => {
    const h = harness();
    const { adapter, calls } = operatorAdapter(h.service);
    const id = await exerciseLifecycle(adapter, h.daemon, { workspaceRoot: '/work/partner', isolation: 'shared' });
    expect(h.daemon.started[0]).toMatchObject({ ask: 'Add a --json flag to export.', origin: 'external', projectRoot: '/work/partner', isolation: 'shared' });
    expect(calls[0]).toBe('contracts.start');
    expect(calls.slice(1).every((methodId) => methodId === 'contracts.get')).toBe(true);

    const second = await adapter.dispatch({ task: 'Other work.', metadata: { sessionId: 'hosted-1' } });
    expect(h.floor.started[0]).toMatchObject({ sessionId: 'hosted-1', origin: 'hosted' });
    await adapter.cancel(second.externalTaskId, 'the partner withdrew it');
    expect(h.floor.cancelled).toEqual([{ contractId: second.externalTaskId, reason: 'the partner withdrew it' }]);
    await adapter.cancel(id);
    expect(h.daemon.cancelled).toEqual([]);
    const third = await adapter.dispatch({ task: 'Third.' });
    await adapter.cancel(third.externalTaskId);
    expect(h.daemon.cancelled).toEqual([{ contractId: third.externalTaskId, reason: OPERATOR_WORK_CANCEL_REASON }]);
  });
});
