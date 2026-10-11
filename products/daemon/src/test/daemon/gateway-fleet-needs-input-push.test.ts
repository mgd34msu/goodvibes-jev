import { afterAll, describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { CURRENT_CONTRACT_SCHEMA_VERSION, serializeContract, type Contract } from '@goodvibes-jev/engine/sdk/platform/contract';
import { emptyWorkItemUsage } from '@goodvibes-jev/engine/sdk/platform/orchestration';
import type { ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';
import { wireFleetNeedsInputPush } from '../../runtime/fleet-needs-input-push.ts';
import { RuntimeEventBus } from '../../runtime/index.js';

// Reconstructed actual daemon proof. Synthetic persisted business-input records are
// never activated as contracts. Real registry ticks, product bridge, bus, and encrypted
// push execute. This proves notification projection, not execution/resume authority.
const fixture = useGatewayFixture();

// ---------------------------------------------------------------------------
// A local fake push sink standing in for a browser vendor's push service,
// never the real network. Mirrors the SDK's own web-push-daemon-wire.test.ts.
// ---------------------------------------------------------------------------
interface CapturedPush {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}
const captured: CapturedPush[] = [];
const sink = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });
    captured.push({ path: url.pathname, headers, body });
    return new Response(null, { status: 201 });
  },
});
const sinkOrigin = `http://127.0.0.1:${sink.port}`;

afterAll(() => {
  sink.stop(true);
});

// A stable client (receiver) keypair so the test can decrypt what the daemon sends.
const client = createECDH('prime256v1');
client.generateKeys();
const clientPublic = client.getPublicKey();
const authSecret = randomBytes(16);
const p256dh = clientPublic.toString('base64url');
const auth = authSecret.toString('base64url');

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const okm = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return okm.subarray(0, length);
}

/** Decrypt an aes128gcm web-push body back to its JSON payload (RFC 8291 receiver side). */
function decryptPush(body: Buffer): { title: string; body: string; data?: Record<string, unknown> } {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const sharedSecret = client.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublic, senderPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const payload = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  const json = plaintext.subarray(0, plaintext.length - 1).toString('utf8'); // strip trailing 0x02 record delimiter
  return JSON.parse(json) as { title: string; body: string; data?: Record<string, unknown> };
}

async function waitForPush(predicate: (p: CapturedPush) => boolean, timeoutMs = 3000): Promise<CapturedPush | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = captured.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/** Import only synthetic business-input state; observe actual 750 ms registry ticks. */
async function transition(contract: Contract, blocked: boolean): Promise<ProcessNode> {
  const services = fixture().services;
  const changed: Contract = { ...contract, status: blocked ? 'awaiting-owner' : 'running',
    escalations: blocked ? [{ id: 'business-input', at: Date.now(), scope: 'shape', targetId: contract.id,
      reason: 'owner-decision-needed', question: 'Which synthetic business option should be used?', unmetCriterionIds: [] }] : [] };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('No actual fleet snapshot transition')); }, 5_000);
    const unsubscribe = services.processRegistry.subscribe(snapshot => {
      const node = snapshot.nodes.find(node => node.id === `contract:${contract.id}`);
      if (!node || (node.needsAttention?.reason === 'input') !== blocked) return;
      clearTimeout(timer); unsubscribe(); resolve(node);
    });
    try {
      const json = serializeContract(changed, Date.now()); expect(json).not.toBeNull();
      expect(services.contractRunner.importContract(json!, true)).toBe(true);
    } catch (error) { clearTimeout(timer); unsubscribe(); reject(error); }
  });
}
async function businessContract(sessionId: string): Promise<Contract> {
  const contract: Contract = { id: `ctr-${randomBytes(4).toString('hex')}`, schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION,
    sessionId, origin: 'cli', ask: 'Synthetic business-input notification fixture', ownerAgentId: 'synthetic-owner',
    projectRoot: fixture().workingDirectory, isolation: 'shared', goal: 'Observe the business-input projection',
    criteria: [], groups: [], units: [], status: 'running', checks: [], fixRounds: 0, escalations: [], decisions: [],
    usage: emptyWorkItemUsage(), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, plannerAgentIds: [], createdAt: Date.now() };
  expect((await transition(contract, false)).needsAttention).toBeUndefined();
  return contract;
}
async function block(sessionId: string): Promise<Contract> {
  const contract = await businessContract(sessionId);
  const node = await transition(contract, true);
  expect(node.needsAttention?.reason).toBe('input'); expect(node.sessionRef?.sessionId).toBe(sessionId);
  return contract;
}
async function unblock(contract: Contract): Promise<void> { expect((await transition(contract, false)).needsAttention).toBeUndefined(); }

