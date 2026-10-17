import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort, JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { ToolRegistry, ToolInputProjectionError, registrySelect } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ServiceRegistry, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecurityReadSourceRetiredError } from '@goodvibes-jev/engine/sdk/platform/security';
import type { McpApi, McpServerSecurityRecord } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { createShellPathService } from '@/runtime/index.ts';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createTestManagers } from '../helpers/test-managers.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans } from '../helpers/research-screening.ts';
import { captureCatalogReadRequest, selectHarnessCatalog } from '../../tools/agent-harness-catalog-selection.ts';
import { captureCatalogMethods, captureCatalogSnapshot } from '../../tools/agent-harness-catalog-ranking.ts';
import { mcpServerSummary, describeHarnessMcpServer } from '../../tools/agent-harness-mcp-metadata.ts';
import { providerAccountSummary, describeHarnessProviderAccount } from '../../tools/agent-harness-provider-account-metadata.ts';
import { projectContextSummary, describeProjectContextFile } from '../../tools/agent-harness-project-context.ts';
import { connectedHostCapabilityMap, blockedConnectedHostCapabilities, describeConnectedHostCapability } from '../../tools/agent-harness-connected-host-capabilities.ts';

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an authored catalog record');
  return Object.fromEntries(Object.entries(value));
}
function nativeId(value: unknown): string {
  const row = fields(value);
  if (typeof row.name === 'string') return row.name;
  if (typeof row.id === 'string') return row.id;
  if (typeof row.providerId === 'string') return row.providerId;
  if (row.evidence) return nativeId(row.evidence);
  if (row.capability) return nativeId(row.capability);
  throw new Error('An authored candidate lost its native identity');
}
function selectionRequest(value: unknown) {
  const request = fields(value), context = fields(request.context);
  if (typeof context.query !== 'string' || !Array.isArray(request.candidates)) throw new Error('Expected complete native selection');
  const candidates = request.candidates.map(raw => {
    const candidate = fields(raw);
    if (typeof candidate.id !== 'string' || typeof candidate.content !== 'string') throw new Error('Expected screened candidate framing');
    const content: unknown = JSON.parse(candidate.content), record = fields(content).record;
    return { id: candidate.id, nativeId: nativeId(record), content: fields(content), record };
  });
  return { query: context.query, candidates };
}
function expectOnlyProviderDiagnostics(requests: ReturnType<typeof fakePort>['requests']) {
  // Native account/configuration inspection may emit redaction diagnostics.
  // None of those measurements is an account selection or catalog ranking.
  const diagnosticBatteries = new Set(['engine.redaction.field-kind', 'engine.redaction.residual-credential']);
  expect(requests.filter(request => !diagnosticBatteries.has(request.context?.battery ?? ''))).toEqual([]);
}

