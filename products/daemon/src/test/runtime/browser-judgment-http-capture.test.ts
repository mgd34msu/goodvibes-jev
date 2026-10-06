/** Runtime-generated browser fixtures. The loopback System One answers are synthetic. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/sdk/platform/intake';
import { WEBUI_BUILTIN_COMMANDS, WEBUI_COMMAND_CATALOG_VERSION } from '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

test('capture production-composed browser palette and daemon-refusal HTTP wires', async () => {
  const calls: { state: { candidate?: { title: string } }; questions: Record<string, unknown> }[] = [];
  let selection = 'Go to Library';
  let uncertain = false;
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/systemone') return new Response(null, { status: 404 });
    const input = await request.json() as typeof calls[number];
    calls.push(input);
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(input.questions).map(name =>
      [name, { type: 'noul', noul: uncertain ? 0.5 : name === 'match'
        ? input.state.candidate?.title === selection ? 0.99 : 0.01
        : name === 'method_unknown' ? 0.99 : 0.01 }])), usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const identities = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  const restore = () => { identities.mockRestore(); benchmarks.mockRestore(); discovery.mockRestore(); endpoint.stop(true); };
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root: makeOwnedTempDir('browser-judgment-capture'),
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
      configure(config) { config.set('judgment.endpoint', `http://127.0.0.1:${endpoint.port}`); config.set('judgment.keySource', 'secret'); config.set('judgment.model', 'jev-1.13.0'); },
    });
  } catch (error) { restore(); throw error; }
  const originalGet = daemon.services.secretsManager.get.bind(daemon.services.secretsManager);
  const secrets = spyOn(daemon.services.secretsManager, 'get').mockImplementation(name => name === 'TYPESAFE_API_KEY' ? Promise.resolve('synthetic-browser-capture-key') : originalGet(name));
  async function wire(path: string, method = 'GET', requestBody?: unknown) {
    const response = await daemon.fetch(path, { method, ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }) });
    return { path, method, ...(requestBody === undefined ? {} : { requestBody }), status: response.status,
      cacheControl: response.headers.get('cache-control'), body: await response.text() };
  }
  const run = (requestBody: BrowserJudgmentRequest) => wire('/api/judgment/batteries/run', 'POST', requestBody);
  try {
    const title = 'Synthetic café plans';
    const created = await wire('/api/companion/chat/sessions', 'POST', { title });
    expect(created.status).toBe(201);
    const sessionId = (JSON.parse(created.body) as { sessionId: string }).sessionId;
    const listBefore = await wire('/api/companion/chat/sessions?includeClosed=true&limit=100');
    const session = await wire(`/api/companion/chat/sessions/${sessionId}`);
    // Same group/title ordering as getCommands(); replay asserts exact identities and order.
    const candidates = [...WEBUI_BUILTIN_COMMANDS.map(command => ({ group: command.group, title: command.title,
      candidate: { kind: 'builtin' as const, commandId: command.id } })),
      { group: 'chats', title, candidate: { kind: 'chat' as const, sessionId } }]
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title)).map(item => item.candidate);
    const palette = (text: string): BrowserJudgmentRequest<'webui.palette.command-rank'> => ({
      protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.palette.command-rank', batteryVersion: 1,
      input: { query: { kind: 'inline', text }, registryVersion: WEBUI_COMMAND_CATALOG_VERSION, candidates },
    });
    const library = await run(palette('show saved material'));
    selection = title;
    const chat = await run(palette('Find synthetic café plans'));
    uncertain = true;
    const held = await run(palette('uncertain synthetic command'));
    uncertain = false;
    for (const capture of [library, chat]) {
      expect(capture.status).toBe(200);
      expect(JSON.parse(capture.body)).toMatchObject({ status: 'settled', outcome: 'act', evidence: expect.any(Array) });
      expect(JSON.parse(capture.body).evidence).toHaveLength(candidates.length);
    }
    expect(candidates).toHaveLength(28);
    expect(JSON.parse(held.body)).toMatchObject({ status: 'held', reason: 'uncertain' });
    expect(JSON.stringify(calls)).not.toContain(sessionId);
    expect(calls.some(call => call.state.candidate?.title === title)).toBe(true);

    // A synthetic handler behind the real canonical method and authenticated
    // invocation route. The browser replays this same-method response at its
    // direct close URL; neither the issuer nor judgment service is replaced.
    const descriptor = daemon.services.gatewayMethods.get('companion.chat.sessions.close');
    if (!descriptor) throw new Error('Missing canonical companion close descriptor');
    daemon.services.gatewayMethods.register({ ...descriptor, invokable: true }, async () => {
      throw Object.assign(new Error('Synthetic close operation is unavailable on this endpoint.'), { status: 404, code: 'SYNTHETIC_CLOSE_UNAVAILABLE' });
    }, { replace: true });
    const close = await wire('/api/control-plane/methods/companion.chat.sessions.close/invoke', 'POST', { body: { sessionId } });
    expect(close.status, close.body).toBe(404);
    expect(close.cacheControl).toBe('no-store');
    const errorRef = (JSON.parse(close.body) as { errorRef: string }).errorRef;
    expect(errorRef).toBeString();
    const refusal = (): BrowserJudgmentRequest<'webui.errors.daemon-refusal'> => ({
      protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.errors.daemon-refusal', batteryVersion: 1, input: { errorRef },
    });
    const errorSettled = await run(refusal());
    expect(errorSettled.status, errorSettled.body).toBe(200);
    expect(JSON.parse(errorSettled.body)).toMatchObject({ status: 'settled', outcome: 'act', value: {
      method_unknown: true, session_not_found: false, session_closed: false, session_active: false, session_not_local: false,
    } });
    uncertain = true;
    const errorHeld = await run(refusal());
    expect(JSON.parse(errorHeld.body)).toMatchObject({ status: 'held', reason: 'uncertain' });
    const actualClose = await wire(`/api/companion/chat/sessions/${sessionId}/close`, 'POST', {});
    expect(actualClose.status).toBe(200);
    const deleted = await wire(`/api/companion/chat/sessions/${sessionId}`, 'DELETE');
    expect(deleted.status).toBe(200);
    const listAfter = await wire('/api/companion/chat/sessions?includeClosed=true&limit=100');
    expect(JSON.parse(listAfter.body)).toMatchObject({ sessions: [] });
    const decisions = daemon.services.judgment.decisionLog.query({ battery: 'webui.errors.daemon-refusal' });
    expect(decisions).toHaveLength(2);
    const paletteDecisions = daemon.services.judgment.decisionLog.query({ battery: 'webui.palette.command-rank' });
    expect(paletteDecisions).toHaveLength(84);
    for (const capture of [library, chat, held, errorSettled, errorHeld]) {
      const evidence = (JSON.parse(capture.body) as { evidence: { decisionId: string; model: string; requestedModel: string; latencyMs: number; usage: unknown }[] }).evidence;
      for (const item of evidence) {
        const record = [...decisions, ...paletteDecisions].find(entry => entry.id === item.decisionId);
        expect(record).toMatchObject({ status: 'answered', model: item.model, requestedModel: item.requestedModel, latencyMs: item.latencyMs, usage: item.usage });
      }
    }
    const directory = process.env.GOODVIBES_TEST_BROWSER_JUDGMENT_FIXTURE_DIR;
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'runtime.json'), `${JSON.stringify({
        source: 'Owned loopback synthetic System One; actual default runtime composition and authenticated DaemonServer HTTP. No live model or credential.',
        title, sessionId, listBefore, session, library, chat, held, close, errorSettled, errorHeld, deleted, listAfter,
      }, null, 2)}\n`);
    }
  } finally { try { await daemon.stop(); } finally { secrets.mockRestore(); restore(); } }
}, 30_000);