describe('fleet needs-input push fan-out (composed daemon)', () => {
  test('a fleet node blocked on the operator delivers a real encrypted needs-input push when no surface is attached', async () => {
    const services = fixture().services;
    const devicePath = '/push/needs-input-no-presence';
    await services.gatewayMethods.invoke('push.subscriptions.create', {
      methodId: 'push.subscriptions.create',
      body: { endpoint: `${sinkOrigin}${devicePath}`, keys: { p256dh, auth } },
      context: { principalId: 'test-operator' },
    } as never);

    expect(services.sessionBroker.getSession('session-no-presence')).toBeNull();
    const contract = await block('session-no-presence');

    const push = await waitForPush((p) => p.path === devicePath);
    expect(push).not.toBeNull();
    expect(push!.headers['content-encoding']).toBe('aes128gcm');
    const decrypted = decryptPush(push!.body);
    expect(decrypted.title).toBe('Input needed');
    expect(decrypted.data?.kind).toBe('needs-input');
    expect(decrypted.data?.sessionId).toBe('session-no-presence');
    expect(decrypted.data?.nodeId).toBe(`contract:${contract.id}`);
    await unblock(contract);
  });

  test('presence suppression: no push when an operator surface is attached to the session, and a sibling block without presence still pushes', async () => {
    const services = fixture().services;
    const devicePath = '/push/needs-input-presence';
    await services.gatewayMethods.invoke('push.subscriptions.create', {
      methodId: 'push.subscriptions.create',
      body: { endpoint: `${sinkOrigin}${devicePath}`, keys: { p256dh, auth } },
      context: { principalId: 'test-operator' },
    } as never);

    // An operator surface heartbeats onto this session, sessionPresence.isAttached
    // must read this back true (see fleet-needs-input-push.ts's freshness window).
    await services.sessionBroker.register({
      sessionId: 'session-with-presence',
      participant: { surfaceKind: 'tui', surfaceId: 'test-surface', lastSeenAt: Date.now() },
    });

    const before = captured.filter((p) => p.path === devicePath).length;
    const attached = await block('session-with-presence');
    // Grace period: no positive event to await, so poll a short fixed window,
    // the sibling assertion below proves the pipeline is alive, ruling out a
    // false pass from a dead pipe rather than genuine suppression.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterSuppressed = captured.filter((p) => p.path === devicePath).length;
    expect(afterSuppressed).toBe(before);

    await services.sessionBroker.createSession({ id: 'session-without-presence-sibling' });
    const sibling = await block('session-without-presence-sibling');
    const push = await waitForPush((p) => p.path === devicePath);
    expect(push).not.toBeNull();
    const decrypted = decryptPush(push!.body);
    expect(decrypted.data?.nodeId).toBe(`contract:${sibling.id}`);
    await unblock(attached); await unblock(sibling);
  });
  test('a stale participant does not suppress the actual registry-to-encrypted-push path', async () => {
    const services = fixture().services;
    const devicePath = '/push/needs-input-stale';
    await services.gatewayMethods.invoke('push.subscriptions.create', { methodId: 'push.subscriptions.create', body: { endpoint: `${sinkOrigin}${devicePath}`, keys: { p256dh, auth } }, context: { principalId: 'test-operator' } } as never);
    await services.sessionBroker.createSession({ id: 'session-stale', participant: { surfaceKind: 'tui', surfaceId: 'stale-surface', lastSeenAt: Date.now() - 10 * 60_000 } });
    expect(services.sessionBroker.getSession('session-stale')?.participants[0]?.lastSeenAt).toBeLessThan(Date.now() - 9 * 60_000);
    const contract = await block('session-stale');
    const push = await waitForPush(p => p.path === devicePath);
    expect(push).not.toBeNull(); expect(push!.headers['content-encoding']).toBe('aes128gcm');
    const payload = decryptPush(push!.body);
    expect(payload.title).toBe('Input needed'); expect(payload.data?.kind).toBe('needs-input');
    expect(payload.data?.sessionId).toBe('session-stale'); expect(payload.data?.nodeId).toBe(`contract:${contract.id}`);
    await unblock(contract);
  });

});

