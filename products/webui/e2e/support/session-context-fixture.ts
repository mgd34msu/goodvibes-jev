/** Engine-owned runtime controls → real HTTP captures → production browser SDK. */
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { installMockDaemon } from './mock-daemon';
import { FOLLOWUP_SESSION, sessionRecord } from './seed';

type Usage = OperatorMethodOutput<'sessions.contextUsage.get'>;
export type ContextScenario = 'provider_api' | 'configured_cap' | 'observed_limit' | 'fallback' | 'consensus'
  | 'accepted_floor' | 'catalog' | 'no_model';
interface WireResponse { method: string; path: string; status: number; body: string }
interface ContextCapture {
  source: string;
  sessionId: string;
  hostedSessionId: string;
  scenarios: Record<ContextScenario | 'hosted_refusal', WireResponse>;
}

export function loadSessionContextCapture() {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/session-context-usage.json', import.meta.url), 'utf8')) as ContextCapture;
  const schema = operatorContract.operator.methods.find(entry => entry.id === 'sessions.contextUsage.get')?.outputSchema;
  if (!schema) throw new Error('Missing sessions.contextUsage.get output schema');
  for (const [name, wire] of Object.entries(capture.scenarios)) {
    const value: unknown = JSON.parse(wire.body);
    const sessionId = name === 'hosted_refusal' ? capture.hostedSessionId : capture.sessionId;
    if (wire.method !== 'GET' || wire.path !== `/api/sessions/${encodeURIComponent(sessionId)}/context-usage`) {
      throw new Error(`Invalid context-usage capture route: ${name}`);
    }
    if (name === 'hosted_refusal') {
      if (wire.status !== 404 || (value as { code?: string }).code !== 'SESSION_NOT_LOCAL') {
        throw new Error('Hosted session capture must refuse an unavailable store snapshot');
      }
    } else if (wire.status !== 200 || firstJsonSchemaFailure(schema, value) || (value as Usage).sessionId !== sessionId) {
      throw new Error(`Invalid context-usage response: ${name}`);
    }
  }
  return capture;
}

/** Other Work state is synthetic. Context usage is always the unmodified HTTP body. */
export async function installSessionContextDaemon(page: Page, initial: ContextScenario = 'provider_api') {
  const capture = loadSessionContextCapture();
  const daemon = await installMockDaemon(page, { localSessionId: capture.sessionId, approvals: [] });
  let scenario = initial;
  const reads: { sessionId: string; scenario: string }[] = [];
  const streams: { route: Route; domains: string[] }[] = [];
  const session = sessionRecord({ ...FOLLOWUP_SESSION, id: capture.sessionId, title: 'Context provenance local runtime' });
  const hosted = sessionRecord({ ...FOLLOWUP_SESSION, id: capture.hostedSessionId, title: 'Context provenance hosted scope' });
  await page.route(/\/api\/sessions(?:\/|\?|$)/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only context proof.' } });
    if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session, hosted], totals: { sessions: 2, active: 2, closed: 0 } } });
    if (path.endsWith('/context-usage')) {
      const wire = path === capture.scenarios.hosted_refusal.path ? capture.scenarios.hosted_refusal : capture.scenarios[scenario];
      if (path !== wire.path) throw new Error(`Unexpected context-usage target: ${path}`);
      reads.push({ sessionId: path === capture.scenarios.hosted_refusal.path ? capture.hostedSessionId : capture.sessionId,
        scenario: path === capture.scenarios.hosted_refusal.path ? 'hosted_refusal' : scenario });
      return route.fulfill({ status: wire.status, contentType: 'application/json', body: wire.body });
    }
    for (const record of [session, hosted]) {
      if (path === `/api/sessions/${record.id}`) return route.fulfill({ json: { session: record } });
      if (path === `/api/sessions/${record.id}/messages`) return route.fulfill({ json: { session: record, messages: [] } });
    }
    return route.fallback();
  });
  await page.route('**/api/control-plane/events?*', route => {
    const domains = new URL(route.request().url()).searchParams.get('domains')?.split(',') ?? [];
    if (domains.includes('providers') || domains.includes('compaction')) { streams.push({ route, domains }); return; }
    return route.fallback();
  });
  async function emit(domain: 'providers' | 'compaction', payload: unknown) {
    const matching = streams.filter(stream => stream.domains.includes(domain));
    if (!matching.length) throw new Error(`No ${domain} subscription opened`);
    for (const stream of matching) streams.splice(streams.indexOf(stream), 1);
    await Promise.all(matching.map(({ route }) => route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `event: ${domain}\ndata: ${JSON.stringify(payload)}\n\n` })));
  }
  return {
    ...daemon, capture, reads, session, hosted,
    usage(name: ContextScenario): Usage { return JSON.parse(capture.scenarios[name].body) as Usage; },
    setScenario(next: ContextScenario) { scenario = next; },
    hasStream(domain: 'providers' | 'compaction') { return streams.some(stream => stream.domains.includes(domain)); },
    emitProviderChange() { return emit('providers', { type: 'MODEL_CHANGED', provider: 'synthetic', registryKey: 'synthetic:model' }); },
    emitCompactionCheck(sessionId = capture.sessionId) {
      // Deliberately different numbers: this frame triggers a read, it must
      // never replace the estimator or derive a capacity in the UI itself.
      return emit('compaction', { type: 'COMPACTION_CHECK', sessionId, tokenCount: 999999, threshold: 1000000 });
    },
  };
}
