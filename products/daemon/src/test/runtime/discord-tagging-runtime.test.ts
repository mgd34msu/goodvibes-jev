/** Real daemon root, source constructor, local privacy judgment, SQLite and authenticated HTTP. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { gateReadingsPort } from '../helpers/synthetic-gate-readings.js';
import { Client } from 'undici/index.js';
import { createDiscordInboxOwner, type InboxListOutput, type OwnedInboxTagging } from '@goodvibes-jev/engine/sdk/platform/intake';
import { SecretsManager } from '../../config/secrets.js';
import { createProductionDaemonInboxFactory } from '../../runtime/production-inbox-composition.js';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const account = { userId: '100000000000000001' }, channel = '100000000000000002';
async function fixture(messageTime = Date.now() - 2_000, customForum = false) {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  const readBenchmarks = spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined);
  cleanups.push(() => discovery.mockRestore(), () => benchmarks.mockRestore(), () => readBenchmarks.mockRestore());
  const root = makeOwnedTempDir('discord-production'), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const stored = new SecretsManager({ projectRoot: workspace, globalHome: home });
  await stored.set('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'synthetic-discord-token');
  let actualId = account.userId, allowed = true;
  const id = (BigInt(messageTime - 1_420_070_400_000) << 22n).toString();
  const providerCalls: string[] = [], screeningCalls: string[] = [];
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname; providerCalls.push(path);
    if (path === '/api/v10/users/@me') return Response.json({ id: actualId, bot: true });
    if (path === `/api/v10/channels/${channel}`) return allowed ? Response.json({ id: channel, type: 1 }) : new Response(null, { status: 403 });
    if (path === `/api/v10/channels/${channel}/messages`) return Response.json([{ id, channel_id: channel,
      author: { id: '100000000000000003' }, content: 'Contact person@example.test, keep the build notes.' }]);
    return new Response(null, { status: 404 });
  } });
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; screeningCalls.push(path);
    if (path === '/v1/chat/completions') {
      const body = await request.json() as { messages: { content: string }[] };
      const source = JSON.parse(body.messages[1]!.content) as { revision: string };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision,
        spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }] }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } }, usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => local.stop(true), () => remote.stop(true));
  const scope = new AbortController(), privacy = new AbortController(); let handle!: OwnedInboxTagging;
  const production = createProductionDaemonInboxFactory({ discord: { account,
    channels: { channelIds: [channel], revision: 'explicit-dm-v1', signal: scope.signal, assertCurrent() {} },
    screening: { authority: { ownerId: 'synthetic-local-screening', revision: 'v1', retention: 'ephemeral-no-log', signal: privacy.signal, assertCurrent() {} },
      proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
      judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' } },
    triageTagging: { onReady(value) { handle = value; }, ...(customForum ? { forumTagIds: { 'Not spam': '1558282921574400000' } } : {}) },
  } }, { discord: { createOwner(context, options) { return createDiscordInboxOwner(context, options, { createHttpClient(origin, settings) {
    expect(origin).toBe('https://discord.com'); return new Client(`http://127.0.0.1:${remote.port}`, settings);
  } }); } } });
  const daemon = await startDaemonFixture({ root, hostSessions: false, inboxFactory: production,
    configure(config) { config.set('surfaces.discord.enabled', true); config.set('judgment.keySource', 'secret'); },
  });
  cleanups.push(() => daemon.stop());
  let hook: (() => void | Promise<void>) | undefined, outcome = 'act';
  const tagObservations: string[] = [];
  const readings: unknown[] = [], writes: { target: string; init?: RequestInit | undefined }[] = [];
  const semantic = fakePort((_name, question) => choiceAnswer(question, _name === 'meaning' ? 'normal' : outcome, 0.99)), gate = gateReadingsPort();
  const recorded = withDecisionLog({ model: gate.port.model, async ask(request) {
    readings.push(request.state); request.beforeAttempt?.(); await hook?.(); request.beforeAttempt?.();
    return 'meaning' in request.questions || 'disposition' in request.questions || 'refuse' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, daemon.services.judgment.decisionLog);
  const reading = spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request));
  const admission = spyOn(daemon.services.permissionManager, 'admitAutonomous');
  const human = spyOn(daemon.services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('No human fallback'); });
  const originalFetch = globalThis.fetch;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(url);
    if (customForum && target === `https://discord.com/api/v10/channels/${channel}`) { tagObservations.push(target); return Response.json({ id: channel, type: 1 }); }
    if (target.startsWith(`https://discord.com/api/v10/channels/${channel}/messages/`) && target.endsWith('/@me')) {
      expect(init?.method).toBe('PUT'); writes.push({ target, init }); return new Response(null, { status: 204 });
    }
    if (new URL(target).hostname !== '127.0.0.1') throw new Error('Unexpected external fixture transport');
    return originalFetch(url, init);
  }, { preconnect: originalFetch.preconnect }));
  cleanups.push(() => reading.mockRestore(), () => admission.mockRestore(), () => human.mockRestore(), () => transport.mockRestore());
  const operation = { sourceOf: () => ({ goal: 'Apply priority to the selected Discord message', criteria: ['Only mutate the current selected message'] }), assertCurrent() {} };
  return { daemon, workspace, providerCalls, screeningCalls, scope, privacy, handle, writes, readings, admission, human, operation, tagObservations,
    setHook(value: typeof hook) { hook = value; }, reject() { outcome = 'reject'; },
    reassign() { actualId = '100000000000000099'; }, deny() { allowed = false; },
    async inbox() { const response = await daemon.fetch('/api/channels/inbox'); expect(response.status).toBe(200); return await response.json() as InboxListOutput; },
  };
}
// Real Discord snowflakes at these millisecond offsets also satisfy the PAN shape
// detector. Preserve the timestamp calculation and exercise the true product boundary.
test.each([undefined, 1_791_594_000_000, 1_791_594_000_003, 1_791_594_000_079])('explicit Discord tag handle preserves exact protocol target at time %s', async time => {
  const f = await fixture(time), row = (await f.inbox()).items[0]!;
  expect(f.writes).toEqual([]); expect(f.admission).not.toHaveBeenCalled();
  await f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation);
  expect(f.admission).toHaveBeenCalledTimes(1); expect(f.human).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.target).toContain(`/channels/${channel}/messages/${row.id.split(':')[2]}/reactions/`);
  expect(f.writes[0]?.init?.headers).toMatchObject({ Authorization: 'Bot synthetic-discord-token' });
  expect(JSON.stringify(f.readings)).not.toContain(row.id.split(':')[2]!);
  expect(JSON.stringify(f.readings)).not.toContain('person@example.test'); expect(JSON.stringify(f.readings)).not.toContain('synthetic-discord-token');
});
test('Discord canonical rejection produces no provider effect or human fallback', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!; f.reject();
  await expect(f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow();
  expect(f.admission).toHaveBeenCalledTimes(1); expect(f.human).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
});
test('Discord token replacement during admission withdraws the exact prepared credential', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!; let once = false;
  f.setHook(async () => { if (!once) { once = true; await f.daemon.services.secretsManager.set('GOODVIBES_SURFACES_DISCORD_BOT_TOKEN', 'synthetic-discord-other'); } });
  await expect(f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
test('Discord catalog authority cancellation during admission prevents the provider effect', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!; f.setHook(() => f.scope.abort());
  await expect(f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
test('Discord cannot tag a foreign channel row absent from its immutable owned mirror', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!;
  await expect(f.handle.applyTags(row.id.replace(channel, '100000000000000099'), ['GoodVibes/Priority'], f.operation)).rejects.toThrow();
  expect(f.admission).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
});
test('Discord tagged source closes before a stale handle can mutate anything', async () => {
  const f = await fixture(), row = (await f.inbox()).items[0]!; await f.daemon.stop();
  let failed = false; try { await f.handle.applyTags(row.id, ['GoodVibes/Priority'], f.operation); } catch { failed = true; }
  expect(failed).toBe(true); expect(f.writes).toEqual([]);
});


test('actual Discord custom forum configuration reaches the tagger and DM fallback uses recorded meaning', async () => {
  const f = await fixture(undefined, true), row = (await f.inbox()).items[0]!;
  await f.handle.applyTags(row.id, ['Not spam'], { ...f.operation,
    sourceOf: () => ({ goal: 'Apply my Not spam label to this Discord message', criteria: ['Only the selected item'] }),
  });
  expect(f.tagObservations).toEqual([`https://discord.com/api/v10/channels/${channel}`]);
  expect(f.writes).toHaveLength(1); expect(f.writes[0]!.target).toContain(`/reactions/${encodeURIComponent('📥')}/@me`);
  expect(f.admission).toHaveBeenCalledTimes(1); expect(f.human).not.toHaveBeenCalled();
  expect(f.daemon.services.judgment.decisionLog.query({ battery: 'engine.intake.triage-tag-meaning' })).toHaveLength(1);
  expect(JSON.stringify(f.readings)).not.toContain('1558282921574400000');
});
