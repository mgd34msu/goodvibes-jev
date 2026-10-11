/** Deterministic qualification of actual callers; not live Jev calibration. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { gateSurfaceSpawn, resolveOriginBinding, type ConversationGateDeps } from '../sdk/src/platform/daemon/surface-conversation-gate.js';
import { tryResolveWorkProposalReplyFromChannel } from '../sdk/src/platform/daemon/work-proposal-reply.js';
import { WorkProposalStore } from '../sdk/src/platform/agents/work-proposal-store.js';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.js';
import type { ChannelPolicyDecision } from '../sdk/src/platform/channels/index.js';
import type { ChannelIngressPolicyInput } from '../sdk/src/platform/channels/index.js';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let answer: string; let confidence: number; let calls: unknown[];
let pause: (() => Promise<void>) | undefined;
beforeEach(() => {
  answer = 'conversation'; confidence = 0.99; calls = []; pause = undefined;
  const fake = fakePort((_name, question) => choiceAnswer(question, answer, confidence));
  const port: JudgmentPort = { model: fake.port.model, async ask(request) {
    request.beforeAttempt?.(); calls.push(request.state); await pause?.(); request.beforeAttempt?.(); return fake.port.ask(request);
  } };
  log = new SqliteDecisionLog(':memory:');
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });
function harness() {
  const store = new WorkProposalStore(); const spawns: unknown[] = [];
  const deps: ConversationGateDeps = {
    configManager: { get: () => undefined }, routeBindings: { getBinding: () => undefined, resolve: () => undefined },
    sessionBroker: { getSession: () => null, bindAgent: async () => null },
    trySpawnAgent: input => { spawns.push(input); return Response.json({ spawned: true }); },
    queueSurfaceReplyFromBinding: () => {}, workProposals: store,
    deliverSurfaceNotice: async () => ({ delivered: true }),
  };
  const input: ChannelIngressPolicyInput = { surface: 'ntfy', userId: 'owner', channelId: 'channel', text: 'Yes, actually no. Leave it alone.' };
  const proposal = () => { const p = store.create({ surfaceKind: 'ntfy', userId: 'owner', channelId: 'channel', task: 'Fix login', summary: 'Fix login', ttlMs: 60_000 }); return store.markDelivered(p.id)!; };
  const replyDeps = { proposals: store, startAgreedWork: async (...args: unknown[]) => { spawns.push(args); }, replyOnChannel: async () => {} };
  return { store, spawns, deps, input, proposal, replyDeps };
}
describe('canonical inbound work reading at actual spawn boundary', () => {
  for (const kind of ['work', 'conversation']) test(`${kind} follows reading despite contrary lexical text`, async () => {
    const h = harness(); answer = kind;
    try {
      const text = kind === 'work' ? 'Testing' : 'fix deploy src/main.ts';
      const response = await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text }, { mode: 'spawn', task: text });
      expect(h.spawns).toHaveLength(kind === 'work' ? 0 : 1);
      expect(calls).toEqual([{ proposal: null, reply: text }]);
      if (kind === 'work') expect(await (response as Response).json()).toMatchObject({ outcome: 'work-proposed' });
    } finally { h.store.dispose(); }
  });
  test('unsettled reading holds without spawning or proposing', async () => {
    const h = harness(); confidence = 0.5;
    try { expect(await (await gateSurfaceSpawn(h.deps, { surface: 'ntfy', text: 'hello' }, { mode: 'spawn', task: 'hello' }) as Response).json()).toMatchObject({ outcome: 'work-intent-unsettled' }); expect(h.spawns).toEqual([]); expect(h.store.listPending()).toEqual([]); }
    finally { h.store.dispose(); }
  });
  for (const failure of ['unavailable', 'invalid', 'canceled', 'changed', 'private']) test(`${failure} never falls back to word rules`, async () => {
    const h = harness(); const origin = { surface: 'ntfy', text: 'fix login' }; const abort = new AbortController();
    if (failure === 'unavailable') pause = async () => { throw new Error('synthetic outage'); };
    if (failure === 'invalid') answer = 'invented';
    if (failure === 'canceled') pause = async () => { abort.abort(); };
    if (failure === 'changed') pause = async () => { origin.text = 'replacement'; };
    if (failure === 'private') origin.text = 'Authorization: Bearer synthetic-secret';
    try { await expect(gateSurfaceSpawn({ ...h.deps, readingOptions: { signal: abort.signal } }, origin, { mode: 'spawn', task: 'fix login' })).rejects.toBeDefined(); expect(h.spawns).toEqual([]); expect(h.store.listPending()).toEqual([]); if (failure === 'private') expect(calls).toEqual([]); if (failure === 'stale' || failure === 'changed' || failure === 'canceled') expect(log.query({})).toEqual([]); }
    finally { h.store.dispose(); }
  });
});
describe('exact pending proposal is bound before reading', () => {
  for (const kind of ['approve', 'steer', 'reject', 'message']) test(`${kind} is the typed meaning, never its leading word`, async () => {
    const h = harness(); h.proposal(); answer = kind;
    try {
      const result = await tryResolveWorkProposalReplyFromChannel(h.input, h.replyDeps);
      expect(result).toEqual(kind === 'message' ? { consumed: false } : { consumed: true, action: kind === 'reject' ? 'declined' : 'accepted' });
      expect(h.spawns).toHaveLength(kind === 'approve' || kind === 'steer' ? 1 : 0);
      expect(calls).toEqual([{ proposal: { task: 'Fix login', summary: 'Fix login' }, reply: h.input.text }]);
      if (kind === 'steer') expect((h.spawns[0] as unknown[])[1]).toBe(h.input.text);
    } finally { h.store.dispose(); }
  });
  for (const mismatch of ['none', 'owner', 'channel', 'thread', 'ambiguous']) test(`${mismatch} does not even transmit a reply`, async () => {
    const h = harness(); answer = 'approve';
    if (mismatch !== 'none') h.proposal();
    if (mismatch === 'ambiguous') h.proposal();
    const input = { ...h.input, ...(mismatch === 'owner' ? { userId: 'other' } : mismatch === 'channel' ? { channelId: 'other' } : mismatch === 'thread' ? { threadId: 'other' } : {}) };
    try { expect(await tryResolveWorkProposalReplyFromChannel(input, h.replyDeps)).toEqual({ consumed: false }); expect(calls).toEqual([]); expect(h.spawns).toEqual([]); }
    finally { h.store.dispose(); }
  });
  test('unsettled answer consumes and holds, preventing another spawn path', async () => {
    const h = harness(); h.proposal(); answer = 'approve'; confidence = 0.5;
    try { expect(await tryResolveWorkProposalReplyFromChannel(h.input, h.replyDeps)).toEqual({ consumed: true, action: 'unsettled' }); expect(h.spawns).toEqual([]); expect(h.store.listPending()).toHaveLength(1); } finally { h.store.dispose(); }
  });
  for (const failure of ['unavailable', 'canceled', 'stale', 'private', 'invalid']) test(`${failure} keeps old work unstarted`, async () => {
    const h = harness(); const p = h.proposal(); answer = 'approve'; const abort = new AbortController();
    if (failure === 'unavailable') pause = async () => { throw new Error('synthetic outage'); };
    if (failure === 'canceled') pause = async () => { abort.abort(); };
    if (failure === 'stale') pause = async () => { h.store.resolve(p.id, 'declined'); };
    if (failure === 'invalid') answer = 'invented';
    const input = failure === 'private' ? { ...h.input, text: 'Authorization: Bearer synthetic-secret' } : h.input;
    try { await expect(tryResolveWorkProposalReplyFromChannel(input, { ...h.replyDeps, readingOptions: { signal: abort.signal } })).rejects.toBeDefined(); expect(h.spawns).toEqual([]); if (failure === 'private') expect(calls).toEqual([]); if (failure === 'stale' || failure === 'changed' || failure === 'canceled') expect(log.query({})).toEqual([]); }
    finally { h.store.dispose(); }
  });
});

// ID routing is deterministic; these tests deliberately have an unrelated pending ask.
for (const surface of ['slack', 'discord'] as const) test(`${surface} machine button never enters work reply semantics`, async () => {
  const h = harness();
  const p = h.store.create({ surfaceKind: surface, userId: 'owner', channelId: 'channel', task: 'Fix login', summary: 'Fix login', ttlMs: 60_000 });
  h.store.markDelivered(p.id); answer = 'approve';
  try {
    expect(await tryResolveWorkProposalReplyFromChannel({ ...h.input, surface, text: 'gv:approval:approve:ask-1', metadata: { interactive: true } }, h.replyDeps)).toEqual({ consumed: false });
    expect(calls).toEqual([]); expect(h.spawns).toEqual([]); expect(h.store.listPending()).toHaveLength(1);
  } finally { h.store.dispose(); }
});
test('same ID and content cannot replace the pending proposal incarnation', async () => {
  const h = harness(); let target = h.proposal(); answer = 'approve';
  pause = async () => { target = { ...target }; };
  try {
    await expect(tryResolveWorkProposalReplyFromChannel(h.input, { ...h.replyDeps, proposals: { listPending: () => [target], resolve: h.store.resolve.bind(h.store) } })).rejects.toThrow('the judgment request was rejected');
    expect(h.spawns).toEqual([]);
  } finally { h.store.dispose(); }
});
test('expiry during reading invalidates the answer before start', async () => {
  let now = 1; const h = harness(); h.store.dispose(); const store = new WorkProposalStore({ now: () => now });
  const p = store.create({ surfaceKind: 'ntfy', userId: 'owner', channelId: 'channel', task: 'Fix login', summary: 'Fix login', ttlMs: 100 }); store.markDelivered(p.id);
  answer = 'approve'; pause = async () => { now = 102; };
  try { await expect(tryResolveWorkProposalReplyFromChannel(h.input, { ...h.replyDeps, proposals: store })).rejects.toThrow('the judgment request was rejected'); expect(h.spawns).toEqual([]); }
  finally { store.dispose(); }
});
test('userless non-topic surfaces cannot claim work', async () => {
  const h = harness(); const p = h.store.create({ surfaceKind: 'slack', channelId: 'channel', task: 'Fix login', summary: 'Fix login', ttlMs: 100 }); h.store.markDelivered(p.id);
  try { expect(await tryResolveWorkProposalReplyFromChannel({ surface: 'slack', channelId: 'channel', text: 'yes' }, h.replyDeps)).toEqual({ consumed: false }); expect(calls).toEqual([]); }
  finally { h.store.dispose(); }
});


test('delivery selects the exact channel and thread among same-surface session routes', () => {
  const routes = [
    { id: 'a', surfaceKind: 'slack', channelId: 'other', threadId: 'thread' },
    { id: 'b', surfaceKind: 'slack', channelId: 'channel', threadId: 'thread' },
  ];
  const deps = { routeBindings: { getBinding: (id: string) => routes.find(route => route.id === id), resolve: () => routes[0] }, sessionBroker: { getSession: () => ({ routeIds: ['a', 'b'] }) } } as unknown as Pick<ConversationGateDeps, 'routeBindings' | 'sessionBroker'>;
  expect(resolveOriginBinding(deps, { surface: 'slack', channelId: 'channel', threadId: 'thread' }, 'session')?.id).toBe('b');
  expect(resolveOriginBinding(deps, { surface: 'slack', channelId: 'channel', threadId: 'different' }, 'session')).toBeUndefined();
});


for (const change of ['policy', 'supersession', 'shutdown']) test(`actual adapter source ${change} cannot return a late spawn or retained reading`, async () => {
  const h = harness(); let policy = { surface: 'ntfy', allowlistUserIds: ['owner'], enabled: true };
  const helper = new DaemonSurfaceActionHelper({ ...h.deps, channelPolicy: { getPolicy: () => policy, listPolicies: () => [policy] } } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  helper.authorizeSurfaceIngress = async () => ({ allowed: true, reason: 'authorized', policy } as unknown as ChannelPolicyDecision);
  const context = helper.buildSurfaceAdapterContext();
  await context.authorizeSurfaceIngress({ ...h.input, surface: 'ntfy' }); answer = 'conversation';
  pause = async () => {
    if (change === 'policy') policy = { ...policy, enabled: false };
    else if (change === 'shutdown') { helper.closeDelegatedTelegram(); helper.startDelegatedTelegram(); }
    else await context.authorizeSurfaceIngress({ ...h.input, surface: 'ntfy', text: 'replacement' });
  };
  try { await expect(context.trySpawnAgent({ mode: 'spawn', task: 'Fix login' }, 'test')).rejects.toBeDefined(); expect(h.spawns).toEqual([]); expect(log.query({})).toEqual([]); }
  finally { h.store.dispose(); }
});

for (const change of ['policy', 'abort', 'expiry']) test(`delivery ${change} cannot leave an answerable proposal or report transfer success`, async () => {
  const h = harness(); let now = 1; let authorized = true; const abort = new AbortController();
  const store = new WorkProposalStore({ now: () => now }); answer = 'work';
  const deps: ConversationGateDeps = { ...h.deps, workProposals: store,
    readingOptions: { signal: abort.signal, beforeAttempt: () => { if (!authorized) throw new Error('Source revoked'); } },
    deliverSurfaceNotice: async () => { await Promise.resolve(); if (change === 'policy') authorized = false; else if (change === 'abort') abort.abort(); else now += 60 * 60_000; return { delivered: true }; },
  };
  try {
    const work = gateSurfaceSpawn(deps, { surface: 'ntfy', channelId: 'topic', text: 'Fix login' }, { mode: 'spawn', task: 'Fix login' });
    if (change === 'expiry') expect(await (await work as Response).json()).toMatchObject({ outcome: 'work-proposal-expired' });
    else await expect(work).rejects.toBeDefined();
    expect(store.listPending()).toEqual([]); expect(h.spawns).toEqual([]);
  } finally { h.store.dispose(); store.dispose(); }
});
