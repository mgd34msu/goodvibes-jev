import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { savedReviewArtifacts } from '../../tools/agent-harness-personal-ops-records.ts';
import { protectPersonalOpsData } from '../../tools/agent-harness-personal-ops-source.ts';
import { mcpSchemaReader, mcpToolRecords, mcpToolSchemas } from '../../tools/agent-harness-personal-ops-discovery.ts';
import { readPersonalOpsTool } from '../../tools/agent-harness-personal-ops-readings.ts';
import { watcherReadModelLiveRecords, watcherReadModelNativeFacts } from '../../tools/agent-harness-autonomy-watcher-read-models.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const context = (platform: Record<string, unknown>, clients: Record<string, unknown> = {}) => ({ platform, clients }) as unknown as CommandContext;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected actual fixture object');
  return Object.fromEntries(Object.entries(value));
}
function privacyFixture() {
  return fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')) {
      const field = object(state).field;
      if (typeof field !== 'string') throw new Error('Missing field');
      return choiceAnswer(question, field === 'accessToken' || field === 'password' ? 'secret' : 'other', 0.999);
    }
    if (['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) return noulAnswer(0.001);
    throw new Error(`Unexpected producer privacy question ${name}`);
  });
}

describe('Personal Ops actual producer privacy and lifetimes', () => {
  test('complete DTO protection preserves native flags and clocks and owns original source after return', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const original = { accessToken: 'synthetic-private-credential', enabled: true, createdAt: 4001, detail: 'Complete synthetic record tail' };
    const guards: Array<() => void> = [];
    const result = await protectPersonalOpsData(original, { retainCurrent: guard => guards.push(guard) });
    expect(result).toEqual({ accessToken: '[REDACTED]', enabled: true, createdAt: 4001, detail: 'Complete synthetic record tail' });
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-credential');
    expect(JSON.stringify(fake.requests)).toContain('Complete synthetic record tail');
    for (const guard of guards) guard(); original.detail = 'Changed original producer detail';
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('hidden producer data is protected and remains in the complete source guard', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const original = Object.defineProperty({ enabled: true }, 'accessToken', { value: 'synthetic-hidden-private', enumerable: false, writable: true });
    const guards: Array<() => void> = [];
    expect(await protectPersonalOpsData(original, { retainCurrent: guard => guards.push(guard) })).toEqual({ enabled: true, accessToken: '[REDACTED]' });
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic-hidden-private');
    Object.defineProperty(original, 'accessToken', { value: 'changed-hidden-private' });
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('uncertain field roles cannot silently replace a numeric producer fact', async () => {
    const fake = fakePort((name, question) => { if (name !== 'kind') throw new Error(name); return choiceAnswer(question, 'other', 0.2); });
    installJudgmentPort(fake.port);
    await expect(protectPersonalOpsData({ createdAt: 4001 })).rejects.toThrow();
  });
  test('a source edit during a privacy reply holds the whole producer DTO', async () => {
    const original = { enabled: true, description: 'Original synthetic producer' }, ordinary = privacyFixture();
    let edited = false;
    const port: JudgmentPort = { model: ordinary.port.model, async ask(request) { if (!edited) { edited = true; original.enabled = false; } return ordinary.port.ask(request); } };
    installJudgmentPort(port); await expect(protectPersonalOpsData(original)).rejects.toThrow();
  });
  test('watcher startup facts never read private text through semantic transport', () => {
    const fake = fakePort(() => { throw new Error('Startup acquired hosted reader'); }); installJudgmentPort(fake.port);
    const source = context({ readModels: { watchers: { runs: [{ runId: 'run-1', status: 'running', outputChunks: ['password=synthetic-private'] }], sources: [{ sourceId: 'source-1', enabled: false }] } } });
    expect(watcherReadModelNativeFacts(source)).toEqual([{ status: 'running' }, { status: 'blocked' }]); expect(fake.requests).toHaveLength(0);
  });
  test('watcher details protect the whole source before clipping and retain original method identity', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const record = { runId: 'run-1', status: 'running', updatedAt: 4001, outputChunks: ['Synthetic watcher output password=synthetic-private'], cancelRoute: 'watchers cancel run-1' };
    const producer = { getSnapshot: () => ({ records: [record] }) }, guards: Array<() => void> = [];
    const result = await watcherReadModelLiveRecords(context({ readModels: { watchers: { runHistory: producer } } }), { retainCurrent: guard => guards.push(guard), sourceOwner: ordinaryResearchOwner() });
    expect(result[0]?.status).toBe('running'); expect(result[0]?.cancelRoute).toBe('watchers cancel run-1');
    expect(JSON.stringify(result)).not.toContain('synthetic-private'); expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private');
    for (const guard of guards) guard(); producer.getSnapshot = () => ({ records: [record] });
    expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('borrowed watcher array accessors are refused without evaluating them', () => {
    let reads = 0;
    const runs = Object.defineProperty([], '0', { get() { reads++; return { status: 'running' }; }, enumerable: true });
    expect(() => watcherReadModelNativeFacts(context({ readModels: { watchers: { runs } } }))).toThrow(); expect(reads).toBe(0);
  });
  test('MCP publication rejects an original method replaced during its native reply', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<readonly unknown[]>();
    const api = { listAllTools: () => { entered.resolve(); return release.promise; } };
    const work = mcpToolRecords(context({}, { mcpApi: api })); await entered.promise; api.listAllTools = () => release.promise;
    release.resolve([{ serverName: 'synthetic', toolName: 'opaque', description: 'Synthetic tool' }]); await expect(work).rejects.toThrow();
  });
  test('all schemas are read and complete actual original values remain owned', async () => {
    const raw = { inputSchema: { type: 'object', description: 'Original complete schema' } }, reads: string[] = [], guards: Array<() => void> = [];
    const api = { getToolSchema: async (name: string) => { reads.push(name); return raw; } };
    const tools = Array.from({ length: 61 }, (_, index) => ({ serverName: 'synthetic', toolName: `opaque-${index}`, description: 'No name shortlist' }));
    const schemas = await mcpToolSchemas(context({}, { mcpApi: api }), tools, { retainCurrent: guard => guards.push(guard) });
    expect(schemas.size).toBe(61); expect(reads).toHaveLength(61); for (const guard of guards) guard();
    raw.inputSchema.description = 'Changed original schema'; expect(() => guards.forEach(guard => guard())).toThrow();
  });
  test('saved review descriptors do not republish private native storage fields', async () => {
    const fake = privacyFixture(); installJudgmentPort(fake.port);
    const artifact = { id: 'artifact-1', kind: 'data', mimeType: 'application/json', sizeBytes: 7, sha256: 'synthetic-sha', createdAt: 4001,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', contentPath: '/private/source-content', metadataPath: '/private/source-metadata',
      accessToken: 'synthetic-private-artifact', metadata: { purpose: 'personal-ops-review-cards', laneId: 'inbox' } };
    const result = await savedReviewArtifacts(context({ artifactStore: { list: () => [artifact] } }), 'inbox');
    expect(result[0]?.id).toBe('artifact-1'); expect(result[0]?.createdAt).toBe(4001);
    expect(Object.hasOwn(result[0]!, 'contentPath')).toBe(false); expect(Object.hasOwn(result[0]!, 'metadataPath')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-artifact'); expect(JSON.stringify(fake.requests)).not.toContain('synthetic-private-artifact');
  });
  test('borrowed artifact list getters cannot execute before source admission', async () => {
    let reads = 0;
    const store = Object.defineProperty({}, 'list', { get() { reads++; return () => []; }, enumerable: true });
    await expect(savedReviewArtifacts(context({ artifactStore: store }), 'inbox')).rejects.toThrow(); expect(reads).toBe(0);
  });
  test('a cancelled native schema reply cannot publish late source data', async () => {
    const controller = new AbortController(), release = Promise.withResolvers<unknown>();
    const read = mcpSchemaReader(context({}, { mcpApi: { getToolSchema: () => release.promise } }), { signal: controller.signal });
    if (!read) throw new Error('Missing actual schema reader');
    const work = read('mcp:synthetic:opaque'); controller.abort(); release.resolve({ inputSchema: {} }); await expect(work).rejects.toThrow();
  });
  test('cancellation promptly interrupts a non-cooperating canonical provider reply', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fake = fakePort((name, question) => { if (name !== 'lane') throw new Error(name); return choiceAnswer(question, 'neither', 0.99); });
    const port: JudgmentPort = { model: fake.port.model, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } }; installJudgmentPort(port);
    const controller = new AbortController();
    const work = readPersonalOpsTool({ server: 'synthetic', tool: 'opaque', description: 'Synthetic contract', inputSchema: {} }, { signal: controller.signal, sourceOwner: ordinaryResearchOwner() });
    await entered.promise; controller.abort(); const timeout = setTimeout(() => release.resolve(), 300);
    try { await expect(work).rejects.toThrow(); expect(fake.requests).toHaveLength(0); } finally { clearTimeout(timeout); release.resolve(); }
  });
});
