import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { createTaskRouteTool, planTaskRoute, readSlots, type TaskRouteDeps, type TaskRouteReadOptions } from '../../sdk/src/platform/routing/task-routes/index.js';
import { exactRouteSourceSpans, taskRouteSourceFixture } from '../_helpers/task-route-source.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected synthetic object.');
  return Object.fromEntries(Object.entries(value));
}
function readyPort() {
  return fakePort((name, question, state) => {
    const source = object(state);
    if (Array.isArray(source.candidates)) {
      const context = object(source.context), chosen = context.kind ? 'none' : 'host-runtime-diagnostics';
      if (name === 'pick') return choiceAnswer(question, chosen);
      const id = object(source.candidates[Number(name.slice('fits_'.length))]).id;
      return noulAnswer(id === chosen ? 0.95 : 0.05);
    }
    if (question.type === 'choice') return choiceAnswer(question, name === 'channelTask' ? 'status' : 'none');
    return noulAnswer(0.05);
  });
}
function deferred<T>() { return Promise.withResolvers<T>(); }
function gatedPort() {
  const fixture = readyPort(), entered = deferred<void>(), release = deferred<void>();
  const logs: string[] = [];
  const port: JudgmentPort = { model: fixture.port.model, recorder: {
    recordReadings() { logs.push('readings'); }, recordAction() { logs.push('action'); },
  }, async ask(request) {
    entered.resolve(); await release.promise; return { ...await fixture.port.ask(request), decisionId: 'synthetic-route-reading' };
  } };
  return { ...fixture, port, entered, release, logs };
}
const sources: Array<ReturnType<typeof taskRouteSourceFixture>> = [];
function source(options: Parameters<typeof taskRouteSourceFixture>[0] = {}) { const fixture = taskRouteSourceFixture(options); sources.push(fixture); return fixture; }
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); for (const fixture of sources.splice(0).reverse()) await fixture.close(); });

test('complete request past the old 4000-character boundary reaches every reading and catalog', async () => {
  const protectedSource = source(), fixture = readyPort(); installJudgmentPort(fixture.port);
  const request = 'Read these details. '.repeat(260) + ' Finally check daemon health with the saved provider.';
  const catalogs: string[] = [];
  const result = await planTaskRoute({ query: request }, {
    namedIds: { modelProvider: () => [{ id: 'saved-provider', names: ['Saved provider'] }] },
    workspaceMatches(query, _limit, current) { current?.assertCurrent?.(); catalogs.push(query); return []; },
    modeMatches(query, _limit, current) { current?.assertCurrent?.(); catalogs.push(query); return []; },
  }, { sourceOwner: protectedSource.owner });
  expect(result.status).toBe('ready'); expect(request.length).toBeGreaterThan(4000);
  expect(catalogs).toEqual([request, request]); expect(fixture.requests).toHaveLength(3);
  for (const call of fixture.requests) {
    const state = object(call.state), context = state.context;
    expect(context === undefined ? state.request : object(context).request).toBe(request);
  }
});

test('screened private spans remain local while the complete projected request is read', async () => {
  const privateValue = 'synthetic-private-arbor-span';
  const protectedSource = source({ spans: exactRouteSourceSpans([privateValue]) }), fixture = readyPort(); installJudgmentPort(fixture.port);
  const request = `Check daemon health for ${privateValue} and inspect the current host.`;
  const result = await planTaskRoute({ query: request }, {}, { sourceOwner: protectedSource.owner });
  expect(result.status).toBe('ready'); expect(JSON.stringify(protectedSource.calls)).toContain(privateValue);
  expect(JSON.stringify(fixture.requests)).not.toContain(privateValue); expect(JSON.stringify(result)).not.toContain(privateValue);
  expect(JSON.stringify(fixture.requests)).toContain('[redacted]');
});

test('private alias projection preserves literal identity while a masked literal id holds the plan', async () => {
  const alias = 'synthetic-private-alias', fixture = readyPort(); installJudgmentPort(fixture.port);
  const protectedSource = source({ spans: exactRouteSourceSpans([alias]) });
  await planTaskRoute({ query: 'check daemon health' }, { namedIds: { modelProvider: () => [{ id: 'saved-provider', names: [alias] }] } }, { sourceOwner: protectedSource.owner });
  expect(JSON.stringify(fixture.requests)).not.toContain(alias); expect(JSON.stringify(fixture.requests)).toContain('saved-provider');
  const maskedIdentity = source({ spans: exactRouteSourceSpans(['synthetic-private-id']) }), second = readyPort(); installJudgmentPort(second.port);
  await expect(planTaskRoute({ query: 'check daemon health' }, { namedIds: { modelProvider: () => [{ id: 'synthetic-private-id', names: ['Saved provider'] }] } }, { sourceOwner: maskedIdentity.owner })).rejects.toThrow();
  expect(second.requests).toHaveLength(0);
});

