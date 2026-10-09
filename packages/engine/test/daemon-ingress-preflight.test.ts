import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ChannelPolicyManager } from '../sdk/src/platform/channels/policy-manager.ts';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.ts';
import { logger } from '../sdk/src/platform/utils/logger.ts';
import type { ChannelIngressPolicyInput, ChannelPolicyRecord } from '../sdk/src/platform/channels/types.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let readings: ReturnType<typeof fakePort>;
let onRead: (() => Promise<void>) | undefined;
const fixtures: { manager: ChannelPolicyManager; dir: string }[] = [];
beforeEach(() => {
  onRead = undefined; readings = fakePort(() => noulAnswer(0.01));
  previous = installJudgmentPort({ model: readings.port.model, async ask(request) { await onRead?.(); return readings.port.ask(request); } });
});
afterEach(async () => {
  installJudgmentPort(previous);
  for (const fixture of fixtures.splice(0)) { await fixture.manager.stop(); rmSync(fixture.dir, { recursive: true, force: true }); }
});
async function fixture(patch: Partial<ChannelPolicyRecord> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-source-preflight-'));
  const manager = new ChannelPolicyManager({ storePath: join(dir, 'policy.json') });
  fixtures.push({ manager, dir });
  await manager.upsertPolicy('homeassistant', { allowlistUserIds: ['owner'], ...patch });
  const helper = new DaemonSurfaceActionHelper({ channelPolicy: manager,
    configManager: { get: () => undefined, getCategory: () => undefined },
    routeBindings: { getBinding: () => undefined, resolve: () => undefined },
    sessionBroker: { getSession: () => null },
    deliverSurfaceNotice: async () => ({ delivered: true }),
  } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  return { manager, helper, dir };
}
const input = (patch: Partial<ChannelIngressPolicyInput> = {}): ChannelIngressPolicyInput => ({
  surface: 'homeassistant', userId: 'owner', conversationKind: 'direct', mentioned: true,
  text: 'Meet the synthetic visitor in room 872', metadata: { rawBody: 'private inbound body' }, ...patch,
});

for (const [patch, source, reason] of [
  [{ enabled: false }, {}, 'surface-disabled'],
  [{ allowlistUserIds: ['another-owner'] }, {}, 'user-not-allowlisted'],
  [{ allowlistUserIds: ['owner'] }, { userId: undefined }, 'missing-user-identity'],
  [{ dmPolicy: 'deny' }, {}, 'direct-messages-disabled'],
  [{ allowlistChannelIds: ['channel-a'] }, { channelId: 'channel-b' }, 'channel-not-allowlisted'],
] as const) test(`denied ${reason} does not judge or retain raw source text, but preserves denial bookkeeping`, async () => {
  const h = await fixture(patch as Partial<ChannelPolicyRecord>);
  const text = 'PRIVATE-SOURCE-TEXT for room 872'; const logs: string[] = []; const original = logger.info;
  logger.info = (message, fields) => { logs.push(JSON.stringify([message, fields])); };
  try {
    const decision = await h.helper.authorizeSurfaceIngress(input({ ...source, text, metadata: { text } }));
    expect(decision).toMatchObject({ allowed: false, reason }); expect(readings.requests).toEqual([]);
    expect(h.manager.listAudit()).toHaveLength(1);
    expect(h.manager.listAudit()[0]).toMatchObject({ allowed: false, reason, surface: 'homeassistant', metadata: {} });
    expect(h.manager.listAudit()[0]!.text).toBeUndefined();
    await h.manager.stop();
    expect(readFileSync(join(h.dir, 'policy.json'), 'utf8')).not.toContain('PRIVATE-SOURCE-TEXT');
    expect(logs.join('\n')).not.toContain('PRIVATE-SOURCE-TEXT');
  } finally { logger.info = original; }
});

test('pure preflight does not audit or seed an unpaired surface; admitted ingress preserves normal pairing', async () => {
  const h = await fixture({ allowlistUserIds: [] }); const source = input({ text: 'Hello there' });
  expect(await h.manager.preflightIngress(source)).toMatchObject({ allowed: true, reason: 'allowed' });
  expect(h.manager.getPolicy('homeassistant').allowlistUserIds).toEqual([]); expect(h.manager.listAudit()).toEqual([]);
  expect(await h.helper.authorizeSurfaceIngress(source)).toMatchObject({ allowed: true, reason: 'owner-allowlist-seeded' });
  expect(h.manager.getPolicy('homeassistant').allowlistUserIds).toEqual(['owner']);
  expect(h.manager.listAudit()[0]).toMatchObject({ text: 'Hello there', allowed: true, reason: 'owner-allowlist-seeded' });
});

test('an unpaired but denied surface never seeds an owner during denial bookkeeping', async () => {
  const h = await fixture({ allowlistUserIds: [], enabled: false });
  expect(await h.helper.authorizeSurfaceIngress(input())).toMatchObject({ allowed: false, reason: 'surface-disabled' });
  expect(h.manager.getPolicy('homeassistant').allowlistUserIds).toEqual([]); expect(readings.requests).toEqual([]);
});

test('allowed source retains original card-talk and safe text audit behavior', async () => {
  const h = await fixture();
  expect(await h.helper.authorizeSurfaceIngress(input())).toMatchObject({ allowed: true });
  expect(readings.requests).toHaveLength(1);
  expect(readings.requests[0]!.context?.battery).toBe('engine.security.card-talk');
  expect(h.manager.listAudit()[0]).toMatchObject({ allowed: true, text: input().text, metadata: input().metadata });
});

test('current policy is re-evaluated after semantic screening and a revoked source cannot retain its text', async () => {
  const h = await fixture(); onRead = async () => { await h.manager.upsertPolicy('homeassistant', { allowlistUserIds: ['replacement-owner'] }); };
  expect(await h.helper.authorizeSurfaceIngress(input())).toMatchObject({ allowed: false, reason: 'user-not-allowlisted' });
  expect(readings.requests).toHaveLength(1);
  expect(h.manager.listAudit()[0]).toMatchObject({ allowed: false, metadata: {} });
  expect(h.manager.listAudit()[0]!.text).toBeUndefined();
});

test('group-scoped rule matching is identical in preflight and normal evaluation', async () => {
  const h = await fixture({ groupPolicies: [{ id: 'group-rule', groupId: 'group-a', allowlistUserIds: ['group-owner'], metadata: {} }] });
  for (const userId of ['owner', 'group-owner']) {
    const source = input({ groupId: 'group-a', conversationKind: 'group', userId });
    const before = await h.manager.preflightIngress(source); const evaluated = await h.manager.evaluateIngress(source);
    expect(before.allowed).toBe(evaluated.allowed); expect(before.reason).toBe(evaluated.reason);
    expect(before.matchedGroupPolicy?.id).toBe('group-rule'); expect(before.matchedScope).toBe('group');
  }
});

test('denial omits credential-shaped identity fields from both audit and unknown-sender logging', async () => {
  const h = await fixture(); const logs: string[] = []; const original = logger.info;
  logger.info = (message, fields) => { logs.push(JSON.stringify([message, fields])); };
  try {
    const decision = await h.helper.authorizeSurfaceIngress(input({ userId: 'Authorization: Bearer synthetic-secret',
      channelId: 'Authorization: Bearer synthetic-channel', groupId: 'safe-group', threadId: 'safe-thread', text: 'safe' }));
    expect(decision).toMatchObject({ allowed: false, reason: 'user-not-allowlisted' }); expect(readings.requests).toEqual([]);
    expect(h.manager.listAudit()[0]).toMatchObject({ reason: 'user-not-allowlisted', groupId: 'safe-group', threadId: 'safe-thread' });
    expect(h.manager.listAudit()[0]!.userId).toBeUndefined(); expect(h.manager.listAudit()[0]!.channelId).toBeUndefined();
    await h.manager.stop(); const retained = readFileSync(join(h.dir, 'policy.json'), 'utf8') + logs.join('\n');
    expect(retained).not.toContain('synthetic-secret'); expect(retained).not.toContain('synthetic-channel');
  } finally { logger.info = original; }
});
