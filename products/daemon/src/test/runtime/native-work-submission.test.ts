/** Production daemon routes over owned fixtures; no live providers or real grants. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeWorkSubmissionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-submission-client';
import { getOperatorWorkLedgerProject, createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  cleanups.push(() => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); });
  const daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-source-submit'),
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }) });
  cleanups.push(() => daemon.stop());
  const paths = daemon.services.shellPaths;
  const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(paths), fallbackReadPath: legacyWorkspaceRegisterPath(paths),
    homeDir: daemon.homeDirectory, daemonStateDir: paths.resolveUserPath() });
  await scopes.add(daemon.workingDirectory);
  const paired = daemon.services.pairingTokens.mint({ name: 'Owned source submission fixture' });
  const sdk = createOperatorSdk({ baseUrl: daemon.baseUrl, authToken: paired.token, retry: { maxAttempts: 1 } });
  const projectId = await getOperatorWorkLedgerProject(sdk);
  const client = createOperatorNativeWorkSubmissionClient(sdk, projectId);
  const reader = createOperatorWorkLedgerReadClient(sdk, projectId);
  cleanups.push(() => { client.dispose(); reader.dispose(); });
  return { daemon, scopes, paired, sdk, projectId, client, reader };
}
const source = () => ({ requestId: 'owned-request-1', inputId: 'owned-input-1', expectedRevision: 0,
  goal: '  Keep the full source ☃.\nDo not rewrite it.  ', criteria: ['  Exact first criterion.  ', 'Duplicate criterion', 'Duplicate criterion', 'Final criterion\n'] });

test('actual daemon submission atomically captures exact source and owner, with no implicit native execution', async () => {
  const f = await fixture(); const input = source();
  const first = await f.client.submit(input);
  expect(first.kind).toBe('submitted'); expect(first.replayed).toBe(false);
  expect(first.receipt).toMatchObject({ projectId: f.projectId, requestId: input.requestId, inputId: input.inputId,
    ledgerRevision: 1, expectedRevision: { work: 1, criteria: 1, attempt: 1 }, goal: input.goal, criteria: input.criteria });
  expect(first.receipt.source).toMatchObject({ version: 1, sessionId: `native-work:${f.projectId}` });
  expect(first.receipt.source.sourceId).toMatch(/^[a-f0-9]{64}$/); expect(first.receipt.source.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
  const snapshot = await f.reader.readSnapshot();
  expect(snapshot.revision).toBe(1); expect(snapshot.works).toHaveLength(1);
  expect(snapshot.works[0]?.work).toMatchObject({ id: first.receipt.workId, goal: input.goal, criteria: input.criteria, currentAttemptId: first.receipt.attemptId });
  expect(snapshot.works[0]?.attempt).toMatchObject({ id: first.receipt.attemptId, state: 'active', ownerId: f.daemon.services.pairingTokens.authenticateNative(f.paired.token)!.principalId });
  expect(snapshot.works[0]?.verification.state).toBe('unverified');
  const replay = await f.client.submit(input); expect(replay.replayed).toBe(true); expect(replay.receipt).toEqual(first.receipt);
  expect(await f.client.get({ requestId: input.requestId })).toEqual({ kind: 'found', receipt: first.receipt });
  expect((await f.reader.readSnapshot()).revision).toBe(1);
  const execution = createOperatorNativeWorkExecutionClient(f.sdk, f.projectId);
  await expect(execution.status({ workId: first.receipt.workId, attemptId: first.receipt.attemptId, expectedRevision: first.receipt.expectedRevision })).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_NOT_FOUND' });
  execution.dispose(); expect(f.daemon.services.agentManager.list()).toHaveLength(0);
}, 20000);

test('lost daemon submit response is resolved through original request lookup without another work or executor', async () => {
  const f = await fixture(); const input = source();
  let delivered = false;
  const original = f.sdk.invoke.bind(f.sdk);
  const client = createOperatorNativeWorkSubmissionClient({ invoke: async <T>(method: string, body?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const result = await original<T>(method, body, options);
    if (method === 'workLedger.submit' && !delivered) { delivered = true; throw new Error('Owned lost-response transport'); }
    return result;
  } }, f.projectId);
  try {
    await expect(client.submit(input)).rejects.toThrow('Owned lost-response');
    const found = await client.get({ requestId: input.requestId }); expect(found.kind).toBe('found');
    if (found.kind !== 'found') throw new Error('Expected original durable submission');
    expect(found.receipt.goal).toBe(input.goal); expect(found.receipt.criteria).toEqual(input.criteria);
    expect((await client.submit(input)).receipt).toEqual(found.receipt);
    expect((await f.reader.readSnapshot()).works).toHaveLength(1);
  } finally { client.dispose(); }
}, 20000);

test('same identity changed source and reused input identity refuse without replacing the original receipt', async () => {
  const f = await fixture(); const input = source(); const first = await f.client.submit(input);
  await expect(f.client.submit({ ...input, goal: input.goal.trim() })).rejects.toMatchObject({ code: 'NATIVE_SUBMISSION_REQUEST_CONFLICT' });
  await expect(f.client.submit({ ...input, requestId: 'other-request', expectedRevision: 1 })).rejects.toMatchObject({ code: 'NATIVE_SUBMISSION_REQUEST_CONFLICT' });
  await expect(f.client.submit({ ...input, requestId: 'new-request', inputId: 'new-input' })).rejects.toMatchObject({ code: 'NATIVE_SUBMISSION_CONFLICT' });
  expect(await f.client.get({ requestId: input.requestId })).toEqual({ kind: 'found', receipt: first.receipt });
  expect((await f.reader.readSnapshot()).revision).toBe(1);
}, 20000);

test('actual routes reject anonymous/shared credentials, host-field injection and revoked owners', async () => {
  const f = await fixture(); const input = source();
  const post = (token: string | undefined, body: unknown) => fetch(`${f.daemon.baseUrl}/api/work-ledger/submissions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  expect((await post(undefined, input)).status).toBe(401);
  expect((await post(f.daemon.token, input)).status).toBe(403);
  for (const key of ['projectId', 'sessionId', 'actorId', 'sourceId', 'source', 'executionApproved']) expect((await post(f.paired.token, { ...input, [key]: 'injected' })).status).toBe(400);
  expect((await f.reader.readSnapshot()).works).toHaveLength(0);
  f.daemon.services.pairingTokens.revoke(f.paired.id);
  expect((await post(f.paired.token, input)).status).toBe(401);
}, 20000);

test('submission lookup is scoped to the live paired principal and original project', async () => {
  const f = await fixture(); const input = source(); await f.client.submit(input);
  const other = f.daemon.services.pairingTokens.mint({ name: 'Different owned source principal' });
  const client = createOperatorNativeWorkSubmissionClient(createOperatorSdk({ baseUrl: f.daemon.baseUrl, authToken: other.token, retry: { maxAttempts: 1 } }), f.projectId);
  try { expect(await client.get({ requestId: input.requestId })).toEqual({ kind: 'not-found' }); }
  finally { client.dispose(); }
  expect(await f.client.get({ requestId: 'unknown-request' })).toEqual({ kind: 'not-found' });
}, 20000);
