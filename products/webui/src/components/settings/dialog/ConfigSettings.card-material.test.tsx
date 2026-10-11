import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../lib/toast';
import { tokenStore } from '../../../lib/client-lifetime';
import { displayConfigValue } from '../../../lib/config-redaction';
import type { BrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
type Request = BrowserJudgmentRequest<'webui.config.credential-key' | 'webui.settings.card-material-key'>;
let config: unknown;
let barrier: Promise<void> | undefined;
let held = false;
const requests: Request[] = [];
mock.module('../../../lib/goodvibes', () => ({
  sdk: { operator: { config: { get: async () => config, set: async () => ({ success: true }) } } },
  runBrowserJudgment: async (request: Request) => {
    requests.push(request); const wait = barrier; await wait;
    const isCard = request.battery === 'webui.settings.card-material-key';
    const matches = request.input.keys.map(key => isCard ? key === 'custom.cardPayload' : key === 'custom.privateLabel');
    return { protocolVersion: 1, requestId: request.requestId, battery: request.battery, batteryVersion: 1,
      status: held ? 'held' : 'settled', outcome: held ? 'confirm' : 'act',
      ...(held ? { reason: 'uncertain' } : { value: { matches } }),
      readings: Object.fromEntries(matches.map((yes, i) => [`key_${i}`, { kind: 'yes-no', probability: held ? 0.5 : yes ? 0.999 : 0.001,
        verdict: held ? 'uncertain' : yes ? 'yes' : 'no', outcome: held ? 'confirm' : 'act' }])),
      evidence: matches.map((_, i) => ({ decisionId: `fixture-${i}`, model: 'fixture', requestedModel: 'fixture', usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 })),
    };
  },
}));
const { ConfigSettingsProvider, useConfigSettings } = await import('./ConfigSettings');
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const host = document.createElement('div'); const root = createRoot(host); let mounted = true;
  function Rows() { const { groups } = useConfigSettings(); return <>{groups.flatMap(group => group.rawRows).map(row => <div key={row.key}>{row.key}:{displayConfigValue(row.key, row.value, row.displayCleared)}</div>)}</>; }
  flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider><ConfigSettingsProvider><Rows /></ConfigSettingsProvider></ToastProvider></QueryClientProvider>));
  return { host, client, unmount() { if (mounted) { mounted = false; flushSync(() => root.unmount()); } client.clear(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(check()).toBe(true); }
afterEach(async () => { requests.length = 0; barrier = undefined; held = false; await tokenStore.clearToken(); });
test('actual settings caller excludes card rows, masks uncleared secrets, and transmits metadata names only', async () => {
  await tokenStore.setToken('fixture-owner');
  config = { custom: { cardPayload: 'PRIVATE_CARD_FIXTURE', ordinaryLabel: 'visible-label', privateLabel: 'PRIVATE_SECRET_FIXTURE' }, payments: { cardNumber: 'DECLARED_CARD_FIXTURE' } };
  const h = mount(); try {
    await until(() => h.host.textContent?.includes('visible-label') === true);
    expect(h.host.textContent).not.toContain('cardPayload'); expect(h.host.textContent).not.toContain('PRIVATE'); expect(h.host.textContent).not.toContain('DECLARED_CARD');
    expect(h.host.textContent).toContain('custom.privateLabel:••••');
    expect(JSON.stringify(requests)).not.toContain('PRIVATE'); expect(JSON.stringify(requests)).not.toContain('visible-label');
    expect(requests.some(request => request.input.keys.includes('payments.cardNumber'))).toBe(false);
  } finally { h.unmount(); }
});
test('held card readings leave every unknown row excluded', async () => {
  await tokenStore.setToken('fixture-owner'); held = true; config = { custom: { ordinaryLabel: 'must-stay-hidden' } };
  const h = mount(); try { await until(() => requests.length === 2); await new Promise(resolve => setTimeout(resolve, 0)); expect(h.host.textContent).not.toContain('ordinaryLabel'); } finally { h.unmount(); }
});
test.each(['refresh', 'token', 'unmount'] as const)('settings %s rejects a valid late card-clearance response', async kind => {
  await tokenStore.setToken('fixture-owner'); config = { custom: { ordinaryLabel: 'old-private-fixture' } };
  const pending = Promise.withResolvers<undefined>(); barrier = pending.promise; const h = mount();
  try {
    await until(() => requests.length === 2);
    if (kind === 'refresh') { config = {}; h.client.setQueryData(['config'], config); }
    if (kind === 'token') { held = true; await tokenStore.setToken('different-owner'); }
    if (kind === 'unmount') h.unmount();
    pending.resolve(undefined); await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.host.textContent).not.toContain('old-private-fixture');
  } finally { pending.resolve(undefined); h.unmount(); }
});

test('settings classification never descends into malformed declared secret objects', async () => {
  await tokenStore.setToken('fixture-owner');
  config = { surfaces: { slack: { botToken: { PRIVATE_CHILD_FIXTURE: 'PRIVATE_VALUE_FIXTURE' } } }, custom: { ordinaryLabel: 'ordinary' } };
  const h = mount(); try {
    await until(() => requests.length === 2);
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_CHILD'); expect(JSON.stringify(requests)).not.toContain('PRIVATE_VALUE');
  } finally { h.unmount(); }
});
