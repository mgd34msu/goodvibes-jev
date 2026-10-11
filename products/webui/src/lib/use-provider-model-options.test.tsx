import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { tokenStore } from './client-lifetime';
type Request = BrowserJudgmentRequest<'webui.models.catalog-provider-match'>;
let respond: (request: Request) => Promise<unknown>;
const requests: Request[] = [];
mock.module('./goodvibes', () => ({ runBrowserJudgment: (request: Request) => { requests.push(request); return respond(request); } }));
const { useProviderModelOptions } = await import('./use-provider-model-options');
function answer(request: Request, status: 'settled' | 'held' = 'settled') {
  const settled = status === 'settled';
  return { protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1, status,
    outcome: settled ? 'act' : 'confirm', ...(settled ? { value: { matches: request.input.keys.map(() => true) } } : { reason: 'uncertain' }),
    readings: Object.fromEntries(request.input.keys.map((_, i) => [`key_${i}`, { kind: 'yes-no', probability: settled ? 0.999 : 0.5, verdict: settled ? 'yes' : 'uncertain', outcome: settled ? 'act' : 'confirm' }])),
    evidence: request.input.keys.map((_, i) => ({ decisionId: `fixture-${i}`, model: 'fixture', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 })),
  };
}
const provider = { providerId: 'inception' };
const catalog = [{ providerId: 'inceptionlabs', models: ['model-fixture'] }];
function mount() {
  let result!: ReturnType<typeof useProviderModelOptions>;
  function Caller(props: { provider: unknown; catalog: unknown[]; session: string; enabled: boolean }) {
    result = useProviderModelOptions(props.provider, props.catalog, props.session, props.enabled);
    return <div>{result.models.map(model => model.registryKey).join(',')}</div>;
  }
  const host = document.createElement('div'); const root = createRoot(host); let mounted = true;
  const render = (p = provider as unknown, c: unknown[] = catalog, session = 'session-a', enabled = true) => flushSync(() => root.render(<Caller provider={p} catalog={c} session={session} enabled={enabled} />));
  render();
  return { host, render, result: () => result, unmount() { if (mounted) { mounted = false; flushSync(() => root.unmount()); } } };
}
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(check()).toBe(true); }
afterEach(async () => { requests.length = 0; await tokenStore.clearToken(); });
test('mounted model caller uses a canonical alias result; held readings expose no inferred model', async () => {
  await tokenStore.setToken('fixture-browser-owner'); respond = async request => answer(request, 'held');
  const h = mount(); try {
    await until(() => requests.length === 1); expect(h.result().models).toEqual([]);
    respond = async request => answer(request); h.render(provider, catalog, 'session-b');
    await until(() => h.result().models.length === 1);
    expect(h.result().hasCurrentModel('inceptionlabs:model-fixture')).toBe(true);
    expect(requests[1]?.input).toEqual({ providerId: 'inception', keys: ['inceptionlabs'] });
  } finally { h.unmount(); }
});
test.each(['provider', 'catalog', 'session', 'refresh', 'token', 'unmount'] as const)('%s retirement refuses valid late model answers and detached selection callbacks', async kind => {
  await tokenStore.setToken('fixture-browser-owner'); const barrier = Promise.withResolvers<undefined>();
  respond = async request => { await barrier.promise; return answer(request); };
  const h = mount(); const retired = h.result();
  try {
    await until(() => requests.length === 1);
    if (kind === 'provider') h.render({ providerId: 'different-provider' }, [], 'session-a');
    if (kind === 'catalog') h.render(provider, [], 'session-a');
    if (kind === 'session') h.render(provider, [], 'session-b');
    if (kind === 'refresh') h.render(provider, catalog, 'session-a', false);
    if (kind === 'token') await tokenStore.setToken('replacement-owner');
    if (kind === 'unmount') h.unmount();
    barrier.resolve(undefined); await new Promise(resolve => setTimeout(resolve, 0));
    expect(retired.hasCurrentModel('inceptionlabs:model-fixture')).toBe(false);
    if (kind !== 'unmount' && kind !== 'token') expect(h.result().models).toEqual([]);
  } finally { barrier.resolve(undefined); h.unmount(); }
});
test('explicit wire catalog identity works without waiting for an inferred match', async () => {
  await tokenStore.setToken('fixture-browser-owner'); respond = async request => answer(request, 'held');
  const h = mount(); try {
    h.render({ providerId: 'inception', catalogProviderId: 'inceptionlabs' });
    expect(h.result().models.map(model => model.registryKey)).toEqual(['inceptionlabs:model-fixture']);
  } finally { h.unmount(); }
});

test('unmount and client change revoke detached handlers even for explicit models', async () => {
  await tokenStore.setToken('fixture-browser-owner'); respond = async request => answer(request);
  const h = mount(); h.render({ providerId: 'inception', catalogProviderId: 'inceptionlabs' });
  const detached = h.result(); expect(detached.hasCurrentModel('inceptionlabs:model-fixture')).toBe(true);
  h.unmount(); expect(detached.hasCurrentModel('inceptionlabs:model-fixture')).toBe(false);
});
