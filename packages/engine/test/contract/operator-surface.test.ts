/**
 * The contracts operator surface (docs/design/contract-runner.md 10.2): the
 * service that reads and acts across the daemon's runner and the hosted
 * floors' runners, each `contracts.*` method through the catalog, and each
 * advertised REST path reaching the same handler with the declared scope
 * enforced.
 */
import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../../sdk/src/platform/control-plane/method-catalog.js';
import { registerContractGatewayMethods } from '../../sdk/src/platform/control-plane/routes/contracts.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../../sdk/src/platform/daemon/control-plane.js';
import { GATEWAY_REST_ROUTES, dispatchDaemonApiRoutes } from '../../daemon-sdk/src/index.js';
import type { DaemonApiRouteHandlers, GatewayRestVerbInvocation } from '../../daemon-sdk/src/context.js';
import {
  ContractOperatorError,
  OPERATOR_SESSION_ID,
  createContractOperatorService,
  type ContractOperatorService,
  type HostedContractRunners,
} from '../../sdk/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';
import { escalate, fakeRunner, nextContractId, type FakeRunner } from './operator-support.js';

const WORKDIR = '/srv/daemon-work';
const HOSTED_ROOT = '/work/hosted';

interface Surface {
  readonly service: ContractOperatorService;
  readonly daemon: FakeRunner;
  readonly floor: FakeRunner;
}

/** A daemon runner, and one hosted floor runner serving the live session `hosted-1`. */
function surface(): Surface {
  const daemon = fakeRunner();
  const floor = fakeRunner();
  const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
  const hosted: HostedContractRunners = {
    runners: () => [floor],
    forSession: async (sessionId) => (sessionId === 'hosted-1' ? { runner: floor, workspaceRoot: HOSTED_ROOT } : null),
  };
  service.attachHosted(hosted);
  return { service, daemon, floor };
}

describe('the contracts operator service', () => {
  test('start without a hosted session runs on the daemon runner, origin external, in the operator session', async () => {
    const { service, daemon, floor } = surface();
    const started = await service.start({ ask: '  Add a --json flag to export.  ' });
    expect(daemon.started).toEqual([{ ask: '  Add a --json flag to export.  ', sessionId: OPERATOR_SESSION_ID, origin: 'external', projectRoot: WORKDIR }]);
    expect(floor.started).toEqual([]);
    expect(started.ownerAgentId).toBe('agent-owner-1');
    expect(started.contract.ask).toBe('  Add a --json flag to export.  ');
  });

  test('start names its session and workspace, and an isolation override', async () => {
    const { service, daemon } = surface();
    await service.start({ ask: 'Fix the flaky test.', sessionId: 'shared-9', workspaceRoot: '/work/other', isolation: 'shared' });
    expect(daemon.started).toEqual([{ ask: 'Fix the flaky test.', sessionId: 'shared-9', origin: 'external', projectRoot: '/work/other', isolation: 'shared' }]);
  });

  test('start in a live hosted session runs on its floor, origin hosted, in its workspace', async () => {
    const { service, daemon, floor } = surface();
    await service.start({ ask: 'Rename the config key.', sessionId: 'hosted-1' });
    expect(floor.started).toEqual([{ ask: 'Rename the config key.', sessionId: 'hosted-1', origin: 'hosted', projectRoot: HOSTED_ROOT }]);
    expect(daemon.started).toEqual([]);
  });

  test('start refuses a blank ask, a relative workspace, and a workspace that is not the hosted session\'s', async () => {
    const { service } = surface();
    const refusal = async (input: Parameters<ContractOperatorService['start']>[0]) => {
      try {
        await service.start(input);
      } catch (error) {
        return error instanceof ContractOperatorError ? [error.code, error.status, error.field] : error;
      }
      return 'started';
    };
    expect(await refusal({ ask: '   ' })).toEqual(['INVALID_ARGUMENT', 400, 'ask']);
    expect(await refusal({ ask: 'Do it.', workspaceRoot: 'relative/dir' })).toEqual(['INVALID_ARGUMENT', 400, 'workspaceRoot']);
    expect(await refusal({ ask: 'Do it.', sessionId: 'hosted-1', workspaceRoot: '/elsewhere' })).toEqual(['INVALID_ARGUMENT', 400, 'workspaceRoot']);
  });

  test('list joins every runner newest first, get finds a contract wherever it runs', async () => {
    const { service, daemon, floor } = surface();
    const older = makeContract({ id: nextContractId(), createdAt: 10 });
    const newer = makeContract({ id: nextContractId(), createdAt: 20, sessionId: 'hosted-1' });
    const ended = makeContract({ id: nextContractId(), createdAt: 30, status: 'passed' });
    daemon.contracts.set(older.id, older);
    daemon.contracts.set(ended.id, ended);
    floor.contracts.set(newer.id, newer);
    expect(service.list().map((contract) => contract.id)).toEqual([newer.id, older.id]);
    expect(service.list({ includeTerminal: true }).map((contract) => contract.id)).toEqual([ended.id, newer.id, older.id]);
    expect(service.list({ sessionId: 'hosted-1' }).map((contract) => contract.id)).toEqual([newer.id]);
    expect(service.get(newer.id)?.sessionId).toBe('hosted-1');
    expect(service.get('ctr-ffffffff')).toBeNull();
  });

  test('cancel and reply go to the runner that holds the contract; unknown and ended contracts are refused', async () => {
    const { service, daemon, floor } = surface();
    const held = makeContract({ id: nextContractId() });
    floor.contracts.set(held.id, held);
    const escalationId = escalate(floor, held.id, 'Contract needs a decision.');
    expect(await service.reply(held.id, escalationId, 'Approve it.')).toMatchObject({ action: 'approved' });
    expect(floor.replies).toEqual([{ contractId: held.id, escalationId, text: 'Approve it.' }]);
    expect(service.cancel(held.id, 'stop')).toBe(true);
    expect(floor.cancelled).toEqual([{ contractId: held.id, reason: 'stop' }]);
    expect(daemon.cancelled).toEqual([]);
    expect(service.cancel(held.id, 'again')).toBe(false);
    await expect(service.reply(held.id, escalationId, 'more')).rejects.toMatchObject({ code: 'CONTRACT_ENDED', status: 409 });
    expect(() => service.cancel('ctr-ffffffff', 'x')).toThrow(ContractOperatorError);
    await expect(service.reply('ctr-ffffffff', 'e1', 'x')).rejects.toMatchObject({ code: 'CONTRACT_NOT_FOUND', status: 404 });
  });

  test('without hosted runners attached, a hosted-looking session id starts on the daemon runner', async () => {
    const daemon = fakeRunner();
    const service = createContractOperatorService({ runner: daemon, workingDirectory: WORKDIR });
    await service.start({ ask: 'Do it.', sessionId: 'hosted-1' });
    expect(daemon.started[0]).toMatchObject({ sessionId: 'hosted-1', origin: 'external' });
  });
});

