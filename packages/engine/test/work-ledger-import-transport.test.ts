import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerWorkLedgerImportGatewayMethods } from '../sdk/src/platform/control-plane/routes/work-ledger-import.js';
import { registerWorkLedgerGatewayMethods } from '../sdk/src/platform/control-plane/routes/work-ledger.js';
import { createLocalWorkLedgerReadBinding } from '../sdk/src/platform/workflow/work-ledger/read-client.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { dispatchGatewayRestRoutes } from '../daemon-sdk/src/gateway-rest-routes.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import { createOperatorWorkLedgerReadClient } from '../sdk/src/platform/workflow/work-ledger/operator-read-client.js';
import type { OperatorRemoteClient } from '../operator-sdk/src/client-core.js';
import type { LegacyMigrationPreparation } from '../sdk/src/platform/workflow/work-ledger/legacy-import.js';
const roots: string[] = []; const stores: KnowledgeStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'import-http-')); roots.push(root); const file = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath: file }); stores.push(store);
  await store.upsertSource({ id: 'source', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', status: 'indexed', metadata: {
    privateSourceMarker: 'PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE', projectPlanning: true, projectId: 'project', knowledgeSpaceId: 'space', planningArtifactKind: 'state', planningArtifactId: 'plan',
    value: { id: 'plan', projectId: 'project', knowledgeSpaceId: 'space', openQuestions: [], answeredQuestions: [], decisions: [], dependencies: [], tasks: [{ id: 'legacy', title: 'Synthetic', status: 'completed', executionApproved: true }] },
  } });
  const storage = await store.openWorkLedgerStorage('project');
  const core = createWorkLedger({ projectId: 'project', importHostId: 'host', storage, clock: { now: () => 10, newId: kind => `${kind}-fixture` } });
  const catalog = new GatewayMethodCatalog();
  registerWorkLedgerImportGatewayMethods(catalog, { hostId: 'host', projectId: 'project', ...core, readSource: id => store.getSourceSnapshot({ id }) });
  const reader = createLocalWorkLedgerReadBinding({ available: true, projectId: 'project', actorId: 'reader', allowLegacyProvenance: true, ...core });
  if (!reader.available) throw new Error('Fixture reader missing'); registerWorkLedgerGatewayMethods(catalog, reader.client);
  let revoked = false; let roles = ['admin'];
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, authToken: () => revoked ? null : 'owner-token',
    userAuth: { validateSession: (token: string) => token === 'reader-token' ? { username: 'reader' } : token === 'session-token' ? { username: 'operator' } : null,
      getUser: (username: string) => ({ username, roles: username === 'reader' ? [] : roles }) },
  } as unknown as DaemonControlPlaneContext);
  async function request(path: string, body?: unknown, token = 'owner-token', signal?: AbortSignal) {
    const req = new Request(`http://127.0.0.1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
    return (await dispatchGatewayRestRoutes(req, { async invokeGatewayRestVerb({ req, methodId }) {
      const principal = helper.describeAuthenticatedPrincipal(token);
      if (!principal) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const result = await helper.invokeGatewayMethodCall({ authToken: token, methodId, query: Object.fromEntries(new URL(req.url).searchParams),
        body: req.method === 'GET' ? undefined : await req.json(), signal: req.signal, context: principal });
      return Response.json(result.body, { status: result.status });
    } }))!;
  }
  async function prepared(token?: string) {
    const result = await (await request('/api/work-ledger/legacy-import/prepare', { projectId: 'project', sourceIds: ['source'] }, token)).json() as LegacyMigrationPreparation;
    if (result.kind !== 'prepared') throw new Error(JSON.stringify(result));
    return { type: 'import_legacy', requestId: 'request', expectedRevision: result.manifest.expectedLedgerRevision, manifest: result.manifest };
  }
  return { file, store, catalog, helper, request, prepared, revoke() { revoked = true; }, downgrade() { roles = []; } };
}
test('authenticated HTTP preparation/import/replay and bounded existing read transport preserve source provenance', async () => {
  const host = await fixture(); const request = await host.prepared(); const before = host.store.getSourceSnapshot({ id: 'source' });
  expect(await (await host.request('/api/work-ledger/legacy-import', request)).json()).toMatchObject({ kind: 'accepted', replayed: false });
  expect(await (await host.request('/api/work-ledger/legacy-import', request)).json()).toMatchObject({ kind: 'accepted', replayed: true });
  expect(await (await host.request('/api/work-ledger/history?projectId=project&afterSequence=0')).json()).toMatchObject({ cursor: 1, events: [{ type: 'import_legacy', manifest: request.manifest }] });
  expect(await (await host.request('/api/work-ledger/snapshot?projectId=project')).json()).toMatchObject({ revision: 1, works: [{ work: { id: 'legacy' }, verification: { state: 'unverified' }, attempt: null }] });
  expect(host.store.getSourceSnapshot({ id: 'source' })).toEqual(before);
  const denied = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.history', query: { projectId: 'project', afterSequence: 0 },
    context: { admin: true, principalId: 'shared-token', principalKind: 'token', scopes: ['read:work-ledger'] } });
  expect(denied.status).toBe(200);
  expect(denied.body).toMatchObject({ cursor: 1, events: [{ type: 'import_legacy', manifest: null, provenance: 'requires_read_knowledge' }] });
  expect(JSON.stringify(denied.body)).not.toContain('PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE');
  expect(JSON.stringify(denied.body)).not.toContain('executionApproved');
  expect(JSON.stringify(denied.body)).not.toContain('signature');
  expect(JSON.stringify(denied.body)).not.toContain('receipts');
  expect(JSON.stringify(denied.body)).not.toContain('goodvibes-project-planning');
  const snapshotOnly = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.snapshot', query: { projectId: 'project' },
    context: { admin: true, principalId: 'shared-token', principalKind: 'token', scopes: ['read:work-ledger'] } });
  expect(JSON.stringify(snapshotOnly.body)).not.toContain('PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE');
  expect(snapshotOnly.status).toBe(200); expect(JSON.stringify(snapshotOnly.body)).not.toContain('executionApproved');
});
test('read-only scoped admin can prepare but protected provenance still requires read knowledge', async () => {
  const host = await fixture(); const body = { projectId: 'project', sourceIds: ['source'] };
  const context = { admin: true, principalId: 'shared-token', principalKind: 'token' as const, scopes: ['read:work-ledger', 'read:knowledge'] };
  const prepared = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.prepareLegacyImport', body, context });
  expect(prepared.status).toBe(200); expect(prepared.body).toMatchObject({ kind: 'prepared' });
  const denied = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.prepareLegacyImport', body, context: { ...context, scopes: ['read:work-ledger'] } });
  expect(denied.status).toBe(403); expect(JSON.stringify(denied.body)).not.toContain('PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE');
});
test('read token, non-owner, scope attenuation, forged payload authority and stale auth refuse before writes', async () => {
  const host = await fixture(); const request = await host.prepared(); const bytes = readFileSync(host.file);
  expect((await host.request('/api/work-ledger/legacy-import', request, 'reader-token')).status).toBe(403);
  expect((await host.request('/api/work-ledger/legacy-import', { ...request, actorId: 'owner', role: 'coordinator' })).status).toBe(400);
  expect((await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.importLegacy', body: request,
    context: { admin: true, principalId: 'shared-token', principalKind: 'token', scopes: ['read:work-ledger'] } })).status).toBe(403);
  await expect(host.catalog.invoke('workLedger.importLegacy', { body: request, context: { admin: true, scopes: ['write:work-ledger-import'] } })).rejects.toMatchObject({ status: 403 });
  await expect(host.catalog.invoke('workLedger.importLegacy', { body: request, context: { admin: true, principalId: 'trusted-shaped', scopes: ['write:work-ledger-import', 'read:knowledge'] } })).rejects.toMatchObject({ status: 403 });
  const cached = host.helper.describeAuthenticatedPrincipal('session-token')!; host.downgrade();
  expect((await host.helper.invokeGatewayMethodCall({ authToken: 'session-token', methodId: 'workLedger.importLegacy', body: request, context: cached })).status).toBe(403);
  host.revoke(); expect((await host.request('/api/work-ledger/legacy-import', request)).status).toBe(401);
  expect(readFileSync(host.file)).toEqual(bytes);
});
test('HTTP request cancellation and token revocation while storage waits prevent admission', async () => {
  const host = await fixture(); const request = await host.prepared(); const bytes = readFileSync(host.file);
  const release = await acquireCrossProcessLock(`${host.file}.knowledge-lock`, { strictOwnership: true });
  const controller = new AbortController(); const waiting = host.request('/api/work-ledger/legacy-import', request, 'owner-token', controller.signal);
  controller.abort(); await release();
  expect(await (await waiting).json()).toMatchObject({ kind: 'rejected', code: 'cancelled' });
  const release2 = await acquireCrossProcessLock(`${host.file}.knowledge-lock`, { strictOwnership: true });
  // Start at the authenticated catalog handler to prove live revocation AFTER entry.
  const entered = host.catalog.get('workLedger.importLegacy')!; expect(entered.metadata?.requiresFreshOperatorAuth).toBe(true);
  const pending = host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId: 'workLedger.importLegacy', body: request,
    context: host.helper.describeAuthenticatedPrincipal('owner-token')! });
  host.revoke(); await release2();
  expect((await pending).body).toMatchObject({ kind: 'rejected', code: 'forbidden' });
  expect(readFileSync(host.file)).toEqual(bytes);
});

test('same-token same-cursor projection changes notify clients and fence previously authorized late history', async () => {
  const host = await fixture(); const command = await host.prepared(); await host.request('/api/work-ledger/legacy-import', command);
  const principal = host.helper.describeAuthenticatedPrincipal('owner-token')!;
  let knowledge = true;
  host.helper.describeAuthenticatedPrincipal = () => ({ ...principal, scopes: knowledge ? ['read:knowledge', 'read:work-ledger'] : ['read:work-ledger'] });
  let release!: () => void; let enter!: () => void; let hold = true;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remote: Pick<OperatorRemoteClient, 'invoke'> = { async invoke<T>(methodId: string, input?: Record<string, unknown>) {
    const result = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId, query: input,
      context: host.helper.describeAuthenticatedPrincipal('owner-token')! });
    if (!result.ok) throw new Error('Fixture read denied');
    if (methodId === 'workLedger.history' && hold) { enter(); await gate; }
    return result.body as T;
  } };
  const reader = createOperatorWorkLedgerReadClient(remote, 'project', { pollIntervalMs: 100 });
  try {
    await reader.readSnapshot();
    const old = reader.history(0); await entered;
    knowledge = false; expect((await reader.readSnapshot()).provenance).toBe('requires_read_knowledge');
    hold = false; release();
    expect(JSON.stringify(await old)).not.toContain('PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE');
    const observed: string[] = [];
    const stop = reader.subscribe(snapshot => { observed.push(snapshot.provenance ?? 'missing'); });
    async function waitFor(value: string) { const until = Date.now() + 2000; while (!observed.includes(value)) { if (Date.now() > until) throw new Error('Projection notification missing'); await new Promise(resolve => setTimeout(resolve, 10)); } }
    await waitFor('requires_read_knowledge'); knowledge = true; await waitFor('available');
    expect(JSON.stringify(await reader.history(0))).toContain('PRIVATE_SOURCE_PAYLOAD_DO_NOT_DISCLOSE');
    knowledge = false; const prior = observed.length;
    const until = Date.now() + 2000; while (!observed.slice(prior).includes('requires_read_knowledge')) { if (Date.now() > until) throw new Error('Unchanged-cursor downgrade notification missing'); await new Promise(resolve => setTimeout(resolve, 10)); }
    stop();
  } finally { hold = false; release(); reader.dispose(); }
});

test('a later-observed restriction wins even when its request began before a newer available snapshot', async () => {
  const host = await fixture(); const command = await host.prepared(); await host.request('/api/work-ledger/legacy-import', command);
  const principal = host.helper.describeAuthenticatedPrincipal('owner-token')!; let knowledge = true;
  host.helper.describeAuthenticatedPrincipal = () => ({ ...principal, scopes: knowledge ? ['read:knowledge', 'read:work-ledger'] : ['read:work-ledger'] });
  let release!: () => void; let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const remote: Pick<OperatorRemoteClient, 'invoke'> = { async invoke<T>(methodId: string, input?: Record<string, unknown>) {
    if (methodId === 'workLedger.history') { enter(); await gate; }
    const result = await host.helper.invokeGatewayMethodCall({ authToken: 'owner-token', methodId, query: input, context: host.helper.describeAuthenticatedPrincipal('owner-token')! });
    if (!result.ok) throw new Error('Fixture read denied'); return result.body as T;
  } };
  const reader = createOperatorWorkLedgerReadClient(remote, 'project', { pollIntervalMs: 100 });
  const observed: string[] = []; const stop = reader.subscribe(snapshot => { observed.push(snapshot.provenance ?? 'missing'); });
  try {
    await reader.readSnapshot(); const old = reader.history(1); await entered;
    await reader.readSnapshot(); knowledge = false; release(); await old;
    expect(observed.at(-1)).toBe('requires_read_knowledge');
  } finally { release(); stop(); reader.dispose(); }
});
