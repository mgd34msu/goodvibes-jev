/** Actual production source membership and runtime permission owner; only remote transport data is synthetic. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { nodeEmailTransport } from '@goodvibes-jev/engine/sdk/platform/email/node';
import { SnapshotSocket } from '../helpers/email-snapshot-socket.js';
import { Client } from 'undici/index.js';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { createSlackInboxOwner, type OwnedInboxTagging, type InboxListOutput, type InboxPollingControl } from '@goodvibes-jev/engine/sdk/platform/intake';
import type { ProtectedSourceOwnerOptions } from '@goodvibes-jev/engine/sdk/platform/security';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { SecretsManager } from '../../config/secrets.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { gateReadingsPort } from '../helpers/synthetic-gate-readings.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function keep<T extends { mockRestore(): void }>(spy: T): T { cleanups.push(() => spy.mockRestore()); return spy; }
async function fixture(provider: 'slack' | 'email' = 'slack', tagging = true) {
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined));
  keep(spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined));
  const root = makeOwnedTempDir('tagged-production-runtime'), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const stored = new SecretsManager({ projectRoot: workspace, globalHome: home });
  await stored.set(provider === 'slack' ? 'GOODVIBES_SURFACES_SLACK_BOT_TOKEN' : 'GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD', provider === 'slack' ? 'xoxb-synthetic-one' : 'synthetic-mail-secret');
  const mailSockets: SnapshotSocket[] = [];
  if (provider === 'email') keep(spyOn(nodeEmailTransport, 'connectImapTls').mockImplementation(async (host, port) => {
    expect(host).toBe('mail.synthetic.invalid'); expect(port).toBe(993);
    const socket = new SnapshotSocket({ validity: 7, uids: [42] }); mailSockets.push(socket); setImmediate(() => socket.greet()); return socket as unknown as Socket;
  }));
  const identity = { workspaceId: 'T123', userId: 'U123' }; let actualIdentity = { ...identity };
  const ts = `${Math.floor((Date.now() - 20_000) / 1_000)}.000000`;
  const providerCalls: string[] = [], screeningCalls: string[] = [];
  const slack = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url); providerCalls.push(url.pathname);
    if (url.pathname === '/api/auth.test') return Response.json({ ok: true, team_id: actualIdentity.workspaceId, user_id: actualIdentity.userId });
    if (url.pathname === '/api/conversations.list') return Response.json({ ok: true, channels: [{ id: 'D123', user: 'U456' }] });
    if (url.pathname === '/api/conversations.history') return Response.json({ ok: true, messages: [{ ts, user: 'U456', text: 'Synthetic protected build update' }] });
    return new Response(null, { status: 404 });
  } });
  const screening = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; screeningCalls.push(path);
    if (path === '/v1/chat/completions') {
      const body = await request.json() as { messages: Array<{ content: string }> };
      const source = JSON.parse(body.messages[1]!.content) as { revision: string };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(async () => { await slack.stop(true); await screening.stop(true); });
  const authority: ProtectedSourceOwnerOptions = { authority: { ownerId: 'synthetic-loopback-screening', revision: 'one', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} }, proposal: { endpoint: `http://127.0.0.1:${screening.port}`, model: 'synthetic-proposer' }, judgment: { endpoint: `http://127.0.0.1:${screening.port}`, model: 'jev-1.13.0' } };
  let handle!: OwnedInboxTagging;
  const activation = { onReady(owner: OwnedInboxTagging) { handle = owner; } };
  const production = createProductionDaemonInboxFactory(provider === 'slack' ? { slack: { account: identity, screening: authority, ...(tagging ? { triageTagging: activation } : {}) } }
    : { email: { account: { host: 'mail.synthetic.invalid', port: 993, username: 'owner@synthetic.invalid', mailbox: 'INBOX', security: 'tls' }, screening: authority, ...(tagging ? { triageTagging: activation } : {}) } }, {
    slack: { createOwner(context, options) { return createSlackInboxOwner(context, options, { createHttpClient(origin, clientOptions) {
      expect(origin).toBe('https://slack.com'); return new Client(`http://127.0.0.1:${slack.port}`, clientOptions);
    } }); } },
  });
  let polling!: InboxPollingControl;
  const daemon = await startDaemonFixture({ root, hostSessions: false, inboxFactory(context, routing, controls) {
    return production(context, routing, { ...controls, gatePolling(id, control) { polling = control; return controls.gatePolling(id, control); } });
  }, configure(config) {
    if (provider === 'slack') { config.set('surfaces.slack.enabled', true); config.set('surfaces.slack.workspaceId', identity.workspaceId); }
    else { config.set('surfaces.email.host', 'mail.synthetic.invalid'); config.set('surfaces.email.user', 'owner@synthetic.invalid'); }
    config.set('judgment.keySource', 'secret');
  } });
  cleanups.push(() => daemon.stop());
  let hook: (() => void | Promise<void>) | undefined, outcome = 'act';
  const readings: unknown[] = [];
  const semantic = fakePort((_name, question) => choiceAnswer(question, _name === 'meaning' ? 'normal' : outcome, 0.99)), gate = gateReadingsPort();
  const recorded = withDecisionLog({ model: gate.port.model, async ask(request) {
    readings.push(request.state); request.beforeAttempt?.(); await hook?.(); request.beforeAttempt?.();
    return 'meaning' in request.questions || 'disposition' in request.questions || 'refuse' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, daemon.services.judgment.decisionLog);
  keep(spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request)));
  const admissions = keep(spyOn(daemon.services.permissionManager, 'admitAutonomous'));
  const humans = keep(spyOn(daemon.services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('No human fallback'); }));
  const writes: RequestInit[] = [];
  const fetchOriginal = globalThis.fetch;
  keep(spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = String(url);
    if (target === 'https://slack.com/api/reactions.add') { writes.push(init!); return Response.json({ ok: true }); }
    if (new URL(target).hostname !== '127.0.0.1') throw new Error('Unexpected external fixture request');
    return fetchOriginal(url, init);
  }, { preconnect: fetchOriginal.preconnect })));
  const operation = { sourceOf: () => ({ goal: 'Apply the priority triage label to this selected Slack message', criteria: ['Only mutate the selected message'] }), assertCurrent() {} };
  return { daemon, handle, writes, readings, admissions, humans, operation, providerCalls, screeningCalls, mailSockets,
    async poll() { await polling.stop(); await polling.start(); },
    setHook(value: typeof hook) { hook = value; }, reject() { outcome = 'reject'; }, reassign() { actualIdentity = { workspaceId: 'T999', userId: 'U999' }; },
    async inbox() { const response = await daemon.fetch('/api/channels/inbox'); expect(response.status).toBe(200); return await response.json() as InboxListOutput; },
  };
}
test('production configured Slack uses real screened mirror and root recorded PermissionManager, not a duplicate host', async () => {
  const f = await fixture(); const inbox = await f.inbox();
  expect(inbox.items).toHaveLength(1); expect(inbox.items[0]!.bodyPreview).toBe('Synthetic protected build update');
  expect(inbox.providers.map(provider => provider.provider).sort()).toEqual(['discord', 'email', 'slack']);
  expect((await f.daemon.fetchAnonymous('/api/channels/inbox')).status).toBe(401);
  expect(f.admissions).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0); expect(f.screeningCalls.length).toBeGreaterThan(0);
  await f.handle.applyTags(inbox.items[0]!.id, ['GoodVibes/Priority'], f.operation);
  expect(f.admissions).toHaveBeenCalledTimes(1); expect(f.humans).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1);
  expect(JSON.parse(String(f.writes[0]!.body))).toMatchObject({ channel: 'D123', name: 'rotating_light' });
  expect(JSON.stringify(f.readings)).not.toContain('xoxb-synthetic-one'); expect(JSON.stringify(f.readings)).not.toContain('Synthetic protected build update');
});
test('production rotated Slack credential must reauthenticate the same account before tagging', async () => {
  const f = await fixture(); const row = (await f.inbox()).items[0]!; f.reassign();
  await f.daemon.services.secretsManager.set('GOODVIBES_SURFACES_SLACK_BOT_TOKEN', 'xoxb-synthetic-other');
  await expect(f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow();
  expect(f.writes).toHaveLength(0); expect(f.admissions).not.toHaveBeenCalled(); expect(f.providerCalls.filter(path => path === '/api/auth.test').length).toBeGreaterThan(1);
});
test('production tag handle rejects after root close without any late provider write', async () => {
  const f = await fixture(); const row = (await f.inbox()).items[0]!; await f.daemon.stop();
  let failed = false; try { await f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation); } catch { failed = true; }
  expect(failed).toBe(true); expect(f.writes).toHaveLength(0);
});

test('production email uses the canonical root mail service and UID mirror before explicit admitted tagging', async () => {
  const f = await fixture('email'); await f.poll(); const inbox = await f.inbox();
  expect(inbox.items).toHaveLength(1); expect(inbox.items[0]!.id).toMatch(/^email:[a-f0-9]+:0000000007:0000000042$/);
  expect(inbox.items[0]!.bodyPreview).toBe('Synthetic body'); expect(f.mailSockets.length).toBeGreaterThan(0);
  f.reject();
  await expect(f.handle.applyTags(inbox.items[0]!.id, ['GoodVibes/Priority'], {
    ...f.operation, sourceOf: () => ({ goal: 'Apply priority to the selected email', criteria: ['Only that UID in its current mailbox generation'] }),
  })).rejects.toThrow();
  expect(f.admissions).toHaveBeenCalledTimes(1); expect(f.humans).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
  expect(JSON.stringify(f.readings)).not.toContain('synthetic-mail-secret');
  expect(f.mailSockets.every(socket => socket.commands.every(command => !command.includes('UID STORE')))).toBe(true);
});


test.each(['slack', 'email'] as const)('production %s read composition without tagging activation exposes no mutation capability', async provider => {
  const f = await fixture(provider, false);
  if (provider === 'email') await f.poll();
  const inbox = await f.inbox();
  expect(inbox.items).toHaveLength(1);
  expect(f.handle).toBeUndefined();
  expect(f.admissions).not.toHaveBeenCalled(); expect(f.humans).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
});


test('actual production Slack interprets a custom negative-spam label before exact recorded mutation admission', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!;
  await f.handle.applyTags(row.id, ['Not spam'], { ...f.operation,
    sourceOf: () => ({ goal: 'Apply my Not spam label to the selected Slack item', criteria: ['Only this current provider item'] }),
  });
  expect(f.admissions).toHaveBeenCalledTimes(1); expect(f.humans).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1);
  expect(JSON.parse(String(f.writes[0]!.body))).toEqual({ channel: 'D123', timestamp: row.id.split(':')[2], name: 'inbox_tray' });
  expect(f.daemon.services.judgment.decisionLog.query({ battery: 'engine.intake.triage-tag-meaning' })).toHaveLength(1);
  expect(JSON.stringify(f.readings)).not.toContain('Synthetic protected build update');
});