// ── the methods and their REST paths ─────────────────────────────────────────

function catalogFor(service: ContractOperatorService): GatewayMethodCatalog {
  const catalog = new GatewayMethodCatalog();
  registerContractGatewayMethods(catalog, service);
  return catalog;
}

function helperFor(catalog: GatewayMethodCatalog): DaemonControlPlaneHelper {
  // Only `gatewayMethods` is touched on the invoke and scope path.
  return new DaemonControlPlaneHelper({ gatewayMethods: catalog } as unknown as DaemonControlPlaneContext);
}

/** The REST leg wired as the daemon wires it: path params and query into the query, path params and JSON body into the body. */
function restHandlers(helper: DaemonControlPlaneHelper, scopes: readonly string[]): DaemonApiRouteHandlers {
  return {
    invokeGatewayRestVerb: async ({ methodId, req, params }: GatewayRestVerbInvocation) => {
      const query: Record<string, unknown> = { ...params };
      for (const [key, value] of new URL(req.url).searchParams) query[key] = value;
      const text = req.method === 'GET' ? '' : await req.text();
      const body = text.length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
      const result = await helper.invokeGatewayMethodCall({
        authToken: 'fixture-token',
        methodId,
        query,
        body: { ...params, ...body },
        context: { scopes, admin: false },
      });
      return Response.json(result.body, { status: result.status });
    },
  } as unknown as DaemonApiRouteHandlers;
}

const READ = ['read:fleet'];
const WRITE = ['read:fleet', 'write:fleet'];