function selectReadings(query: string, chosen: string | null, fits: ReadonlyMap<string, number>, beforeAnswer?: () => void) {
  return fakePort((name, question, raw) => {
    const source = selectionRequest(raw);
    if (source.query !== query || source.candidates.some(candidate => !fits.has(candidate.nativeId))) throw new Error('Unscripted selection source');
    beforeAnswer?.();
    if (name === 'pick' && question.type === 'choice') {
      const selected = source.candidates.find(candidate => candidate.nativeId === chosen);
      if (chosen !== null && !selected) throw new Error('Authored selection is missing');
      return choiceAnswer(question, selected?.id ?? 'none', .999);
    }
    const match = /^fits_(0|[1-9][0-9]*)$/.exec(name);
    if (!match || question.type !== 'noul') throw new Error('Unexpected native selection question');
    const candidate = source.candidates[Number(match[1])], probability = candidate && fits.get(candidate.nativeId);
    if (probability === undefined) throw new Error('Unscripted candidate fit');
    return noulAnswer(probability);
  });
}
function rankReadings(query: string, answers: ReadonlyMap<string, number>) {
  return fakePort((name, question, raw) => {
    const source = fields(raw), candidate = fields(source.candidate);
    if (name !== 'match' || question.type !== 'noul' || source.query !== query || typeof candidate.name !== 'string') throw new Error('Unexpected registry ranking source');
    const probability = answers.get(candidate.name);
    if (probability === undefined) throw new Error('Unscripted complete catalog candidate');
    return noulAnswer(probability);
  });
}
function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve(value: T) { if (!resolve) throw new Error('Deferred native operation was not acquired'); resolve(value); } };
}
function mcpFixture() {
  const servers: McpServerSecurityRecord[] = [
    { name: 'mail-keyword', connected: true, role: 'analytics', trustMode: 'constrained', schemaFreshness: 'fresh', allowedPaths: [], allowedHosts: [] },
    { name: 'opaque-server', connected: true, role: 'communication', trustMode: 'constrained', schemaFreshness: 'fresh', allowedPaths: [], allowedHosts: [] },
  ];
  const tools = [
    { qualifiedName: 'mcp:mail-keyword:weather', serverName: 'mail-keyword', toolName: 'weather', description: 'Only weather observations.' },
    { qualifiedName: 'mcp:opaque-server:messages', serverName: 'opaque-server', toolName: 'messages', description: 'Inspect correspondence and mailbox messages.' },
  ];
  let catalogOwner: object = Object.freeze({});
  function captureToolCatalog(readOptions?: Parameters<McpApi['captureToolCatalog']>[0]): ReturnType<McpApi['captureToolCatalog']> {
    const owner = catalogOwner;
    const assertMethods = captureCatalogMethods(api, ['listServerSecurity', 'listAllTools', 'captureToolCatalog']);
    const serverSource = captureCatalogSnapshot(servers), toolSource = captureCatalogSnapshot(tools);
    const listAllTools = api.listAllTools;
    const assertOptions = readOptions ? captureCatalogMethods(readOptions, ['signal', 'assertCurrent']) : () => {};
    const signal = readOptions?.signal, callerCurrent = readOptions?.assertCurrent;
    const assertCurrent = () => {
      assertMethods();
      if (catalogOwner !== owner) throw new ToolInputProjectionError('held');
      serverSource.assertCurrent(servers); toolSource.assertCurrent(tools);
    };
    const assertReadCurrent = () => { assertOptions(); signal?.throwIfAborted(); callerCurrent?.(); assertCurrent(); assertOptions(); signal?.throwIfAborted(); };
    return Object.freeze({ async listAllTools() { assertReadCurrent(); const value = await listAllTools.call(api); assertReadCurrent(); return value; }, assertCurrent });
  }
  const api = { listServerSecurity: () => servers, listAllTools: async () => tools, captureToolCatalog } satisfies Pick<McpApi, 'listServerSecurity' | 'listAllTools' | 'captureToolCatalog'>;
  return { servers, tools, api, context: { clients: { mcpApi: api }, extensions: {} },
    retireCatalog() { catalogOwner = Object.freeze({}); } };
}
function projectFixture() {
  const root = makeProjectTempDir('native-read-catalog'), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home); mkdirSync(workspace); mkdirSync(join(workspace, '.git'));
  const paths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  const path = join(workspace, 'AGENTS.md');
  writeFileSync(path, 'Use these deployment instructions after checking the package release scripts.');
  return { path, context: { workspace: { shellPaths: paths } } };
}
const options = () => ({ sourceOwner: ordinaryResearchOwner() });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

