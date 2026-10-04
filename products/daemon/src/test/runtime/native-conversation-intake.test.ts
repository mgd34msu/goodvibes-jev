/** Actual DaemonServer + service graph, with owned synthetic recorded/provider calls only. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BenchmarkStore, ProviderRegistry, type ChatRequest, type ChatResponse, type LLMProvider, type ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import { WorkspaceRegistrationStore, sharedWorkspaceRegisterPath, legacyWorkspaceRegisterPath } from '@goodvibes-jev/engine/sdk/platform/workspace';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { createOperatorSdk } from '@goodvibes-jev/engine/operator-sdk';
import { createOperatorNativeConversationIntakeClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { getOperatorWorkLedgerProject, createOperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const answer = (content: string): ChatResponse => ({ content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(options: { route?: 'contract' | 'converse'; final?: string; propose?: (request: ChatRequest) => Promise<ChatResponse> } = {}) {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  cleanups.push(() => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); });
  const daemon = await startDaemonFixture({ root: makeOwnedTempDir('native-conversation-intake'),
    inboxFactory: (context, _routing, settings) => registerInboxSurface(context, { ...settings, adapters: new Map() }) });
  cleanups.push(() => daemon.stop());
  const fake = fakePort((name, question) => {
    if (name === 'route') return choiceAnswer(question, options.route ?? 'contract', 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name.startsWith('part_')) return noulAnswer(0.01);
    if (name === 'refuse') return noulAnswer(0.99);
    return choiceAnswer(question, options.final ?? 'act', 0.99);
  });
  const recorded = withDecisionLog(fake.port, daemon.services.judgment.decisionLog);
  const read = spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
  cleanups.push(() => read.mockRestore());
  const requests: ChatRequest[] = [];
  const provider: LLMProvider = { name: 'native-intake-fixture', models: ['model'], credentialAuthority: 'anonymous',
    modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, isConfigured: () => true,
    async chat(request) {
      requests.push(request); if (options.propose) return options.propose(request);
      const input = JSON.parse(String(request.messages[0]!.content)) as { sourceRevision: string; content: { parts: { text: string }[] } };
      return answer(JSON.stringify({ sourceRevision: input.sourceRevision, spans: [{ partId: 'input', start: 0, end: input.content.parts[0]!.text.length }] }));
    } };
  const model = { id: 'model', provider: provider.name, registryKey: `${provider.name}:model`, displayName: 'Owned intake fixture', description: 'Synthetic model',
    capabilities: { toolCalling: false, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 100000, selectable: true, tier: 'standard' } as ModelDefinition;
  daemon.services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
  daemon.services.providerRegistry.setCurrentModel(model.registryKey);
  const paths = daemon.services.shellPaths;
  const scopes = new WorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(paths), fallbackReadPath: legacyWorkspaceRegisterPath(paths),
    homeDir: daemon.homeDirectory, daemonStateDir: paths.resolveUserPath() });
  await scopes.add(daemon.workingDirectory);
  const paired = daemon.services.pairingTokens.mint({ name: 'Owned conversation source fixture' });
  const sdk = createOperatorSdk({ baseUrl: daemon.baseUrl, authToken: paired.token, retry: { maxAttempts: 1 } });
  const projectId = await getOperatorWorkLedgerProject(sdk);
  const client = createOperatorNativeConversationIntakeClient(sdk, projectId);
  const reader = createOperatorWorkLedgerReadClient(sdk, projectId);
  cleanups.push(() => { client.dispose(); reader.dispose(); });
  return { daemon, paired, sdk, projectId, client, reader, fake, requests };
}
const source = () => ({ requestId: 'source-request', inputId: 'logical-input', text: '  Add JSON export.\r\nKeep CSV output unchanged. 🌻  ', unsupportedSources: [] });

test('production capture/route/extraction atomically publishes exact source2 work with no implicit execution', async () => {
  const f = await fixture(); const input = source(); const captured = await f.client.capture(input);
  expect(captured.kind).toBe('captured'); expect(f.requests).toHaveLength(0); expect(f.fake.requests).toHaveLength(0);
  const target = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
  const result = await f.client.admit(target);
  expect(result.kind).toBe('work'); if (result.kind !== 'work') throw new Error('Expected native work');
  expect(result.receipt.goal).toBe(input.text); expect(result.receipt.criteria).toEqual([input.text]);
  expect(result.receipt.source.version).toBe(2); expect(result.receipt.expectedRevision).toEqual({ work: 1, criteria: 1, attempt: 1 });
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.tools).toBeUndefined();
  expect((await f.reader.readSnapshot()).works[0]?.verification.state).toBe('unverified');
  expect(await f.client.get({ inputId: input.inputId })).toEqual(result);
  expect(await f.client.capture(input)).toEqual(result); expect(await f.client.resume(target)).toEqual(result);
  expect((await f.reader.readSnapshot()).revision).toBe(1); expect(f.requests).toHaveLength(1);
  const execution = createOperatorNativeWorkExecutionClient(f.sdk, f.projectId);
  await expect(execution.status({ workId: result.receipt.workId, attemptId: result.receipt.attemptId, expectedRevision: result.receipt.expectedRevision })).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_NOT_FOUND' });
  execution.dispose(); expect(f.daemon.services.agentManager.list()).toHaveLength(0);
  expect(f.daemon.services.contractRunner.list({ includeTerminal: true })).toHaveLength(0);
}, 20000);

test('lost admission acknowledgement reconciles original source and work without another reading or proposer', async () => {
  const f = await fixture(); const input = source(); const captured = await f.client.capture(input);
  const original = f.sdk.invoke.bind(f.sdk); let lost = false;
  const client = createOperatorNativeConversationIntakeClient({ invoke: async <T>(method: string, body?: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const result = await original<T>(method, body, options);
    if (method === 'workLedger.intake.admit' && !lost) { lost = true; throw new Error('Owned lost admission response'); }
    return result;
  } }, f.projectId);
  try {
    const target = { inputId: input.inputId, sourceRevision: captured.sourceRef.sourceRevision };
    await expect(client.admit(target)).rejects.toThrow('Owned lost admission');
    const reads = f.fake.requests.length; const result = await client.get({ inputId: input.inputId }); expect(result.kind).toBe('work');
    if (result.kind !== 'work') throw new Error('Expected the original admitted work receipt');
    expect(await client.admit(target)).toEqual(result); expect(f.fake.requests).toHaveLength(reads); expect(f.requests).toHaveLength(1);
    expect((await f.reader.readSnapshot()).works).toHaveLength(1);
  } finally { client.dispose(); }
}, 20000);

test('actual REST cancellation persists before provider cleanup and old admission cannot publish', async () => {
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  const f = await fixture({ propose: async request => {
    entered.resolve(); await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    await cleanup.promise; request.signal!.throwIfAborted(); return answer('{}');
  } });
  const input = source(); const capture = await f.client.capture(input); const target = { inputId: input.inputId, sourceRevision: capture.sourceRef.sourceRevision };
  const start = f.client.admit(target); void start.catch(() => {}); await entered.promise;
  let finished = false; const cancel = f.client.cancel(target).finally(() => { finished = true; });
  await aborted.promise; expect(finished).toBe(false); cleanup.resolve();
  expect(await cancel).toMatchObject({ kind: 'cancelled' }); await expect(start).rejects.toThrow();
  expect(await f.client.resume(target)).toMatchObject({ kind: 'cancelled' }); expect((await f.reader.readSnapshot()).works).toHaveLength(0);
}, 20000);

test('actual route rejects unsupported authority, injected source proof and revoked principal', async () => {
  const f = await fixture(); const input = source();
  const post = (token: string | undefined, body: unknown) => fetch(`${f.daemon.baseUrl}/api/work-ledger/intake/capture`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  expect((await post(undefined, input)).status).toBe(401); expect((await post(f.daemon.token, input)).status).toBe(403);
  for (const field of ['criteria', 'sourceId', 'projectId', 'actorId', 'sessionId', 'decisionId']) expect((await post(f.paired.token, { ...input, [field]: 'injected' })).status).toBe(400);
  const capture = await f.client.capture(input); f.daemon.services.pairingTokens.revoke(f.paired.id);
  await expect(f.client.admit({ inputId: input.inputId, sourceRevision: capture.sourceRef.sourceRevision })).rejects.toThrow();
  expect(f.fake.requests).toHaveLength(0); expect(f.requests).toHaveLength(0);
}, 20000);

test('ordinary-turn response preserves original input; unresolved sources never become a turn', async () => {
  const f = await fixture({ route: 'converse' }); const input = source(); const capture = await f.client.capture(input);
  expect(await f.client.admit({ inputId: input.inputId, sourceRevision: capture.sourceRef.sourceRevision })).toMatchObject({ kind: 'turn', text: input.text });
  expect(f.requests).toHaveLength(0); expect((await f.reader.readSnapshot()).works).toHaveLength(0);
}, 20000);
