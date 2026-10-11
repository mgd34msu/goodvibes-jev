/** Reconstructed from pinned original 283c14d78cfde28ee2fc72b9c6953a4f06952744; human semantic choices become recorded Jev decisions. */
/**
 * Gate: this daemon's device posture composition serves the WHOLE devices.*
 * family over the gateway, including the three verbs that ask a paired phone
 * for something and read back what it sent.
 *
 * Why this file exists. The paired-phone feature is platform-owned, but the
 * seams are this daemon's: the peer transport devices pair onto, the shared
 * approval broker the confirmation rides, the config manager the posture is
 * read from, and the state directory the grants and captures live in
 * (runtime/device-posture-composition.ts). Binding the catalog to that runtime
 * is what turns the family from cataloged-but-unhandled into handlers.
 *
 * Until devices.capability.request existed, a surface with no device runtime of
 * its own could list the grants and revoke them and could never open a camera,
 * the feature was reachable only through the `phone` tool, in-process. This test
 * drives the wire path end to end over this composition: the request reaches the
 * real capability service, Jev decides through a recorded judgment transport,
 * the bytes the device returned are retained by the real capture store, and the
 * caller reads them back by id. It also pins the properties that must NOT move
 * to the route, the confirmation, the durable grant, and the refusals, because
 * a second place those get decided is a second place they can be decided
 * differently.
 */
import { afterAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  DEVICE_CAPABILITY_IDS,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePeerView,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import { createDevicePostureServices, DAEMON_DEVICE_ACTOR } from '../../runtime/device-posture-composition.ts';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';
import { useDeviceJudgmentRuntime, deviceJudgmentFixture, type DeviceReading } from '../helpers/device-judgment-fixture.js';
useDeviceJudgmentRuntime();

const DEVICE_METHOD_IDS = [
  'devices.nodes.list',
  'devices.capability.request',
  'devices.artifacts.list',
  'devices.artifacts.read',
  'devices.grants.list',
  'devices.grants.revoke',
  'devices.housekeeping.run',
] as const;

/** PNG-ish bytes; the store only cares that what comes back is what went in. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7, 7, 7, 7]);

const runtimes: Array<{ stopHousekeeping: () => void }> = [];
afterAll(() => {
  for (const runtime of runtimes.splice(0)) runtime.stopHousekeeping();
});

interface Harness {
  readonly catalog: GatewayMethodCatalog;
  readonly grantEvaluations: DeviceReading[];
  readonly judgments: ReturnType<typeof deviceJudgmentFixture>;
  readonly service: ReturnType<typeof createDevicePostureServices>['devicePosture'];
  readonly config: ConfigManager;
  readonly transport: DevicePeerTransport;
  readonly lifetime: AbortController;
  invoke: GatewayMethodCatalog['invoke'];
  readonly dispatched: string[];
  approve(decision: 'once' | 'always' | 'deny'): void;
  sendBytes(send: boolean): void;
}

function pairedPhone(): DevicePeerView {
  return {
    id: 'phone-1',
    label: 'Pixel on the desk',
    kind: 'device',
    platform: 'android',
    version: '1.0.0',
    status: 'connected',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    metadata: {
      [DEVICE_NODE_ANNOUNCEMENT_KEY]: {
        nodeKind: 'web-pwa',
        contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
        capabilities: [...DEVICE_CAPABILITY_IDS],
        secureContext: true,
      },
    },
  };
}

function harness(options: { unrecorded?: boolean; unclaimed?: boolean } = {}): Harness {
  const root = makeProjectTempDir('gv-daemon-device-verbs-');
  const judgments = deviceJudgmentFixture();
  const lifetime = new AbortController();
  const dispatched: string[] = [];
  judgments.answer('once');
  let sendBytes = false;

  const transport: DevicePeerTransport = {
    listPeers: (kind) => (kind === undefined || kind === 'device' ? [pairedPhone()] : []),
    invokePeer: async (input) => {
      input.admission?.assertCurrent(); if (!options.unclaimed) input.admission?.claim();
      dispatched.push(input.command);
      return {
        completed: true,
        work: {
          id: 'work-1',
          status: 'completed',
          result: {
            contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
            capabilityId: input.command,
            ok: true,
            data: { echoed: input.command },
            ...(sendBytes
              ? {
                mediaBase64: Buffer.from(CAPTURE_BYTES).toString('base64'),
                mediaType: 'image/png',
              }
              : {}),
          },
        },
      };
    },
  };

  const approvals: DeviceApprovalBridge = { requestApproval: async () => { throw new Error('Human approval must not run'); } };

  const catalog = new GatewayMethodCatalog();
  const config = new ConfigManager({ workingDir: join(root, 'work'), homeDir: root, surfaceRoot: 'tui' });
  const { devicePosture } = createDevicePostureServices({
    configManager: config,
    judgmentPort: options.unrecorded ? { model: judgments.port.model, ask: judgments.port.ask } : judgments.port,
    signal: lifetime.signal,
    distributedRuntime: transport,
    approvals,
    stateDirectory: join(root, 'devices'),
    gatewayMethods: catalog,
  });
  // Nothing here starts housekeeping; the disposer is registered so a future
  // change that does cannot leave a timer running past this file.
  runtimes.push(devicePosture);

  return {
    catalog,
    get grantEvaluations() { return judgments.grantEvaluations; },
    judgments, service: devicePosture, config, transport, lifetime,
    invoke: (id, request) => judgments.run(() => catalog.invoke(id, request)),
    dispatched,
    approve(next) { judgments.answer(next); },
    sendBytes(next) { sendBytes = next; },
  };
}

const CONTEXT = { context: { admin: true } } as const;

describe('the composed daemon serves the whole devices.* family', () => {
  test('every device verb is cataloged and handled, not a 501 facade', () => {
    const h = harness();
    for (const id of DEVICE_METHOD_IDS) {
      expect(h.catalog.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(h.catalog.hasHandler(id), `${id} has no handler`).toBe(true);
    }
  });

  test('the paired phone this daemon\'s transport reports is the one the verbs see', async () => {
    const h = harness();
    const listed = await h.invoke('devices.nodes.list', { ...CONTEXT, body: {} }) as {
      nodes: readonly { nodeId: string; label: string }[];
    };
    expect(listed.nodes.map((node) => node.nodeId)).toEqual(['phone-1']);
    expect(listed.nodes[0]?.label).toBe('Pixel on the desk');
  });

  test('a request goes through this daemon\'s recorded Jev owner and out over its transport', async () => {
    const h = harness();
    const result = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: {
        nodeId: 'phone-1',
        capabilityId: 'device.command.vibrate',
        reason: 'confirming which phone is on the desk',
      },
    }) as { ok: boolean; authority: string; data?: unknown };

    expect(result).toMatchObject({ ok: true });
    expect(result.authority).toBe('confirmed-once');
    // The actual recorded reading carries exact request evidence. No human
    // approval broker is consulted.
    expect(h.grantEvaluations).toHaveLength(1);
    expect(h.grantEvaluations[0]?.request.nodeId).toBe('phone-1');
    expect(h.grantEvaluations[0]?.request.capabilityId).toBe('device.command.vibrate');
    expect(h.grantEvaluations[0]?.request.reason).toBe('confirming which phone is on the desk');
    expect(h.dispatched).toEqual(['device.command.vibrate']);
  });

  test('a refusal is an answer with the reason, and nothing reaches the phone', async () => {
    const h = harness();
    h.approve('deny');
    const result = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'no thanks' },
    }) as { ok: boolean; refusal: string; detail: string };

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('denied-by-jev');
    expect(result.detail).toContain('Jev declined');
    expect(h.dispatched).toEqual([]);
  });

  test('a capture is retained by this daemon\'s store and read back byte for byte', async () => {
    const h = harness();
    h.sendBytes(true);
    const requested = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.screen.capture', reason: 'read the error on my screen' },
    }) as { ok: boolean; artifact: { artifactId: string; byteLength: number; mediaType: string } | null };

    expect(requested.ok).toBe(true);
    expect(requested.artifact?.mediaType).toBe('image/png');
    const artifactId = requested.artifact?.artifactId ?? '';

    const listed = await h.invoke('devices.artifacts.list', { ...CONTEXT, body: {} }) as {
      artifacts: readonly { artifactId: string }[];
      retained: number;
      retentionHours: number;
    };
    expect(listed.retained).toBe(1);
    expect(listed.retentionHours).toBe(24);
    expect(listed.artifacts[0]?.artifactId).toBe(artifactId);

    const read = await h.invoke('devices.artifacts.read', {
      ...CONTEXT,
      body: { artifactId },
    }) as { dataBase64: string; artifact: { byteLength: number } };
    expect(read.artifact.byteLength).toBe(CAPTURE_BYTES.byteLength);
    // A surface that is not on this host's disk gets the same bytes the phone
    // sent, which is the whole reason this verb exists.
    expect([...Buffer.from(read.dataBase64, 'base64')]).toEqual([...CAPTURE_BYTES]);
  });

  test('a durable grant given through the verb is visible and revocable in the grants surface', async () => {
    const h = harness();
    h.approve('always');
    await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'roughly where am I' },
    });

    const grants = await h.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { capabilityId: string; nodeId: string; grantId: string }[];
    };
    expect(grants.grants.map((grant) => grant.capabilityId)).toEqual(['device.location.coarse']);

    // Grant creation is reused; the second dispatch still has its own reading.
    const second = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'again' },
    }) as { authority: string };
    expect(second.authority).toBe('existing-grant');
    expect(h.judgments.readings.filter(reading => reading.purpose === 'dispatch')).toHaveLength(3);
    expect(h.grantEvaluations).toHaveLength(1);

    await h.invoke('devices.grants.revoke', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse' },
    });
    const third = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.location.coarse', reason: 'after revoking' },
    }) as { authority: string };
    expect(third.authority).toBe('confirmed-always');
    expect(h.grantEvaluations).toHaveLength(2);
  });

  test('this daemon records itself as the actor, so the ledger says where the decision was made', async () => {
    const h = harness();
    h.approve('always');
    await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.read', reason: 'paste what I copied' },
    });
    const grants = await h.invoke('devices.grants.list', { ...CONTEXT, body: {} }) as {
      grants: readonly { grantedBy: string }[];
      audit: readonly { action: string }[];
    };
    expect(grants.grants[0]?.grantedBy).toBe('jev:device');
    expect(grants.audit.some((entry) => entry.action === 'granted')).toBe(true);
    expect(DAEMON_DEVICE_ACTOR).toBe('daemon:phone-tool');
  });

  test('a request the contract cannot satisfy is refused before anyone is asked', async () => {
    const h = harness();
    const missingInput = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'phone-1', capabilityId: 'device.clipboard.write', reason: 'put this on the phone' },
    }) as { ok: boolean; refusal: string };
    const unknownNode = await h.invoke('devices.capability.request', {
      ...CONTEXT,
      body: { nodeId: 'not-paired', capabilityId: 'device.command.vibrate', reason: 'x' },
    }) as { ok: boolean; refusal: string };

    expect(missingInput.refusal).toBe('invalid-input');
    expect(unknownNode.refusal).toBe('node-unknown');
    expect(h.grantEvaluations).toHaveLength(0);
    expect(h.dispatched).toEqual([]);
  });
});

const requestBody = { nodeId: 'phone-1', capabilityId: 'device.camera.rear.capture', reason: 'Read the exact synthetic test capture' };
const requestDevice = (h: Harness) => h.invoke('devices.capability.request', { ...CONTEXT, body: requestBody }) as Promise<{ ok: boolean; refusal: string; detail: string }>;
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('recorded current device ownership', () => {
  test('authenticated catalog calls cannot invent original authority from reason prose', async () => {
    const h = harness();
    expect(await h.catalog.invoke('devices.capability.request', { ...CONTEXT, body: requestBody })).toMatchObject({ ok: false, refusal: 'denied-by-jev' });
    expect(h.judgments.readings).toEqual([]); expect(h.dispatched).toEqual([]);
  });
  test('unrecorded port refuses before transport', async () => {
    const h = harness({ unrecorded: true }); expect(await requestDevice(h)).toMatchObject({ ok: false, refusal: 'denied-by-jev' });
    expect(h.judgments.readings).toEqual([]); expect(h.dispatched).toEqual([]);
  });
  test('inline credential-shaped request material is refused before hosted reading', async () => {
    const h = harness();
    expect(await h.invoke('devices.capability.request', { ...CONTEXT, body: { ...requestBody, reason: 'Authorization: Bearer sk-' + 'x'.repeat(48) } })).toMatchObject({ ok: false });
    expect(h.judgments.readings).toEqual([]); expect(h.dispatched).toEqual([]);
  });
  test.each(['source', 'config', 'config-aba', 'cancel', 'host-close', 'node', 'ledger'] as const)('%s change during held judgment refuses before dispatch', async change => {
    const h = harness(); const entered = barrier(); const release = barrier();
    h.judgments.onReading(async () => { entered.resolve(); await release.promise; });
    const pending = requestDevice(h);
    const settled = pending.then(value => ({ value }), error => ({ error })); await entered.promise;
    if (change === 'source') h.judgments.changeSource('Only inspect the local text, never capture');
    if (change === 'config' || change === 'config-aba') h.config.set('device.capabilities.mode', 'off');
    if (change === 'config-aba') h.config.set('device.capabilities.mode', 'honor-grants');
    if (change === 'cancel') h.judgments.lifetime.abort();
    if (change === 'host-close') h.lifetime.abort();
    if (change === 'node') h.transport.listPeers = () => [];
    if (change === 'ledger') await h.service.grants.record({ nodeId: 'phone-1', nodeKind: 'web-pwa', capabilityId: 'device.camera.rear.capture', scope: 'always', grantedBy: 'fixture' });
    release.resolve(); const result = await settled;
    if (change === 'cancel') expect('error' in result ? result.error.name : '').toBe('AbortError');
    else expect('value' in result ? result.value : undefined).toMatchObject({ ok: false, refusal: 'denied-by-jev' });
    expect(h.dispatched).toEqual([]);
  });
  test.each(['revoke', 'sweep'] as const)('a request beginning after pending %s intent cannot use old bytes', async mutation => {
    const h = harness(); h.approve('always'); expect(await requestDevice(h)).toMatchObject({ ok: true });
    const release = barrier(); const store = h.service.grants as unknown as { writeChain: Promise<void> };
    store.writeChain = release.promise;
    const pending = mutation === 'revoke' ? h.service.grants.revoke({ nodeId: 'phone-1', actor: 'fixture' }) : h.service.grants.sweep();
    expect(h.service.grants.hasPendingRevocations()).toBe(true);
    expect(await requestDevice(h)).toMatchObject({ ok: false, refusal: 'denied-by-jev' });
    expect(h.dispatched).toHaveLength(1); release.resolve(); await pending;
    expect(h.service.grants.hasPendingRevocations()).toBe(false);
  });
  test('existing durable grant never bypasses a fresh rejection or records a successful use', async () => {
    const h = harness(); h.approve('always'); expect(await requestDevice(h)).toMatchObject({ ok: true });
    const before = (await h.service.grants.list())[0]!; h.approve('deny');
    expect(await requestDevice(h)).toMatchObject({ ok: false, refusal: 'denied-by-jev' });
    expect(h.dispatched).toHaveLength(1); expect((await h.service.grants.list())[0]!.useCount).toBe(before.useCount);
    expect(h.judgments.readings.at(-1)?.grant).toMatchObject({ id: before.id });
  });
  test('late captured bytes after cancellation are never retained', async () => {
    const h = harness(); h.sendBytes(true); const original = h.transport.invokePeer.bind(h.transport);
    h.transport.invokePeer = async input => { const result = await original(input); h.judgments.lifetime.abort(); return result; };
    await expect(requestDevice(h)).rejects.toMatchObject({ name: 'AbortError' }); expect(await h.service.artifacts.list()).toEqual([]);
  });
  test('transport must consume the exact single-use admission', async () => {
    const h = harness({ unclaimed: true }); h.sendBytes(true);
    expect(await requestDevice(h)).toMatchObject({ ok: false, detail: 'Device transport did not claim its exact admission' });
    expect(await h.service.artifacts.list()).toEqual([]);
  });
  test('second transport claim fails and cannot retain captures', async () => {
    const h = harness(); const original = h.transport.invokePeer.bind(h.transport);
    h.transport.invokePeer = async input => { const result = await original(input); input.admission!.claim(); return result; };
    expect(await requestDevice(h)).toMatchObject({ ok: false, detail: 'Device act already claimed' });
    expect(await h.service.artifacts.list()).toEqual([]);
  });
  test('revocation while grant publication is queued prevents the new grant', async () => {
    const h = harness(); h.approve('always'); const entered = barrier(); const release = barrier();
    const original = h.service.grants.record.bind(h.service.grants);
    const spy = spyOn(h.service.grants, 'record').mockImplementation(async input => { entered.resolve(); await release.promise; return original(input); });
    try {
      const pending = requestDevice(h); await entered.promise;
      await h.service.grants.revoke({ nodeId: 'phone-1', actor: 'fixture' }); release.resolve();
      expect(await pending).toMatchObject({ ok: false }); expect(await h.service.grants.list()).toEqual([]); expect(h.dispatched).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); }
  });
  test('revocation while retained capture index is queued prevents publication and removes unindexed bytes', async () => {
    const h = harness(); h.sendBytes(true); const release = barrier();
    (h.service.artifacts as unknown as { writeChain: Promise<void> }).writeChain = release.promise;
    const entered = barrier(); const original = h.transport.invokePeer.bind(h.transport);
    h.transport.invokePeer = async input => { const result = await original(input); entered.resolve(); return result; };
    const pending = requestDevice(h); await entered.promise;
    await h.service.grants.revoke({ nodeId: 'phone-1', actor: 'fixture' }); release.resolve();
    expect(await pending).toMatchObject({ ok: false }); expect(await h.service.artifacts.list()).toEqual([]);
    const files = await import('node:fs/promises').then(fs => fs.readdir(h.service.artifacts.getDirectory()).catch(() => []));
    expect(files.filter(file => file !== 'capture-index.json')).toEqual([]);
  });
});

test.each(['remove', 'rewrite-same'] as const)('external %s after admitted grant publication cannot be adopted as owned publication', async mode => {
  const h = harness(); h.approve('always'); const original = h.service.grants.record.bind(h.service.grants);
  const spy = spyOn(h.service.grants, 'record').mockImplementation(async input => {
    const grant = await original(input);
    const store = h.service.grants as unknown as { store: { lockPath: string } };
    const fs = await import('node:fs/promises'); const path = store.store.lockPath.slice(0, -5);
    const snapshot = JSON.parse(await fs.readFile(path, 'utf8')); if (mode === 'remove') snapshot.grants = [];
    await fs.writeFile(path, JSON.stringify(snapshot)); return grant;
  });
  try { expect(await requestDevice(h)).toMatchObject({ ok: false }); expect(h.dispatched).toEqual([]); }
  finally { spy.mockRestore(); }
});

test('borrowed executable request accessors are refused without invoking them', async () => {
  const h = harness(); let invoked = false;
  const input = { ...requestBody, get input() { invoked = true; return {}; } };
  expect(await h.judgments.run(() => h.service.capabilities.request(input))).toMatchObject({ ok: false, refusal: 'invalid-input' });
  expect(invoked).toBe(false); expect(h.judgments.readings).toEqual([]); expect(h.dispatched).toEqual([]);
});

test('a live grant expiring during judgment cannot authorize later delivery', async () => {
  const h = harness();
  await h.service.grants.record({ nodeId: 'phone-1', nodeKind: 'web-pwa', capabilityId: 'device.camera.rear.capture', scope: 'always', grantedBy: 'fixture', ttlMs: 500 });
  h.judgments.onReading(() => { setSystemTime(new Date(Date.now() + 1000)); });
  try { expect(await requestDevice(h)).toMatchObject({ ok: false }); expect(h.dispatched).toEqual([]); }
  finally { setSystemTime(); }
});