describe('wireFleetNeedsInputPush', () => {
  test('attaches the fleet emit-bridge to the given registry/bus: a blocked-node snapshot transition reaches the bus fleet domain', async () => {
    const bus = new RuntimeEventBus();
    let snapshotListener: ((snapshot: { capturedAt: number; nodes: unknown[] }) => void) | null = null;
    const fakeRegistry = {
      subscribe: (listener: (snapshot: { capturedAt: number; nodes: unknown[] }) => void) => {
        snapshotListener = listener;
        return () => { snapshotListener = null; };
      },
    };
    const fakeSessionBroker = { getSession: () => null };

    wireFleetNeedsInputPush({
      registry: fakeRegistry as never,
      runtimeBus: bus,
      sessionBroker: fakeSessionBroker as never,
    });
    expect(snapshotListener).not.toBeNull();

    const received: unknown[] = [];
    bus.onDomain('fleet', (envelope) => received.push(envelope.payload));

    const node: ProcessNode = { id: 'n1', kind: 'agent', label: 'task', state: 'idle', elapsedMs: 0, costState: 'unpriced',
      capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false }, raw: {} };
    // First snapshot only seeds the prior-state table (no fleet activity yet).
    (snapshotListener as unknown as (value: { capturedAt: number; nodes: unknown[] }) => void)({ capturedAt: Date.now(), nodes: [node] });
    // Second snapshot: the node picks up attention -> FLEET_NODE_BLOCKED_ON_USER.
    (snapshotListener as unknown as (value: { capturedAt: number; nodes: unknown[] }) => void)({
      capturedAt: Date.now(),
      nodes: [{ ...node, state: 'awaiting-approval', needsAttention: { reason: 'input' }, sessionRef: { sessionId: 's1' } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: 'FLEET_NODE_BLOCKED_ON_USER', nodeId: 'n1', sessionId: 's1' });
  });

  test('sessionPresence.isAttached mirrors the SDK daemon composition: true for a freshly-seen participant, false otherwise', () => {
    const now = Date.now();
    const attachedSession = { participants: [{ surfaceKind: 'tui', surfaceId: 's', lastSeenAt: now }] };
    const staleSession = { participants: [{ surfaceKind: 'tui', surfaceId: 's', lastSeenAt: now - 10 * 60 * 1000 }] };
    const fakeSessionBroker = {
      getSession: (id: string) => (id === 'attached' ? attachedSession : id === 'stale' ? staleSession : null),
    };
    const deps = wireFleetNeedsInputPush({
      registry: { subscribe: () => () => {} } as never,
      runtimeBus: new RuntimeEventBus(),
      sessionBroker: fakeSessionBroker as never,
    });

    expect(deps.sessionPresence.isAttached('attached')).toBe(true);
    expect(deps.sessionPresence.isAttached('stale')).toBe(false);
    expect(deps.sessionPresence.isAttached('unknown-session')).toBe(false);
  });
});