test('borrowed request and dependency accessors are refused without evaluating them', async () => {
  const protectedSource = source(), fixture = readyPort(); installJudgmentPort(fixture.port); let evaluated = 0;
  const args = {}; Object.defineProperty(args, 'query', { enumerable: true, get() { evaluated++; return 'check daemon health'; } });
  await expect(planTaskRoute(args, {}, { sourceOwner: protectedSource.owner })).rejects.toThrow();
  const deps = {}; Object.defineProperty(deps, 'namedIds', { enumerable: true, get() { evaluated++; return {}; } });
  await expect(planTaskRoute({ query: 'check daemon health' }, deps, { sourceOwner: protectedSource.owner })).rejects.toThrow();
  expect(evaluated).toBe(0); expect(fixture.requests).toHaveLength(0); expect(protectedSource.calls).toHaveLength(0);
});

test('empty request requires neither a source owner nor a provider', async () => {
  expect((await planTaskRoute({ query: ' ' })).status).toBe('missing_request');
});

test('missing or unsettled source authority sends no hosted requests', async () => {
  const fixture = readyPort(); installJudgmentPort(fixture.port);
  await expect(planTaskRoute({ query: 'check daemon health' })).rejects.toThrow();
  const protectedSource = source({ complete: 0 });
  await expect(planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: protectedSource.owner })).rejects.toThrow();
  expect(fixture.requests).toHaveLength(0);
});

test('an aborted caller cannot invoke named-source functions', async () => {
  const protectedSource = source(), controller = new AbortController(); controller.abort();
  let listings = 0;
  await expect(planTaskRoute({ query: 'check daemon health' }, { namedIds: { modelProvider() { listings++; return []; } } }, { sourceOwner: protectedSource.owner, signal: controller.signal })).rejects.toThrow();
  expect(listings).toBe(0); expect(protectedSource.calls).toHaveLength(0);
});

for (const field of ['query', 'limit'] as const) test(`a pending ${field} mutation cannot publish or log a route`, async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  const args = { query: 'check daemon health', limit: 3 };
  const pending = planTaskRoute(args, {}, { sourceOwner: protectedSource.owner }); await fixture.entered.promise;
  if (field === 'query') args.query = 'run another task'; else args.limit = 8;
  fixture.release.resolve(); await expect(pending).rejects.toThrow(); expect(fixture.logs).toHaveLength(0);
});

for (const change of ['function', 'alias', 'empty-list', 'catalog'] as const) test(`a pending ${change} source replacement cannot publish a route`, async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  const ids = [{ id: 'saved-provider', names: ['Saved provider'] }];
  const listing = { modelProvider: () => ids, memoryProvider: () => [] };
  const deps: TaskRouteDeps = { namedIds: listing, workspaceMatches: () => [] };
  const pending = planTaskRoute({ query: 'check daemon health' }, deps, { sourceOwner: protectedSource.owner }); await fixture.entered.promise;
  if (change === 'function') listing.modelProvider = () => ids;
  else if (change === 'alias') ids[0]!.names.push('New alias');
  else if (change === 'empty-list') listing.memoryProvider = () => [];
  else Object.defineProperty(deps, 'workspaceMatches', { value: () => [], enumerable: true });
  fixture.release.resolve(); await expect(pending).rejects.toThrow(); expect(fixture.logs).toHaveLength(0);
});

for (const change of ['callback', 'signal', 'owner-method'] as const) test(`a pending ${change} authority mutation cannot publish a route`, async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  const owner = { ...protectedSource.owner };
  const options: TaskRouteReadOptions = { sourceOwner: owner, signal: new AbortController().signal, assertCurrent() {} };
  const pending = planTaskRoute({ query: 'check daemon health' }, {}, options); await fixture.entered.promise;
  if (change === 'callback') Object.defineProperty(options, 'assertCurrent', { value() {} });
  else if (change === 'signal') Object.defineProperty(options, 'signal', { value: new AbortController().signal });
  else owner.project = receipt => protectedSource.owner.project(receipt);
  fixture.release.resolve(); await expect(pending).rejects.toThrow(); expect(fixture.logs).toHaveLength(0);
});

for (const change of ['installation', 'model', 'ask'] as const) test(`a pending ${change} port replacement cannot publish a route`, async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  const pending = planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: protectedSource.owner }); await fixture.entered.promise;
  if (change === 'installation') installJudgmentPort(readyPort().port);
  else if (change === 'model') Object.defineProperty(fixture.port, 'model', { value: 'replaced-model' });
  else Object.defineProperty(fixture.port, 'ask', { value: readyPort().port.ask });
  fixture.release.resolve(); await expect(pending).rejects.toThrow();
});