describe('complete native read catalogs', () => {
  test('selection maps a settled opaque index to the actual original row', async () => {
    const rows = [{ id: 'keyword', body: 'Weather only.' }, { id: 'opaque', body: 'Mailbox correspondence.' }];
    const fake = selectReadings('inspect correspondence', 'opaque', new Map([['keyword', .001], ['opaque', .999]]));
    installJudgmentPort(fake.port);
    const chosen = await selectHarnessCatalog(rows, 'inspect correspondence', row => ({ id: row.id, description: row.body }), options());
    expect(chosen).toBe(rows[1]);
    expect(selectionRequest(fake.requests[0]?.state).candidates.map(candidate => candidate.record)).toEqual(rows);
  });

  test('distinct source restrictions at the same site remain active', () => {
    const request = captureCatalogReadRequest({ query: 'inspect correspondence' }, options());
    const original = new Error('Original source changed');
    let current = true;
    request.retain(() => {}, 'native source');
    request.retain(() => { if (!current) throw original; }, 'native source');
    current = false;
    expect(() => request.assertCurrent()).toThrow(original);
  });

  test('a first caller restriction cannot replace the original canonical selection method', async () => {
    const rows = [{ id: 'opaque', body: 'Mailbox correspondence.' }];
    const fake = selectReadings('inspect correspondence', 'opaque', new Map([['opaque', .999]]));
    installJudgmentPort(fake.port);
    const descriptor = Object.getOwnPropertyDescriptor(registrySelect, 'select');
    if (!descriptor || !('value' in descriptor)) throw new Error('Canonical selector is not its native data method');
    const original = registrySelect.select;
    let changed = false, replacementCalls = 0;
    try {
      await expect(selectHarnessCatalog(rows, 'inspect correspondence', row => ({ id: row.id, description: row.body }), {
        ...options(), assertCurrent() {
          if (changed) return; changed = true;
          registrySelect.select = (...args: Parameters<typeof original>) => { replacementCalls++; return original(...args); };
        },
      })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(changed).toBe(true); expect(replacementCalls).toBe(0); expect(fake.requests).toHaveLength(0);
    } finally { Object.defineProperty(registrySelect, 'select', descriptor); }
  });

  test('a first caller restriction cannot adopt a replacement installed selection backend', async () => {
    const rows = [{ id: 'opaque', body: 'Mailbox correspondence.' }];
    const original = selectReadings('inspect correspondence', 'opaque', new Map([['opaque', .999]]));
    const replacement = selectReadings('inspect correspondence', 'opaque', new Map([['opaque', .999]]));
    installJudgmentPort(original.port);
    let changed = false;
    await expect(selectHarnessCatalog(rows, 'inspect correspondence', row => ({ id: row.id, description: row.body }), {
      ...options(), assertCurrent() { if (!changed) { changed = true; installJudgmentPort(replacement.port); } },
    })).rejects.toBeInstanceOf(JudgmentAuthorityRetiredError);
    expect(changed).toBe(true); expect(original.requests).toHaveLength(0); expect(replacement.requests).toHaveLength(0);
  });

  test('a refused asynchronous restriction consumes its late native rejection', async () => {
    let reject: ((reason: Error) => void) | undefined;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const request = captureCatalogReadRequest({ query: 'inspect correspondence' }, { ...options(), assertCurrent: async () => pending });
    expect(() => request.assertCurrent()).toThrow(ToolInputProjectionError);
    if (!reject) throw new Error('The original asynchronous restriction was not acquired');
    reject(new Error('Late original restriction refusal'));
    await Promise.resolve(); await Promise.resolve();
  });

  test('retained original source guards survive selection receipt cleanup', async () => {
    const rows = [{ id: 'opaque', body: 'Mailbox correspondence.' }], retained = new Set<() => void>();
    const fake = selectReadings('inspect correspondence', 'opaque', new Map([['opaque', .999]]));
    installJudgmentPort(fake.port);
    const selected = await selectHarnessCatalog(rows, 'inspect correspondence', row => ({ id: row.id, description: row.body }),
      { ...options(), retainCurrent: guard => { retained.add(guard); } });
    expect(selected).toBe(rows[0]);
    for (const guard of retained) guard();
    rows[0]!.body = 'Weather observations only.';
    expect(() => { for (const guard of retained) guard(); }).toThrow(ToolInputProjectionError);
  });

  test('explicit none does not fall back to a lexical record', async () => {
    const f = mcpFixture(), fake = selectReadings('mail-keyword flight booking', null, new Map([['mail-keyword', .001], ['opaque-server', .001]]));
    installJudgmentPort(fake.port);
    const result = await describeHarnessMcpServer(f.context, { query: 'mail-keyword flight booking' }, options());
    expect(result.status).toBe('missing_lookup');
  });

  test('uncertain selected fit holds before a detail can be published', async () => {
    const f = mcpFixture(), fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .5]]));
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('MCP ranking reads every complete server and tool before the display limit', async () => {
    const f = mcpFixture(), fake = rankReadings('inspect correspondence', new Map([['mail-keyword', .001], ['opaque-server', .999]]));
    installJudgmentPort(fake.port);
    const result = await mcpServerSummary(f.context, { query: 'inspect correspondence', includeParameters: true, limit: 1 }, options());
    expect(result.servers).toEqual([expect.objectContaining({ name: 'opaque-server', tools: [expect.objectContaining({ name: 'messages' })] })]);
    expect(fake.requests).toHaveLength(2);
    for (const request of fake.requests) {
      const source = fields(request.state), candidate = fields(source.candidate);
      if (typeof candidate.evidenceJson !== 'string') throw new Error('Complete evidence is absent');
      expect(candidate.evidenceJson).toContain('qualifiedName');
    }
  });

  test('an uncertain list row remains present with its recorded judgment', async () => {
    const f = mcpFixture(), fake = rankReadings('inspect correspondence', new Map([['mail-keyword', .001], ['opaque-server', .5]]));
    installJudgmentPort(fake.port);
    const result = await mcpServerSummary(f.context, { query: 'inspect correspondence' }, options());
    expect(result.servers).toEqual([expect.objectContaining({ name: 'opaque-server' })]);
    expect(result.judgments).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'opaque-server', reading: expect.objectContaining({ outcome: 'escalate' }) })]));
  });

  test('exact and case-insensitive MCP IDs bypass free-text selection after source screening', async () => {
    const f = mcpFixture(), fake = fakePort(() => { throw new Error('Native ID entered semantic selection'); }); installJudgmentPort(fake.port);
    const capture = f.api.captureToolCatalog, originalOptions = options();
    let received: Parameters<McpApi['captureToolCatalog']>[0] = undefined;
    f.api.captureToolCatalog = readOptions => { received = readOptions; return capture(readOptions); };
    expect((await describeHarnessMcpServer(f.context, { mcpServerId: 'opaque-server' }, originalOptions)).status).toBe('found');
    expect<Parameters<McpApi['captureToolCatalog']>[0] | ReturnType<typeof options>>(received).toBe(originalOptions);
    expect((await describeHarnessMcpServer(f.context, { mcpServerId: 'OPAQUE-SERVER' }, options())).status).toBe('found');
    expect(fake.requests).toHaveLength(0);
  });

  test('the original MCP source cannot be replaced during a noncooperating list response', async () => {
    const f = mcpFixture(), entered = deferred<void>(), release = deferred<typeof f.tools>();
    f.api.listAllTools = async () => { entered.resolve(undefined); return release.promise; };
    const operation = mcpServerSummary(f.context, { query: 'inspect correspondence' }, options());
    await entered.promise;
    f.context.clients.mcpApi = { ...f.api };
    release.resolve(f.tools);
    await expect(operation).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('a replaced MCP method accessor is refused without invoking it', async () => {
    const f = mcpFixture(), descriptor = Object.getOwnPropertyDescriptor(f.api, 'listServerSecurity');
    if (!descriptor) throw new Error('Native method descriptor missing');
    let getterCalls = 0;
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      Object.defineProperty(f.api, 'listServerSecurity', { configurable: true, get() { getterCalls++; return descriptor.value; } });
    });
    installJudgmentPort(fake.port);
    try { await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError); }
    finally { Object.defineProperty(f.api, 'listServerSecurity', descriptor); }
    expect(getterCalls).toBe(0);
  });

  test('omitted native MCP tool metadata changes hold a pending detail', async () => {
    const f = mcpFixture();
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      f.tools[1]!.qualifiedName = 'mcp:opaque-server:other-messages';
    });
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('fresh native MCP tool replacement cannot become the final publication baseline', async () => {
    const f = mcpFixture();
    let calls = 0;
    f.api.listAllTools = async () => ++calls === 1 ? f.tools : f.tools.map(tool => ({ ...tool, description: 'Weather observations only.' }));
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]));
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(calls).toBe(2);
    expect(f.tools[1]?.description).toBe('Inspect correspondence and mailbox messages.');
  });

  test('the original captured MCP catalog retires even when its returned metadata stays equal', async () => {
    const f = mcpFixture(), original = JSON.stringify({ servers: f.servers, tools: f.tools });
    let retired = false;
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      if (retired) return; retired = true; f.retireCatalog();
    });
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(retired).toBe(true);
    expect(JSON.stringify({ servers: f.servers, tools: f.tools })).toBe(original);
  });

  test('a replaced MCP catalog capture accessor cannot mint a new source after acquisition', async () => {
    const f = mcpFixture(), descriptor = Object.getOwnPropertyDescriptor(f.api, 'captureToolCatalog');
    if (!descriptor) throw new Error('Original catalog capture descriptor missing');
    let getterCalls = 0;
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      Object.defineProperty(f.api, 'captureToolCatalog', { configurable: true, get() { getterCalls++; return descriptor.value; } });
    });
    installJudgmentPort(fake.port);
    try { await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError); }
    finally { Object.defineProperty(f.api, 'captureToolCatalog', descriptor); }
    expect(getterCalls).toBe(0);
  });

  test('replaced original caller options hold after a noncooperating reading', async () => {
    const f = mcpFixture(), originalOptions = { ...options(), assertCurrent: () => {} };
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      originalOptions.assertCurrent = () => {};
    });
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, originalOptions)).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('replacement of the installed reading backend holds a pending native detail', async () => {
    const f = mcpFixture(), replacement = fakePort(() => { throw new Error('Replacement backend acquired the original read'); });
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => {
      installJudgmentPort(replacement.port);
    });
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, options())).rejects.toThrow();
    expect(replacement.requests).toHaveLength(0);
  });

  test('hidden omitted source data is still screened before any selection request', async () => {
    const rows = [{ id: 'opaque', description: 'Public row' }], secret = 'native-hidden-private-value';
    Object.defineProperty(rows[0], 'privateNote', { value: secret, enumerable: false });
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([secret]) }), fake = fakePort(() => { throw new Error('Protected source reached selection'); });
    installJudgmentPort(fake.port);
    await expect(selectHarnessCatalog(rows, 'inspect public row', row => ({ id: row.id, description: row.description }), { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(fake.requests).toHaveLength(0);
    expect(screening.calls.some(call => JSON.stringify(call.body).includes(secret))).toBe(true);
  });

  test('cancellation after a native selection response refuses publication', async () => {
    const f = mcpFixture(), controller = new AbortController();
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]));
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); controller.abort(); return result; } });
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  test('the original protected owner can revoke while a catalog reading is pending', async () => {
    const f = mcpFixture(), screening = researchScreeningFixture();
    const fake = selectReadings('inspect correspondence', 'opaque-server', new Map([['mail-keyword', .001], ['opaque-server', .999]]), () => screening.lifetime.abort());
    installJudgmentPort(fake.port);
    await expect(describeHarnessMcpServer(f.context, { query: 'inspect correspondence' }, { sourceOwner: screening.owner })).rejects.toThrow();
    expect(screening.lifetime.signal.aborted).toBe(true);
  });

  test('project context exact paths retain the native body without a selection call', async () => {
    const f = projectFixture(), fake = fakePort(() => { throw new Error('Native path entered selection'); }); installJudgmentPort(fake.port);
    const result = await describeProjectContextFile(f.context, { contextFileId: f.path }, options());
    expect(result).toEqual(expect.objectContaining({ status: 'found', file: expect.objectContaining({ path: f.path, body: readFileSync(f.path, 'utf8') }) }));
    expect(fake.requests).toHaveLength(0);
  });

  test('project list and phrase detail read the complete native guidance body', async () => {
    const f = projectFixture(), original = await projectContextSummary(f.context, {}, options());
    if (!Array.isArray(original.files) || original.files.length !== 1) throw new Error('Expected the genuine guidance file');
    const id = fields(original.files[0]).id;
    if (typeof id !== 'string') throw new Error('Native project file identity is absent');
    const query = 'instructions for shipping the package';
    const ranked = rankReadings(query, new Map([[id, .999]])); installJudgmentPort(ranked.port);
    const list = await projectContextSummary(f.context, { query, includeParameters: true }, options());
    expect(list.files).toEqual([expect.objectContaining({ id, body: readFileSync(f.path, 'utf8') })]);
    expect(JSON.stringify(ranked.requests.map(request => request.state))).toContain('package release scripts');
    const selected = selectReadings(query, id, new Map([[id, .999]])); installJudgmentPort(selected.port);
    const detail = await describeProjectContextFile(f.context, { query }, options());
    expect(detail).toEqual(expect.objectContaining({ status: 'found', file: expect.objectContaining({ id, path: f.path }) }));
    expect(selectionRequest(selected.requests[0]?.state).candidates[0]?.content).toEqual(expect.objectContaining({ record: expect.objectContaining({ body: readFileSync(f.path, 'utf8') }) }));
  });

  test('identical-byte project file replacement holds its original physical source', async () => {
    const f = projectFixture(), listed = await projectContextSummary(f.context, {}, options());
    const rows = listed.files;
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected one native project record');
    const id = fields(rows[0]).id;
    if (typeof id !== 'string') throw new Error('Native project record lost ID');
    let replaced = false;
    const fake = selectReadings('package deployment guidance', id, new Map([[id, .999]]), () => {
      if (replaced) return; replaced = true;
      const stage = f.path + '.replacement'; writeFileSync(stage, readFileSync(f.path)); renameSync(stage, f.path);
    });
    installJudgmentPort(fake.port);
    const before = readFileSync(f.path);
    await expect(describeProjectContextFile(f.context, { query: 'package deployment guidance' }, options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(replaced).toBe(true); expect(readFileSync(f.path).equals(before)).toBe(true);
  });

  test('a first caller restriction cannot adopt replaced project file ownership', async () => {
    const f = projectFixture(), original = readFileSync(f.path);
    const fake = fakePort(() => { throw new Error('Changed project source reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    await expect(projectContextSummary(f.context, { query: 'package deployment guidance' }, {
      ...options(), assertCurrent() {
        if (changed) return; changed = true;
        const stage = f.path + '.first-callback'; writeFileSync(stage, original); renameSync(stage, f.path);
      },
    })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(changed).toBe(true); expect(readFileSync(f.path).equals(original)).toBe(true); expect(fake.requests).toHaveLength(0);
  });

  test('provider exact IDs and native clocks are screened without account selection', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    const fake = fakePort(() => { throw new Error('Native provider ID entered selection'); }); installJudgmentPort(fake.port);
    const result = await describeHarnessProviderAccount(context, { providerId: 'openai' }, options());
    expect(result.status).toBe('found'); expectOnlyProviderDiagnostics(fake.requests);
  });

  test('provider list and phrase detail read complete native usage and route meaning', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    const catalog = await providerAccountSummary(context, { includeParameters: true }, options());
    if (!Array.isArray(catalog.providers)) throw new Error('Expected the native provider cohort');
    const ids = catalog.providers.map(raw => nativeId(raw));
    expect(ids).toContain('openai');
    const query = 'the subscription account with rolling five-hour and weekly usage windows';
    // Every captured native account is authored for this particular usage-window query.
    const readings = new Map(ids.map(id => [id, id === 'openai' ? .999 : .001]));
    const ranked = rankReadings(query, readings); installJudgmentPort(ranked.port);
    const list = await providerAccountSummary(context, { query, includeParameters: true, limit: 1 }, options());
    expect(list.providers).toEqual([expect.objectContaining({ providerId: 'openai', usageWindows: [expect.objectContaining({ label: '5-hour window' }), expect.objectContaining({ label: '1-week window' })] })]);
    expect(ranked.requests).toHaveLength(ids.length);
    const selected = selectReadings(query, 'openai', readings); installJudgmentPort(selected.port);
    const detail = await describeHarnessProviderAccount(context, { query }, options());
    expect(detail).toEqual(expect.objectContaining({ status: 'found', account: expect.objectContaining({ providerId: 'openai' }) }));
    const original = selectionRequest(selected.requests[0]?.state).candidates.find(candidate => candidate.nativeId === 'openai');
    expect(original?.content.evidence).toEqual(expect.objectContaining({ usageWindows: expect.any(Array), routeRecords: expect.any(Array), issues: expect.any(Array) }));
  });

  test('provider configuration mutation during source screening retires the captured account owner', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    let changed = false;
    const screening = researchScreeningFixture({ async beforeProposal() { if (!changed) { changed = true; managers.configManager.set('tools.llmEnabled', false); } } });
    const fake = fakePort(() => { throw new Error('Changed provider source reached catalog reading'); }); installJudgmentPort(fake.port);
    await expect(providerAccountSummary(context, { query: 'account authentication status' }, { sourceOwner: screening.owner })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(changed).toBe(true); expectOnlyProviderDiagnostics(fake.requests);
  });

  test('a first caller restriction cannot adopt in-place native provider model changes', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    const model = managers.providerRegistry.listModels()[0];
    if (!model) throw new Error('The actual native model catalog is empty');
    const description = model.description;
    const fake = fakePort(() => { throw new Error('Changed native model reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    try {
      await expect(providerAccountSummary(context, { query: 'account authentication status' }, {
        ...options(), assertCurrent() { if (!changed) { changed = true; model.description = 'Replacement model account meaning.'; } },
      })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(changed).toBe(true); expectOnlyProviderDiagnostics(fake.requests);
    } finally { model.description = description; }
  });

  test('a first caller restriction cannot adopt replaced native service file ownership', async () => {
    const managers = createTestManagers(), path = join(makeProjectTempDir('native-provider-service-source'), 'services.json');
    const original = JSON.stringify({ account: { name: 'account', providerId: 'openai', authType: 'oauth', tokenKey: 'NATIVE_CATALOG_ACCOUNT_KEY' } });
    writeFileSync(path, original);
    const serviceRegistry = new ServiceRegistry(path, { secretsManager: managers.secretsManager, subscriptionManager: managers.subscriptionManager });
    const context = { provider: { providerRegistry: managers.providerRegistry }, platform: { ...managers, serviceRegistry } };
    const fake = fakePort(() => { throw new Error('Changed native service file reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    await expect(providerAccountSummary(context, { query: 'account authentication status' }, {
      ...options(), assertCurrent() {
        if (changed) return; changed = true;
        const stage = path + '.first-callback'; writeFileSync(stage, original); renameSync(stage, path);
      },
    })).rejects.toBeInstanceOf(SecurityReadSourceRetiredError);
    expect(changed).toBe(true); expect(readFileSync(path, 'utf8')).toBe(original); expectOnlyProviderDiagnostics(fake.requests);
  });

  test('a first caller restriction cannot adopt replaced native subscription file ownership', async () => {
    const managers = createTestManagers(), path = join(makeProjectTempDir('native-provider-subscription-source'), 'subscriptions.json');
    const original = JSON.stringify({ version: 1, subscriptions: {}, pending: {} }); writeFileSync(path, original);
    const subscriptionManager = new SubscriptionManager(path);
    const context = { provider: { providerRegistry: managers.providerRegistry }, platform: { ...managers, subscriptionManager } };
    const fake = fakePort(() => { throw new Error('Changed native subscription file reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    await expect(providerAccountSummary(context, { query: 'account authentication status' }, {
      ...options(), assertCurrent() {
        if (changed) return; changed = true;
        const stage = path + '.first-callback'; writeFileSync(stage, original); renameSync(stage, path);
      },
    })).rejects.toBeInstanceOf(SecurityReadSourceRetiredError);
    expect(changed).toBe(true); expect(readFileSync(path, 'utf8')).toBe(original); expectOnlyProviderDiagnostics(fake.requests);
  });

  test('a first caller restriction cannot replace the original provider environment presence baseline', async () => {
    const original = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = '';
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    const fake = fakePort(() => { throw new Error('Changed provider environment reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    try {
      await expect(providerAccountSummary(context, { query: 'account authentication status' }, {
        ...options(), assertCurrent() { if (!changed) { changed = true; process.env.OPENAI_API_KEY = 'private-runtime-fixture-value'; } },
      })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(changed).toBe(true); expectOnlyProviderDiagnostics(fake.requests);
    } finally { if (original === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = original; }
  });

  test('a first caller restriction cannot replace the native provider expiration clock', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    const descriptor = Object.getOwnPropertyDescriptor(Date, 'now');
    if (!descriptor || !('value' in descriptor)) throw new Error('Native clock descriptor is unavailable');
    const original = Date.now;
    const fake = fakePort(() => { throw new Error('Changed native clock reached catalog reading'); }); installJudgmentPort(fake.port);
    let changed = false;
    try {
      await expect(providerAccountSummary(context, { query: 'account authentication status' }, {
        ...options(), assertCurrent() { if (!changed) { changed = true; Date.now = () => original() + 2 * 24 * 60 * 60 * 1000; } },
      })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(changed).toBe(true); expectOnlyProviderDiagnostics(fake.requests);
    } finally { Object.defineProperty(Date, 'now', descriptor); }
  });

  test('native credential mutation during source screening retires provider account publication', async () => {
    const managers = createTestManagers(), context = { provider: { providerRegistry: managers.providerRegistry }, platform: managers };
    await managers.providerRegistry.ready();
    await managers.providerRegistry.modelDiscoverySettled();
    let changed = false;
    const screening = researchScreeningFixture({ async beforeProposal() {
      if (changed) return; changed = true;
      await managers.secretsManager.set('NATIVE_CATALOG_ACCOUNT_KEY', 'private-runtime-fixture-value');
    } });
    const fake = fakePort(() => { throw new Error('Changed native credential reached catalog reading'); }); installJudgmentPort(fake.port);
    const failure = await providerAccountSummary(context, { query: 'account authentication status' }, { sourceOwner: screening.owner }).then(() => null, error => error);
    expect(changed, failure instanceof Error ? failure.stack : String(failure)).toBe(true);
    expect(failure).toBeInstanceOf(SecurityReadSourceRetiredError); expectOnlyProviderDiagnostics(fake.requests);
  });

  test('connected capability selection includes the complete allowed and blocked native cohort', async () => {
    const registry = new ToolRegistry(), all = [...connectedHostCapabilityMap(registry), ...blockedConnectedHostCapabilities()];
    const answers = new Map(all.map(entry => [nativeId(entry), nativeId(entry) === 'non-agent-knowledge' ? .999 : .001]));
    const fake = selectReadings('inspect isolated non-Agent knowledge boundary', 'non-agent-knowledge', answers); installJudgmentPort(fake.port);
    const result = await describeConnectedHostCapability(registry, 'inspect isolated non-Agent knowledge boundary', options());
    expect(result).toEqual(expect.objectContaining({ status: 'found', detail: expect.objectContaining({ status: 'blocked', allowed: false, available: false }) }));
    expect(selectionRequest(fake.requests[0]?.state).candidates).toHaveLength(all.length);
  });

  test('replacement of an equivalent native tool registration holds capability publication', async () => {
    const registry = new ToolRegistry();
    const tool: Tool = { definition: { name: 'agent_operator_briefing', description: 'Read operator briefing.', parameters: { type: 'object', properties: {} } },
      execute: async () => ({ success: true, output: 'native read result' }) };
    registry.register(tool);
    const all = [...connectedHostCapabilityMap(registry), ...blockedConnectedHostCapabilities()];
    const answers = new Map(all.map(entry => [nativeId(entry), nativeId(entry) === 'operator-briefing' ? .999 : .001]));
    let replaced = false;
    const fake = selectReadings('inspect pending operator work', 'operator-briefing', answers, () => {
      if (replaced) return; replaced = true; registry.unregister(tool.definition.name, tool); registry.register({ ...tool });
    });
    installJudgmentPort(fake.port);
    await expect(describeConnectedHostCapability(registry, 'inspect pending operator work', options())).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(replaced).toBe(true);
  });

  test('a first caller restriction cannot replace the original capability definition baseline', async () => {
    const registry = new ToolRegistry(); let executed = 0, changed = false;
    const tool: Tool = { definition: { name: 'agent_operator_briefing', description: 'Read operator briefing.', parameters: { type: 'object', properties: {} } },
      execute: async () => { executed++; return { success: true, output: 'native read result' }; } };
    registry.register(tool);
    const fake = fakePort(() => { throw new Error('Changed original capability entered semantic selection'); }); installJudgmentPort(fake.port);
    await expect(describeConnectedHostCapability(registry, 'inspect pending operator work', { ...options(), assertCurrent() {
      if (changed) return; changed = true; tool.definition.description = 'Replacement operator capability meaning.';
    } })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(changed).toBe(true); expect(fake.requests).toHaveLength(0); expect(executed).toBe(0);
  });

  test('a replaced native Tool definition accessor is refused before metadata can invoke it', async () => {
    const registry = new ToolRegistry(); let executed = 0, getterCalls = 0;
    const tool: Tool = { definition: { name: 'agent_operator_briefing', description: 'Read operator briefing.', parameters: { type: 'object', properties: {} } },
      execute: async () => { executed++; return { success: true, output: 'native read result' }; } };
    registry.register(tool);
    const descriptor = Object.getOwnPropertyDescriptor(tool, 'definition');
    if (!descriptor) throw new Error('Original native Tool definition descriptor missing');
    const all = [...connectedHostCapabilityMap(registry), ...blockedConnectedHostCapabilities()];
    const answers = new Map(all.map(entry => [nativeId(entry), nativeId(entry) === 'operator-briefing' ? .999 : .001]));
    const fake = selectReadings('inspect pending operator work', 'operator-briefing', answers, () => {
      Object.defineProperty(tool, 'definition', { configurable: true, get() { getterCalls++; return descriptor.value; } });
    });
    installJudgmentPort(fake.port);
    try { await expect(describeConnectedHostCapability(registry, 'inspect pending operator work', options())).rejects.toBeInstanceOf(ToolInputProjectionError); }
    finally { Object.defineProperty(tool, 'definition', descriptor); }
    expect(getterCalls).toBe(0); expect(executed).toBe(0);
  });

  test('async caller restrictions are refused before any MCP source list', async () => {
    const f = mcpFixture(); let lists = 0;
    f.api.listServerSecurity = () => { lists++; return f.servers; };
    await expect(mcpServerSummary(f.context, { query: 'inspect correspondence' }, { ...options(), assertCurrent: async () => {} })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(lists).toBe(0);
  });
});
