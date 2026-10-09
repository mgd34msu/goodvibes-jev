import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerComposedCheckinGatewayMethods } from '../sdk/src/platform/control-plane/routes/checkin-composition.js';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import { createDisposalScope } from '../sdk/src/platform/runtime/disposal.js';
import type { GatewayVerbGroupDeps } from '../sdk/src/platform/control-plane/routes/register-gateway-verb-groups.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
let previous: JudgmentPort | undefined;
let root: string;
let log: SqliteDecisionLog;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'checkin-composed-')); previous = installJudgmentPort(undefined); log = new SqliteDecisionLog(':memory:'); });
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); rmSync(root, { recursive: true, force: true }); });
function compose(contact = 0.99, content?: () => Promise<{ content: string }>) {
  const fake = fakePort((name, question) => name === 'contact' ? noulAnswer(contact) : choiceAnswer(question, 'supports', 0.99));
  installJudgmentPort(withDecisionLog(fake.port, log));
  const configManager = new ConfigManager({ configDir: root });
  const sent: string[] = [];
  const channelDeliveryRouter = new ChannelDeliveryRouter({ strategies: [{ id: 'synthetic', supportsGuardedDelivery: true,
    canHandle: () => true, async deliver(request) { request.assertCurrent?.(); request.signal?.throwIfAborted(); sent.push(request.body); return { responseId: 'synthetic-send' }; } }] });
  const providerRegistry = { getCurrentModel: () => ({ id: 'synthetic', registryKey: 'synthetic', provider: 'synthetic' }),
    getForModel: () => ({ chat: content ?? (async () => ({ content: 'The release needs your deployment-window choice.' })) }) } as unknown as ProviderRegistry;
  const automationManager = { listJobs: () => [], listRuns: () => [], attachCheckinEvaluator: () => {},
    createJob: async () => ({ id: 'synthetic-job' }), updateJob: async () => {}, setEnabled: async () => {}, runNow: async () => {} } as unknown as NonNullable<GatewayVerbGroupDeps['automationManager']>;
  const scope = createDisposalScope('synthetic-checkin');
  const catalog = new GatewayMethodCatalog();
  registerComposedCheckinGatewayMethods(catalog, { configManager, channelDeliveryRouter, providerRegistry, automationManager,
    sessionLister: { listSessions: () => [{ status: 'open', title: 'Release deployment window', pendingInputCount: 1, surfaceKinds: ['web'] }] },
    surfaceRoot: 'synthetic', shellPaths: { resolveUserPath: (...parts: string[]) => join(root, ...parts) } as GatewayVerbGroupDeps['shellPaths'], disposal: scope.registry });
  return { catalog, configManager, sent, scope, fake };
}
async function enable(catalog: GatewayMethodCatalog) {
  await catalog.invoke('checkin.config.set', { body: { enabled: true, deliveryChannel: 'synthetic:owner' }, context: {} });
}
test('actual runtime composition is off by default and routes typed no without sending', async () => {
  const h = compose(0.01);
  try {
    expect(await h.catalog.invoke('checkin.run', { context: {} })).toMatchObject({ outcome: 'skipped' });
    expect(h.fake.requests).toHaveLength(0);
    await enable(h.catalog);
    expect(await h.catalog.invoke('checkin.run', { context: {} })).toMatchObject({ outcome: 'quiet' });
    expect(h.sent).toEqual([]);
  } finally { h.scope.dispose(); }
});
test('actual composed yes and fidelity route reaches the synthetic accepted-send boundary', async () => {
  const h = compose();
  try {
    await enable(h.catalog);
    expect(await h.catalog.invoke('checkin.run', { context: {} })).toMatchObject({ outcome: 'delivered', deliveryId: 'synthetic-send' });
    expect(h.sent).toEqual(['The release needs your deployment-window choice.']);
    const result = await h.catalog.invoke('checkin.receipts.list', { context: {} }) as { receipts: { judgment?: { decisionId: string; note?: { decisionId: string } } }[] };
    expect(result.receipts[0]!.judgment?.note?.decisionId).toBeTruthy();
  } finally { h.scope.dispose(); }
});
test('real ConfigManager invalidation revokes content awaiting in the composed route', async () => {
  const entered = Promise.withResolvers<void>(); const held = Promise.withResolvers<{ content: string }>();
  const h = compose(0.99, async () => { entered.resolve(); return held.promise; });
  try {
    await enable(h.catalog); const work = h.catalog.invoke('checkin.run', { context: {} }); await entered.promise;
    await h.catalog.invoke('checkin.config.set', { body: { enabled: false }, context: {} });
    held.resolve({ content: 'The release needs your deployment-window choice.' });
    expect(await work).toMatchObject({ outcome: 'skipped' }); expect(h.sent).toEqual([]);
  } finally { h.scope.dispose(); }
});

test('live invocation scope revocation after drafting cannot reach synthetic send', async () => {
  const entered = Promise.withResolvers<void>(); const held = Promise.withResolvers<{ content: string }>();
  const h = compose(0.99, async () => { entered.resolve(); return held.promise; });
  let authorized = true;
  try {
    await enable(h.catalog);
    const work = h.catalog.invoke('checkin.run', { context: {}, isAuthorized: () => authorized });
    await entered.promise; authorized = false; held.resolve({ content: 'The release needs your deployment-window choice.' });
    expect(await work).toMatchObject({ outcome: 'error' }); expect(h.sent).toEqual([]);
  } finally { h.scope.dispose(); }
});
test('merged prepared-setting mutation invalidates a pending check-in before the committed change', async () => {
  const entered = Promise.withResolvers<void>(); const held = Promise.withResolvers<{ content: string }>();
  const h = compose(0.99, async () => { entered.resolve(); return held.promise; });
  try {
    await enable(h.catalog);
    const work = h.catalog.invoke('checkin.run', { context: {} }); await entered.promise;
    const mutation = h.configManager.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'openai:synthetic-other' });
    const transition = h.configManager.beginPreparedMutation(mutation);
    expect(h.configManager.finishPreparedMutation(mutation, transition).status).toBe('committed');
    held.resolve({ content: 'The release needs your deployment-window choice.' });
    expect(await work).toMatchObject({ outcome: 'skipped' }); expect(h.sent).toEqual([]);
  } finally { h.scope.dispose(); }
});