async function rest(helper: DaemonControlPlaneHelper, scopes: readonly string[], method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await dispatchDaemonApiRoutes(
    new Request(`http://daemon.invalid${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }),
    restHandlers(helper, scopes),
  );
  if (response === null) throw new Error(`no route for ${method} ${path}`);
  return { status: response.status, body: await response.json() };
}

describe('the contracts.* methods', () => {
  test('each advertises the REST path the route table serves, with fleet scopes', () => {
    const catalog = new GatewayMethodCatalog();
    const expected: Record<string, readonly ['GET' | 'POST', string, string]> = {
      'contracts.list': ['GET', '/api/contracts', 'read:fleet'],
      'contracts.get': ['GET', '/api/contracts/{contractId}', 'read:fleet'],
      'contracts.start': ['POST', '/api/contracts', 'write:fleet'],
      'contracts.cancel': ['POST', '/api/contracts/{contractId}/cancel', 'write:fleet'],
      'contracts.reply': ['POST', '/api/contracts/{contractId}/reply', 'write:fleet'],
    };
    for (const [id, [method, path, scope]] of Object.entries(expected)) {
      const descriptor = catalog.get(id);
      expect(descriptor?.http).toEqual({ method, path });
      expect(descriptor?.scopes).toEqual([scope]);
      expect(GATEWAY_REST_ROUTES.some((route) => route.methodId === id && route.method === method)).toBe(true);
    }
  });

  test('contracts.start, get, list, cancel and reply through the methodId invoke', async () => {
    const { service, floor } = surface();
    const helper = helperFor(catalogFor(service));
    const invoke = (methodId: string, body: Record<string, unknown>, scopes = WRITE) =>
      helper.invokeGatewayMethodCall({ authToken: 'fixture-token', methodId, body, context: { scopes, admin: false } });

    const started = await invoke('contracts.start', { ask: 'Add the export flag.', sessionId: 'hosted-1', isolation: 'worktree' });
    expect(started.status).toBe(200);
    const { contract, ownerAgentId } = started.body as { contract: { id: string; origin: string }; ownerAgentId: string };
    expect(contract.origin).toBe('hosted');
    expect(ownerAgentId).toBe('agent-owner-1');
    expect(floor.started[0]).toMatchObject({ isolation: 'worktree', projectRoot: HOSTED_ROOT });

    expect((await invoke('contracts.get', { contractId: contract.id }, READ)).body).toMatchObject({ id: contract.id, ask: 'Add the export flag.' });
    expect(((await invoke('contracts.list', { sessionId: 'hosted-1' }, READ)).body as { contracts: { id: string }[] }).contracts.map((entry) => entry.id)).toEqual([contract.id]);

    const escalationId = escalate(floor, contract.id, 'Contract needs your call.');
    const replied = await invoke('contracts.reply', { contractId: contract.id, escalationId, text: 'Go ahead.' });
    expect(replied.body).toEqual({ escalationId, reading: 'approve', outcome: 'act', action: 'approved' });

    expect((await invoke('contracts.cancel', { contractId: contract.id })).body).toEqual({ cancelled: true });
    expect(floor.cancelled).toEqual([{ contractId: contract.id, reason: 'cancelled by an operator' }]);
    expect((await invoke('contracts.cancel', { contractId: contract.id, reason: 'twice' })).body).toEqual({ cancelled: false });
  });

  test('refusals carry their codes and statuses', async () => {
    const helper = helperFor(catalogFor(surface().service));
    const invoke = (methodId: string, body: Record<string, unknown>) =>
      helper.invokeGatewayMethodCall({ authToken: 'fixture-token', methodId, body, context: { scopes: WRITE, admin: false } });
    expect((await invoke('contracts.get', { contractId: 'ctr-ffffffff' })).status).toBe(404);
    expect((await invoke('contracts.cancel', { contractId: 'ctr-ffffffff' })).status).toBe(404);
    expect((await invoke('contracts.start', { ask: 'Do it.', workspaceRoot: 'not/absolute' })).status).toBe(400);
    expect((await invoke('contracts.start', { ask: 'Do it.', isolation: 'sideways' })).status).toBe(400);
  });

  test('every REST path reaches the same handler', async () => {
    const { service, floor, daemon } = surface();
    const helper = helperFor(catalogFor(service));

    const started = await rest(helper, WRITE, 'POST', '/api/contracts', { ask: 'Tidy the logger.' });
    expect(started.status).toBe(200);
    const id = (started.body as { contract: { id: string } }).contract.id;
    expect(daemon.started[0]).toMatchObject({ ask: 'Tidy the logger.', origin: 'external', projectRoot: WORKDIR });

    expect((await rest(helper, READ, 'GET', `/api/contracts/${id}`)).body).toMatchObject({ id, ask: 'Tidy the logger.' });
    const listed = await rest(helper, READ, 'GET', '/api/contracts?includeTerminal=true');
    expect((listed.body as { contracts: { id: string }[] }).contracts.map((entry) => entry.id)).toEqual([id]);

    const hosted = floor.start({ ask: 'Other work.', sessionId: 'hosted-1', origin: 'hosted', projectRoot: HOSTED_ROOT });
    const escalationId = escalate(floor, hosted.contract.id, 'Contract asks.');
    const replied = await rest(helper, WRITE, 'POST', `/api/contracts/${hosted.contract.id}/reply`, { escalationId, text: 'Yes.' });
    expect(replied.body).toMatchObject({ escalationId, action: 'approved' });
    expect(floor.replies).toEqual([{ contractId: hosted.contract.id, escalationId, text: 'Yes.' }]);

    expect((await rest(helper, WRITE, 'POST', `/api/contracts/${id}/cancel`, { reason: 'not needed' })).body).toEqual({ cancelled: true });
    expect(daemon.cancelled).toEqual([{ contractId: id, reason: 'not needed' }]);
  });

  test('a caller without write:fleet cannot start, cancel or reply, and one without read:fleet cannot read', async () => {
    const { service, daemon } = surface();
    const helper = helperFor(catalogFor(service));
    expect((await rest(helper, READ, 'POST', '/api/contracts', { ask: 'Do it.' })).status).toBe(403);
    expect((await rest(helper, [], 'GET', '/api/contracts')).status).toBe(403);
    expect(daemon.started).toEqual([]);
  });
});
