/** Offline routes use the real SDK service adapter, canonical rerank and owned result retention. */
import { afterEach, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { buildMediaRouteContext } from '../sdk/src/platform/daemon/http/router-route-contexts.js';
import { createDaemonMediaRouteHandlers } from '../daemon-sdk/src/media-routes.js';
import { multimodalFixture } from './_helpers/multimodal-entities.js';

let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function routes(kind: 'image' | 'audio' | 'video' | 'document' = 'image', text?: string) {
  const fixture = multimodalFixture(kind, text);
  const fake = fakePort((_name, _question, state) => noulAnswer((state as { candidate: { term: string } }).candidate.term === 'AI' ? 0.99 : 0.01));
  if (!installed) { previous = installJudgmentPort(fake.port); installed = true; } else installJudgmentPort(fake.port);
  let admin = true;
  const handlers = createDaemonMediaRouteHandlers(buildMediaRouteContext({
    artifactStore: fixture.artifactStore as never, configManager: { get: () => undefined } as never,
    mediaProviders: fixture.mediaProviders as never, voiceService: fixture.voiceService as never,
    webSearchService: {} as never, multimodalService: fixture.service,
    parseJsonBody: async request => await request.json() as Record<string, unknown>,
    requireAdmin: () => admin ? null : new Response('Unauthorized', { status: 403 }),
  }));
  const request = (body: unknown, signal?: AbortSignal) => new Request('http://localhost/api/multimodal/analyze', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
  });
  return { ...fixture, handlers, request, fake, deny: () => { admin = false; } };
}

for (const kind of ['image', 'audio', 'video', 'document'] as const) {
  test(`${kind}: actual daemon analysis renders entities and later explicit write-back retains ownership`, async () => {
    const fixture = routes(kind);
    if (kind === 'video') fixture.add('transcript', 'document');
    const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', includePacket: true,
      ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}),
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { analysis: { entities: string[] }; packet: { rendered: string } };
    expect(body.analysis.entities).toEqual(['AI']); expect(body.packet.rendered).toContain('Entities: AI');
    expect(fixture.writes).toHaveLength(0);
    const packet = await fixture.handlers.postMultimodalPacket(fixture.request({ analysis: body.analysis }));
    expect(packet.status).toBe(200);
    const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }));
    expect(writeback.status).toBe(201); expect(fixture.writes).toHaveLength(1);
    expect(fixture.ingests[0]).toMatchObject({ tags: expect.arrayContaining(['AI']) });
  });
}

for (const condition of ['artifact', 'cancel', 'port', 'forgery', 'unauthorized'] as const) {
  test(`later daemon write-back rejects ${condition} without persistence`, async () => {
    const fixture = routes(); const controller = new AbortController();
    const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source' }, controller.signal));
    expect(response.status).toBe(201);
    const body = await response.json() as { analysis: Record<string, unknown> };
    if (condition === 'artifact') fixture.records.delete('source');
    if (condition === 'cancel') controller.abort();
    if (condition === 'port') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    if (condition === 'forgery') body.analysis.entities = ['invented'];
    if (condition === 'unauthorized') fixture.deny();
    const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }));
    expect(writeback.status).toBe(condition === 'unauthorized' ? 403 : 400);
    expect(fixture.writes).toHaveLength(0); expect(fixture.ingests).toHaveLength(0);
    const packet = await fixture.handlers.postMultimodalPacket(fixture.request({ analysis: body.analysis }));
    expect(packet.status).toBe(condition === 'unauthorized' ? 403 : 400);
  });
}

test('daemon metadata never grants write-back and blocked private-host policy still runs', async () => {
  const fixture = routes();
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', metadata: { writeback: true } }));
  // Source metadata is never used as explicit write-back permission.
  expect(response.status).toBe(201); expect(fixture.writes).toHaveLength(0);
  fixture.deny();
  const denied = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifact: { uri: 'http://127.0.0.1/file', allowPrivateHosts: true } }));
  expect(denied.status).toBe(403); expect(fixture.writes).toHaveLength(0);
});

test('daemon uncertain readings cannot trigger requested automatic write-back', async () => {
  const fixture = routes(); installJudgmentPort(fakePort(() => noulAnswer(0.5)).port);
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', writeback: true, includePacket: true }));
  expect(response.status).toBe(400); expect(fixture.writes).toHaveLength(0);
});

test('new canceled write-back request cannot reuse an otherwise current analysis', async () => {
  const fixture = routes();
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source' }));
  const body = await response.json() as { analysis: unknown };
  const controller = new AbortController(); controller.abort();
  const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }, controller.signal));
  expect(writeback.status).toBe(400); expect(fixture.writes).toHaveLength(0);
});