test('caller cancellation interrupts a noncooperating catalog without retaining its late result', async () => {
  const protectedSource = source(), fixture = readyPort(); installJudgmentPort(fixture.port);
  const entered = deferred<void>(), release = deferred<readonly Record<string, unknown>[]>(), controller = new AbortController();
  const pending = planTaskRoute({ query: 'check daemon health' }, { workspaceMatches() { entered.resolve(); return release.promise; } }, { sourceOwner: protectedSource.owner, signal: controller.signal });
  await entered.promise; controller.abort();
  const outcome = await Promise.race([pending.then(() => 'published', () => 'held'), new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 250))]);
  expect(outcome).toBe('held'); release.resolve([{ id: 'late' }]); await expect(pending).rejects.toThrow();
});

test('retained publication authority survives source cleanup and rejects subsequent inputs and provider changes', async () => {
  const protectedSource = source(), fixture = readyPort(); installJudgmentPort(fixture.port);
  const args = { query: 'check daemon health' }; let retained: (() => void) | undefined;
  await planTaskRoute(args, {}, { sourceOwner: protectedSource.owner, retainCurrent(guard) { retained = guard; } });
  expect(retained).toBeDefined(); expect(() => retained?.()).not.toThrow();
  args.query = 'another task'; expect(() => retained?.()).toThrow(); args.query = 'check daemon health';
  installJudgmentPort(readyPort().port); expect(() => retained?.()).toThrow();
});

test('standalone slot reader guards even an initially empty named-source listing', async () => {
  const fixture = gatedPort(), namedIds = { modelProvider: () => [] };
  const pending = readSlots(fixture.port, 'check daemon health', { site: 'synthetic.route.slots', namedIds }); await fixture.entered.promise;
  namedIds.modelProvider = () => []; fixture.release.resolve(); await expect(pending).rejects.toThrow();
});

test('route tool forwards its invocation ownership and checks the complete borrowed arguments', async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  let current = true; const args = { query: 'check daemon health' };
  const tool = createTaskRouteTool({}, { sourceOwner: protectedSource.owner });
  const pending = tool.execute(args, { assertCurrent() { if (!current) throw new Error('Invocation retired.'); } });
  await fixture.entered.promise; current = false; fixture.release.resolve(); await expect(pending).rejects.toThrow();
});

test('complete original private response fields are refused before any decision is logged', async () => {
  const protectedSource = source(), fixture = readyPort(), logs: string[] = [];
  const port: JudgmentPort = { model: fixture.port.model, recorder: {
    recordReadings() { logs.push('readings'); }, recordAction() { logs.push('action'); },
  }, async ask(request) {
    return { ...await fixture.port.ask(request), decisionId: 'synthetic-route-reading', extra: { password: 'synthetic-private-response' } };
  } };
  installJudgmentPort(port);
  await expect(planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: protectedSource.owner })).rejects.toThrow();
  expect(logs).toHaveLength(0);
});

test('original response accessors are rejected without evaluating them', async () => {
  const protectedSource = source(), fixture = readyPort(); let evaluated = 0;
  const port: JudgmentPort = { model: fixture.port.model, async ask(request) {
    const response = await fixture.port.ask(request);
    Object.defineProperty(response, 'extra', { enumerable: true, get() { evaluated++; return 'borrowed-private-response'; } });
    return response;
  } };
  installJudgmentPort(port);
  await expect(planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: protectedSource.owner })).rejects.toThrow();
  expect(evaluated).toBe(0);
});

test('caller cancellation interrupts noncooperating route and slot providers', async () => {
  const protectedSource = source(), fixture = gatedPort(), controller = new AbortController(); installJudgmentPort(fixture.port);
  const pending = planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: protectedSource.owner, signal: controller.signal }); await fixture.entered.promise;
  controller.abort();
  const outcome = await Promise.race([pending.then(() => 'published', () => 'held'), new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 250))]);
  expect(outcome).toBe('held'); fixture.release.resolve(); await expect(pending).rejects.toThrow();
  await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(fixture.logs).toHaveLength(0);
});

test('tool invocation signal replacement is fenced by identity', async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  const invocation = { signal: new AbortController().signal }, tool = createTaskRouteTool({}, { sourceOwner: protectedSource.owner });
  const pending = tool.execute({ query: 'check daemon health' }, invocation); await fixture.entered.promise;
  invocation.signal = new AbortController().signal; fixture.release.resolve(); await expect(pending).rejects.toThrow(); expect(fixture.logs).toHaveLength(0);
});

test('source release replacement cannot hijack original owned cleanup', async () => {
  const protectedSource = source(), fixture = gatedPort(); installJudgmentPort(fixture.port);
  let ownedReleases = 0, replacementReleases = 0;
  const owner = { ...protectedSource.owner, release(handle: Parameters<typeof protectedSource.owner.release>[0]) {
    ownedReleases++; return protectedSource.owner.release(handle);
  } };
  const pending = planTaskRoute({ query: 'check daemon health' }, {}, { sourceOwner: owner }); await fixture.entered.promise;
  owner.release = () => { replacementReleases++; return Promise.resolve(); };
  fixture.release.resolve(); await expect(pending).rejects.toThrow();
  expect(ownedReleases).toBe(1); expect(replacementReleases).toBe(0); expect(fixture.logs).toHaveLength(0);
});
