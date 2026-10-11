import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { BrowserEngine, BrowserSessionManager } from '@goodvibes-jev/engine/sdk/platform/browser';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createAgentOperatorMethodTool } from '../../tools/agent-operator-method-tool.ts';
import { createOperatorInputProjector } from '../../tools/agent-operator-input-projector.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const cleanups: Array<() => void> = [];
let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let readings: ReturnType<typeof fakePort>['requests'];
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => {
    if (question.type === 'choice') return choiceAnswer(question,
      name === 'disposition' ? 'act' : name === 'kind' ? 'other' : 'generic', 0.999);
    if (question.type === 'noul') return noulAnswer(name === 'needs_review' ? 0.99 : 0.001);
    throw new Error(`Unexpected operator metered question ${name}`);
  });
  readings = fake.requests;
  previous = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  installJudgmentPort(previous); log[Symbol.dispose]();
});

async function scene(mode: 'prompt' | 'plan' | 'custom') {
  const root = makeProjectTempDir('agent-operator-metered');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'),
    JSON.stringify({ token: 'synthetic-metered-operator-token' }));
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root,
    configDir: join(root, '.goodvibes', 'agent') });
  const store = new MemoryStore(join(root, 'memory.sqlite'), { enableVectorIndex: false,
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: config }) });
  cleanups.push(() => store.close()); await store.init();
  const registry = new MemoryRegistry(store);
  const record = await registry.add({ cls: 'fact', summary: 'One native operator audit memory' });
  const screenshotDirectory = join(root, 'owned-screenshots');
  const destination = join(root, 'existing-project-file.png');
  writeFileSync(destination, 'original project content');
  let screenshots = 0;
  const sessions = new BrowserSessionManager({ profileRoot: join(root, 'browser-profile'), surfaceRoot: 'test' });
  // Only the external Playwright page seam is synthetic. BrowserEngine chooses
  // the actual path and the seam performs the filesystem write on that path.
  Object.defineProperty(sessions, 'page', { value: async () => ({ pageId: 'audit-page', page: {
    url: () => 'about:blank',
    async screenshot(options: { readonly path: string }) {
      screenshots++;
      const bytes = Buffer.from('synthetic isolated screenshot');
      writeFileSync(options.path, bytes);
      return bytes;
    },
  } }) });
  const browser = new BrowserEngine(sessions, { screenshotDirectory, untrusted: {
    rule: 'Untrusted browser content', originOf: url => url,
    label: () => { throw new Error('No content label is requested by screenshot'); },
    recordIngest: () => {},
    evaluateOutwardEffect: async () => { throw new Error('No outward browser action is requested'); },
  } });
  let httpRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    httpRequests++;
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-metered-operator-token');
    const path = new URL(request.url).pathname;
    if (path === '/api/browser/screenshot') {
      const input: unknown = await request.json();
      const supplied = input && typeof input === 'object' && 'path' in input && typeof input.path === 'string'
        ? input.path.trim() : '';
      return Response.json(await browser.screenshot({ sessionId: 'audit-session' }, supplied ? { path: supplied } : {}));
    }
    if (path === '/api/memory/review-queue') return Response.json({ records: await registry.reviewQueue(10) });
    if (path === `/api/memory/records/${record.id}`) return Response.json({ record: registry.get(record.id) });
    return new Response('Unknown isolated route', { status: 404 });
  } });
  cleanups.push(() => server.stop(true));
  config.set('controlPlane.port', server.port!);
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const tool = createAgentOperatorMethodTool(paths, config);
  const fixture = recordedEffectFixture(tool, mode, mode === 'custom' ? { write: 'deny' } : {}, root);
  fixture.registry.unregister(tool.definition.name);
  fixture.registry.register(tool, { inputProjection: createOperatorInputProjector(paths, config, 'method') });
  const dispatches = () => readings.filter(request => request.context?.battery === 'engine.state.memory-review-priority').length;
  return { fixture, record, destination, screenshotDirectory, screenshots: () => screenshots, httpRequests: () => httpRequests, dispatches };
}

test('a genuinely admitted prompt-mode review reaches real SQL and native metered work', async () => {
  const f = await scene('prompt');
  const result = await f.fixture.run({ methodId: 'memory.review-queue', input: { limit: 10 } });
  expect({ success: result.success, http: f.httpRequests(), provider: f.dispatches() }).toEqual({ success: true, http: 1, provider: 1 });
});

test.each(['plan', 'custom'] as const)('native read-only review ranking remains available to an admitted parent in %s', async mode => {
  const f = await scene(mode);
  const result = await f.fixture.run({ methodId: 'memory.review-queue', input: { limit: 10 } });
  expect({ success: result.success, http: f.httpRequests(), provider: f.dispatches() }).toEqual({ success: true, http: 1, provider: 1 });
});

test.each(['plan', 'custom'] as const)('ordinary native SQL reads stay available in %s without metered work', async mode => {
  const f = await scene(mode);
  const result = await f.fixture.run({ methodId: 'memory.records.get', input: { id: f.record.id } });
  expect({ success: result.success, http: f.httpRequests(), provider: f.dispatches() }).toEqual({ success: true, http: 1, provider: 0 });
});

test('metered method preview stays available in plan mode without HTTP or native provider dispatch', async () => {
  const f = await scene('plan');
  const result = await f.fixture.run({ methodId: 'memory.review-queue', input: { limit: 10 }, dryRun: true });
  expect({ success: result.success, http: f.httpRequests(), provider: f.dispatches() }).toEqual({ success: true, http: 0, provider: 0 });
});

test('prompt-mode explicit screenshot destination reaches BrowserEngine and the actual filesystem', async () => {
  const f = await scene('prompt');
  const result = await f.fixture.run({ methodId: 'browser.screenshot', input: { path: f.destination } });
  expect({ success: result.success, http: f.httpRequests(), captures: f.screenshots() }).toEqual({ success: true, http: 1, captures: 1 });
  expect(readFileSync(f.destination, 'utf8')).toBe('synthetic isolated screenshot');
});

test.each(['plan', 'custom'] as const)('an explicit screenshot destination cannot overwrite a project file in %s', async mode => {
  const f = await scene(mode);
  const result = await f.fixture.run({ methodId: 'browser.screenshot', input: { path: f.destination } });
  expect({ success: result.success, http: f.httpRequests(), captures: f.screenshots() }).toEqual({ success: false, http: 0, captures: 0 });
  expect(readFileSync(f.destination, 'utf8')).toBe('original project content');
});

test.each(['plan', 'custom'] as const)('the default owned screenshot observation remains available in %s', async mode => {
  const f = await scene(mode);
  const result = await f.fixture.run({ methodId: 'browser.screenshot', input: {} });
  expect({ success: result.success, http: f.httpRequests(), captures: f.screenshots() }).toEqual({ success: true, http: 1, captures: 1 });
  expect(readFileSync(f.destination, 'utf8')).toBe('original project content');
  const artifacts = readdirSync(f.screenshotDirectory);
  expect(artifacts).toHaveLength(1);
  expect(readFileSync(join(f.screenshotDirectory, artifacts[0]!), 'utf8')).toBe('synthetic isolated screenshot');
});
