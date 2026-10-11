/** Reconstructed from pinned original 58f237bcd8a3b3972afaea86a8f5ddea179b1c72. Human prompts adapted to actual recorded grant-offer readings; every dispatch is freshly judged. */
/**
 * device-posture-key-governance.test.ts, the eleven `device.*` posture keys,
 * as behaviour, in THIS composition.
 *
 * ── Why this test exists ──────────────────────────────────────────────────
 *
 * The device posture runtime is composed in this repository
 * (runtime/device-posture-composition.ts, wired at runtime/services.ts) and
 * served over this daemon's gateway.
 *
 * Two other suites cover related but different ground, and neither is this one. The
 * SDK's own device-capabilities suite covers the KEY SEMANTICS: given a policy,
 * what the capability service does. This repository's
 * daemon/gateway-device-capability-verbs.test.ts covers the VERBS, the transport,
 * the approval seam and retention, and names no `device.*` key anywhere. So the
 * property that died is the one in between: that THIS composition wires the
 * config keys to the service, so a value the owner sets actually governs.
 *
 * That gap is not hypothetical. Before the posture runtime was composed at all,
 * these keys were recorded, read back, and governed nothing, the service they
 * describe was never built in the host, so there was nothing for them to govern,
 * and the settings description that said otherwise was aspirational. A test that
 * only round-trips a key through ConfigManager would have passed the whole time.
 *
 * ── The shape every test here takes ──────────────────────────────────────
 *
 * Drive ONE key to at least two distinct values (the schema default, and a
 * clearly different in-range value), run the real consuming code, and assert an
 * outcome that DIFFERS between the two. Nothing here asserts that a key exists,
 * has a description, or persists.
 *
 * What is real: a real ConfigManager over a temp home (so every value is one the
 * shared schema accepts), this repository's real composition function, and the
 * platform's real DeviceCapabilityService / DeviceGrantStore /
 * DeviceCaptureArtifactStore / DeviceHousekeeper underneath. Two seams are
 * stubbed, both of them the ones the composition takes from outside: the peer
 * transport (records what the phone was asked to do, answers contract-shaped)
 * and a recorded synthetic Jev transport (selects exact offered outcomes).
 * The human approval bridge is a throwing sentinel and cannot decide actions.
 * No camera, clipboard or location source is involved, and the clock is driven
 * with `setSystemTime` rather than by waiting.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  registerDevicePhoneTool,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import type {
  DeviceCapabilityId,
  DeviceCapabilityOutcome,
  DeviceCaptureArtifact,
  DevicePeerView,
  DevicePostureRuntime,
  DeviceWorkView,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { createDevicePostureServices } from '../../runtime/device-posture-composition.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.js';
import { useDeviceJudgmentRuntime, deviceJudgmentFixture, type DeviceReading } from '../helpers/device-judgment-fixture.js';
useDeviceJudgmentRuntime();
import { useGatewayFixture } from '../helpers/gateway-fixture.js';


// Stop the shared test runtime graph when this file ends, see that helper's doc.


const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_TIME = Date.UTC(2026, 6, 29, 12, 0, 0);

const CAMERA_REAR: DeviceCapabilityId = 'device.camera.rear.capture';
const CAMERA_FRONT: DeviceCapabilityId = 'device.camera.front.capture';
const SCREEN: DeviceCapabilityId = 'device.screen.capture';
const LOCATION_COARSE: DeviceCapabilityId = 'device.location.coarse';
const LOCATION_PRECISE: DeviceCapabilityId = 'device.location.precise';
const CLIPBOARD_READ: DeviceCapabilityId = 'device.clipboard.read';
const CLIPBOARD_WRITE: DeviceCapabilityId = 'device.clipboard.write';
const NOTIFY: DeviceCapabilityId = 'device.command.notify';
const VIBRATE: DeviceCapabilityId = 'device.command.vibrate';

/**
 * The posture keys this file governs, one describe block each. Pinned as a list
 * so the completeness check below can compare it against the schema, a new
 * `device.*` key that lands with no behaviour test is exactly how the previous
 * eleven ended up governing nothing.
 */
const GOVERNED_KEYS: readonly string[] = [
  'device.capabilities.mode',
  'device.capabilities.allowAlwaysOffer',
  'device.capabilities.requestTimeoutSeconds',
  'device.location.precision',
  'device.clipboard.readMode',
  'device.capture.retentionHours',
  'device.capture.maxArtifacts',
  'device.capture.sweepIntervalMinutes',
  'device.grants.expiryDays',
  'device.grants.maxPerNode',
  'device.grants.auditRetentionDays',
];

/**
 * `device.*` keys with no behaviour test in this file, each with the reason.
 * An entry here is a statement, not a shrug: it says what governs the key and
 * where that is checked.
 */
const UNGOVERNED_HERE: readonly { readonly key: string; readonly reason: string }[] = [
  {
    key: 'device.nodes.maxPaired',
    reason:
      'Bounds the pairing surface, not the capability service this composition builds. Nothing in '
      + 'createDevicePostureServices reads it, so there is no behaviour here to drive it against; '
      + 'it belongs with the pairing-token family.',
  },
];

/**
 * The required input each capability declares, so a request under test is
 * refused for the REASON being tested rather than for a missing field.
 *
 * The host-side input check (device-capability-service.ts) runs before the
 * confirmation prompt, deliberately, so nobody is asked to approve a request
 * that cannot run, and it postdates the suite this file was recovered from.
 * A request missing `title` or `text` never reaches the posture gate at all,
 * which would make several tests below pass for the wrong reason and one of
 * them (mode: off) pass while checking nothing.
 */
const REQUIRED_INPUT: Readonly<Partial<Record<DeviceCapabilityId, Record<string, unknown>>>> = {
  'device.command.notify': { title: 'Posture test' },
  'device.clipboard.write': { text: 'posture test clipboard text' },
};

/** Deterministic capture payload, base64 the way a node would send it. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
const CAPTURE_BASE64 = Buffer.from(CAPTURE_BYTES).toString('base64');

let root = '';
let clock = BASE_TIME;
let homeSeq = 0;

beforeEach(() => {
  root = makeProjectTempDir('gv-daemon-device-posture');
  homeSeq = 0;
  clock = BASE_TIME;
  setSystemTime(new Date(clock));
});

afterEach(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
});

/** Move the clock the stores read (they call Date.now with no injected clock). */
function advanceClock(ms: number): void {
  clock += ms;
  setSystemTime(new Date(clock));
}

/** A real ConfigManager over a fresh temp home, built the way this daemon builds it. */
function freshConfig(): ConfigManager {
  homeSeq += 1;
  const home = join(root, `home-${homeSeq}`);
  mkdirSync(home, { recursive: true });
  return new ConfigManager({
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    workingDir: home,
    configDir: join(home, 'cfg'),
  });
}

/** A paired peer carrying a device-node announcement for every catalog capability. */
function devicePeer(nodeId = 'phone-1'): DevicePeerView {
  return {
    id: nodeId,
    kind: 'device',
    label: 'Test phone',
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

interface DispatchCall {
  readonly peerId: string;
  readonly command: string;
  readonly waitMs: number | undefined;
  readonly timeoutMs: number | undefined;
  /** `timeoutMs` inside the work payload, the deadline the device is told. */
  readonly payloadTimeoutMs: number | undefined;
}

type Answer = 'once' | 'always' | 'deny';

interface Harness {
  readonly service: DevicePostureRuntime;
  readonly gateway: GatewayMethodCatalog;
  readonly grantEvaluations: DeviceReading[];
  readonly judgments: ReturnType<typeof deviceJudgmentFixture>;
  readonly dispatches: DispatchCall[];
  answer(decision: Answer): void;
  returnCapture(enabled: boolean): void;
  run(capabilityId: DeviceCapabilityId, reason?: string): Promise<DeviceCapabilityOutcome>;
}

function payloadTimeout(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).timeoutMs;
  return typeof value === 'number' ? value : undefined;
}

function harness(configManager: ConfigManager, stateDirectory: string): Harness {
  const judgments = deviceJudgmentFixture();
  const dispatches: DispatchCall[] = [];
  const peers = [devicePeer()];
  const gateway = new GatewayMethodCatalog();
  judgments.answer('always');
  let capture = false;

  const { devicePosture } = createDevicePostureServices({
    configManager,
    stateDirectory,
    gatewayMethods: gateway,
    judgmentPort: judgments.port,
    distributedRuntime: {
      listPeers: (kind) => peers.filter((peer) => kind === undefined || peer.kind === kind),
      invokePeer: async (input): Promise<{ work: DeviceWorkView; completed: boolean }> => {
        input.admission?.assertCurrent(); input.admission?.claim();
        dispatches.push({
          peerId: input.peerId,
          command: input.command,
          waitMs: input.waitMs,
          timeoutMs: input.timeoutMs,
          payloadTimeoutMs: payloadTimeout(input.payload),
        });
        return {
          completed: true,
          work: {
            id: `work-${dispatches.length}`,
            status: 'completed',
            result: {
              contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
              capabilityId: input.command,
              ok: true,
              data: { served: input.command },
              ...(capture ? { mediaBase64: CAPTURE_BASE64, mediaType: 'image/png' } : {}),
            },
          },
        };
      },
    },
    approvals: { requestApproval: async () => { throw new Error('Human device approval must not run'); } },
  });

  return {
    service: devicePosture,
    gateway,
    get grantEvaluations() { return judgments.grantEvaluations; },
    judgments,
    dispatches,
    answer(decision: Answer): void { judgments.answer(decision); },
    returnCapture(enabled: boolean): void { capture = enabled; },
    run(capabilityId: DeviceCapabilityId, reason = 'behaviour test'): Promise<DeviceCapabilityOutcome> {
      const required = REQUIRED_INPUT[capabilityId];
      return judgments.run(() => devicePosture.capabilities.request({
        nodeId: 'phone-1',
        capabilityId,
        reason,
        ...(required ? { input: required } : {}),
      }));
    },
  };
}

/** Readable one-liner for an outcome, so a failure says what actually happened. */
function label(outcome: DeviceCapabilityOutcome): string {
  return outcome.ok ? `ok:${outcome.authority}` : `refused:${outcome.refusal}`;
}

function requireArtifact(outcome: DeviceCapabilityOutcome): DeviceCaptureArtifact {
  if (!outcome.ok) throw new Error(`expected a capture, got refusal ${outcome.refusal}: ${outcome.detail}`);
  if (!outcome.artifact) throw new Error('expected the capture to be retained as an artifact');
  return outcome.artifact;
}

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Captures the delay handed to setInterval and the callback registered with it,
 * so the periodic housekeeping sweep can be inspected and fired without waiting
 * out a real interval. Returns real (clearable) timers so the housekeeper's
 * start/stop behave exactly as they do in production.
 */
interface IntervalCapture {
  readonly delays: number[];
  fireLast(): void;
  restore(): void;
}

function captureIntervals(): IntervalCapture {
  const realSetInterval = globalThis.setInterval;
  const delays: number[] = [];
  const callbacks: Array<() => void> = [];
  const spawned: Array<ReturnType<typeof setInterval>> = [];
  globalThis.setInterval = ((handler: () => void, timeout?: number) => {
    delays.push(timeout ?? 0);
    callbacks.push(handler);
    const timer = realSetInterval(() => undefined, HOUR);
    spawned.push(timer);
    return timer;
  }) as unknown as typeof globalThis.setInterval;

  return {
    delays,
    fireLast(): void {
      const callback = callbacks[callbacks.length - 1];
      if (!callback) throw new Error('no interval callback was registered');
      callback();
    },
    restore(): void {
      for (const timer of spawned) clearInterval(timer);
      globalThis.setInterval = realSetInterval;
    },
  };
}

describe('device.* posture: behaviour in this daemon', () => {
  // -------------------------------------------------------------------------
  // device.capabilities.mode
  // -------------------------------------------------------------------------

  test('device.capabilities.mode: off refuses every request with disabled-by-config, honor-grants serves it', async () => {
    const stock = harness(freshConfig(), join(root, 'state-stock'));
    stock.answer('once');
    expect(label(await stock.run(CAMERA_REAR))).toBe('ok:confirmed-once');
    expect(stock.dispatches).toHaveLength(1);

    const offConfig = freshConfig();
    offConfig.set('device.capabilities.mode', 'off');
    const off = harness(offConfig, join(root, 'state-off'));
    off.answer('once');

    for (const capabilityId of [CAMERA_REAR, LOCATION_COARSE, CLIPBOARD_WRITE, NOTIFY] as const) {
      expect(label(await off.run(capabilityId))).toBe('refused:disabled-by-config');
    }
    // Turned off means nothing reached the phone and nobody was asked.
    expect(off.dispatches).toHaveLength(0);
    expect(off.grantEvaluations).toHaveLength(0);
  });

  test('device.capabilities.mode: ask-every-time asks again even with a live grant, honor-grants uses the grant', async () => {
    const shared = join(root, 'state-mode-shared');

    const honor = harness(freshConfig(), shared);
    honor.answer('always');
    expect(label(await honor.run(SCREEN))).toBe('ok:confirmed-always');
    expect(honor.grantEvaluations).toHaveLength(1);
    expect(label(await honor.run(SCREEN))).toBe('ok:existing-grant');
    expect(honor.grantEvaluations).toHaveLength(1);

    // Same grant on disk, same capability, same node, only the setting differs.
    const askConfig = freshConfig();
    askConfig.set('device.capabilities.mode', 'ask-every-time');
    const ask = harness(askConfig, shared);
    ask.answer('once');
    expect(await ask.service.grants.list()).toHaveLength(1);

    expect(label(await ask.run(SCREEN))).toBe('ok:confirmed-once');
    expect(label(await ask.run(SCREEN))).toBe('ok:confirmed-once');
    expect(ask.grantEvaluations).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // device.capabilities.allowAlwaysOffer
  // -------------------------------------------------------------------------

  test('device.capabilities.allowAlwaysOffer: every-capability grants an elevated capability durably, standard-only refuses to', async () => {
    const every = harness(freshConfig(), join(root, 'state-every'));
    every.answer('always');
    expect(label(await every.run(CAMERA_FRONT))).toBe('ok:confirmed-always');
    expect(Object.keys(every.judgments.requests[0]!.questions.disposition!.type === 'choice' ? every.judgments.requests[0]!.questions.disposition!.criteria : {})).toContain('revise_0');
    expect(every.grantEvaluations[0]?.request.allowAlwaysOffered).toBe(true);
    expect(await every.service.grants.list()).toHaveLength(1);
    expect(label(await every.run(CAMERA_FRONT))).toBe('ok:existing-grant');
    expect(every.grantEvaluations).toHaveLength(1);

    const standardConfig = freshConfig();
    standardConfig.set('device.capabilities.allowAlwaysOffer', 'standard-only');
    const standard = harness(standardConfig, join(root, 'state-standard'));
    standard.answer('always');
    // Front camera is elevated: the prompt must not offer a durable grant, and
    // an "always" answer must not be turned into one.
    expect(label(await standard.run(CAMERA_FRONT))).toBe('ok:confirmed-once');
    expect(Object.keys(standard.judgments.requests[0]!.questions.disposition!.type === 'choice' ? standard.judgments.requests[0]!.questions.disposition!.criteria : {})).not.toContain('revise_0');
    expect(standard.grantEvaluations[0]?.request.allowAlwaysOffered).toBe(false);
    expect(await standard.service.grants.list()).toHaveLength(0);

    // Standard-sensitivity capabilities stay grantable under the same value, so
    // this discriminates by sensitivity rather than switching grants off.
    expect(label(await standard.run(NOTIFY))).toBe('ok:confirmed-always');
    expect(await standard.service.grants.list()).toHaveLength(1);

    const neverConfig = freshConfig();
    neverConfig.set('device.capabilities.allowAlwaysOffer', 'never');
    const never = harness(neverConfig, join(root, 'state-never'));
    never.answer('always');
    expect(label(await never.run(NOTIFY))).toBe('ok:confirmed-once');
    expect(label(await never.run(VIBRATE))).toBe('ok:confirmed-once');
    expect(await never.service.grants.list()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // device.capabilities.requestTimeoutSeconds
  // -------------------------------------------------------------------------

  test('device.capabilities.requestTimeoutSeconds: the configured seconds are the deadline on the dispatch, the wire payload, and the prompt', async () => {
    const stock = harness(freshConfig(), join(root, 'state-timeout-stock'));
    stock.answer('once');
    await stock.run(NOTIFY);
    expect(stock.dispatches[0]?.waitMs).toBe(60_000);
    expect(stock.dispatches[0]?.timeoutMs).toBe(60_000);
    expect(stock.dispatches[0]?.payloadTimeoutMs).toBe(60_000);
    expect(stock.grantEvaluations[0]?.policy.requestTimeoutMs).toBe(60_000);

    const shortConfig = freshConfig();
    shortConfig.set('device.capabilities.requestTimeoutSeconds', 5);
    const short = harness(shortConfig, join(root, 'state-timeout-short'));
    short.answer('once');
    await short.run(NOTIFY);
    expect(short.dispatches[0]?.waitMs).toBe(5_000);
    expect(short.dispatches[0]?.timeoutMs).toBe(5_000);
    expect(short.dispatches[0]?.payloadTimeoutMs).toBe(5_000);
    expect(short.grantEvaluations[0]?.policy.requestTimeoutMs).toBe(5_000);
  });

  // -------------------------------------------------------------------------
  // device.location.precision
  // -------------------------------------------------------------------------

  test('device.location.precision: coarse-only refuses precise location while approximate location still runs', async () => {
    const stock = harness(freshConfig(), join(root, 'state-loc-stock'));
    stock.answer('once');
    expect(label(await stock.run(LOCATION_PRECISE))).toBe('ok:confirmed-once');

    const coarseConfig = freshConfig();
    coarseConfig.set('device.location.precision', 'coarse-only');
    const coarse = harness(coarseConfig, join(root, 'state-loc-coarse'));
    coarse.answer('once');

    expect(label(await coarse.run(LOCATION_PRECISE))).toBe('refused:disabled-by-config');
    expect(coarse.dispatches).toHaveLength(0);
    expect(label(await coarse.run(LOCATION_COARSE))).toBe('ok:confirmed-once');
    expect(coarse.dispatches).toHaveLength(1);
  });

  test('device.location.precision: ask-precise keeps precise location working but stores no durable grant for it', async () => {
    const askConfig = freshConfig();
    askConfig.set('device.location.precision', 'ask-precise');
    const ask = harness(askConfig, join(root, 'state-loc-ask'));
    ask.answer('always');

    expect(label(await ask.run(LOCATION_PRECISE))).toBe('ok:confirmed-once');
    expect(ask.grantEvaluations[0]?.request.allowAlwaysOffered).toBe(false);
    expect(await ask.service.grants.list()).toHaveLength(0);
    // The approximate fix under the same setting is still grantable, so this is
    // a gate on the precise fix and not a blanket "never remember".
    expect(label(await ask.run(LOCATION_COARSE))).toBe('ok:confirmed-always');
    expect(await ask.service.grants.list()).toHaveLength(1);

    const stock = harness(freshConfig(), join(root, 'state-loc-grantable'));
    stock.answer('always');
    expect(label(await stock.run(LOCATION_PRECISE))).toBe('ok:confirmed-always');
    expect(label(await stock.run(LOCATION_PRECISE))).toBe('ok:existing-grant');
    expect(stock.grantEvaluations).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // device.clipboard.readMode
  // -------------------------------------------------------------------------

  test('device.clipboard.readMode: off refuses clipboard reads while writing to the clipboard still works', async () => {
    const stock = harness(freshConfig(), join(root, 'state-clip-stock'));
    stock.answer('once');
    expect(label(await stock.run(CLIPBOARD_READ))).toBe('ok:confirmed-once');

    const offConfig = freshConfig();
    offConfig.set('device.clipboard.readMode', 'off');
    const off = harness(offConfig, join(root, 'state-clip-off'));
    off.answer('once');

    expect(label(await off.run(CLIPBOARD_READ))).toBe('refused:disabled-by-config');
    expect(off.dispatches).toHaveLength(0);
    expect(off.grantEvaluations).toHaveLength(0);
    expect(label(await off.run(CLIPBOARD_WRITE))).toBe('ok:confirmed-once');
    expect(off.dispatches).toHaveLength(1);
  });

  test('device.clipboard.readMode: ask-only keeps clipboard reads working but stores no durable grant', async () => {
    const askConfig = freshConfig();
    askConfig.set('device.clipboard.readMode', 'ask-only');
    const ask = harness(askConfig, join(root, 'state-clip-ask'));
    ask.answer('always');

    expect(label(await ask.run(CLIPBOARD_READ))).toBe('ok:confirmed-once');
    expect(ask.grantEvaluations[0]?.request.allowAlwaysOffered).toBe(false);
    expect(await ask.service.grants.list()).toHaveLength(0);

    const stock = harness(freshConfig(), join(root, 'state-clip-grantable'));
    stock.answer('always');
    expect(label(await stock.run(CLIPBOARD_READ))).toBe('ok:confirmed-always');
    expect(label(await stock.run(CLIPBOARD_READ))).toBe('ok:existing-grant');
    expect(stock.grantEvaluations).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // device.capture.retentionHours
  // -------------------------------------------------------------------------

  test('device.capture.retentionHours: a capture is swept once the configured window passes and survives inside it', async () => {
    const shortConfig = freshConfig();
    shortConfig.set('device.capture.retentionHours', 1);
    const short = harness(shortConfig, join(root, 'state-retention-1h'));
    short.answer('once');
    short.returnCapture(true);

    const shortArtifact = requireArtifact(await short.run(CAMERA_REAR));
    expect(shortArtifact.expiresAt - shortArtifact.capturedAt).toBe(HOUR);
    const shortPath = short.service.artifacts.pathFor(shortArtifact);
    expect(existsSync(shortPath)).toBe(true);

    advanceClock(2 * HOUR);
    const shortSweep = await short.service.housekeeper.sweep('manual');
    expect(shortSweep.artifacts.removed.map((removal) => removal.reason)).toContain('expired');
    expect(await short.service.artifacts.list()).toHaveLength(0);
    expect(existsSync(shortPath)).toBe(false);

    // Stock 24h: the same two hours pass and the capture is still there.
    const stock = harness(freshConfig(), join(root, 'state-retention-24h'));
    stock.answer('once');
    stock.returnCapture(true);
    const stockArtifact = requireArtifact(await stock.run(CAMERA_REAR));
    expect(stockArtifact.expiresAt - stockArtifact.capturedAt).toBe(24 * HOUR);

    advanceClock(2 * HOUR);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.artifacts.removed).toHaveLength(0);
    expect((await stock.service.artifacts.read(stockArtifact.id)).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // device.capture.maxArtifacts
  // -------------------------------------------------------------------------

  test('device.capture.maxArtifacts: the count cap decides how many captures survive a sweep', async () => {
    const cappedConfig = freshConfig();
    cappedConfig.set('device.capture.maxArtifacts', 2);
    const capped = harness(cappedConfig, join(root, 'state-artifacts-2'));
    capped.answer('once');
    capped.returnCapture(true);

    const first = requireArtifact(await capped.run(CAMERA_REAR));
    advanceClock(MINUTE);
    const second = requireArtifact(await capped.run(SCREEN));
    advanceClock(MINUTE);
    const third = requireArtifact(await capped.run(CAMERA_REAR));
    const firstPath = capped.service.artifacts.pathFor(first);

    const sweep = await capped.service.housekeeper.sweep('manual');
    expect(sweep.artifacts.removed.map((removal) => removal.reason)).toEqual(['count-cap']);
    expect(sweep.artifacts.retained).toBe(2);
    expect((await capped.service.artifacts.list()).map((artifact) => artifact.id).sort())
      .toEqual([second.id, third.id].sort());
    // The oldest capture's bytes are gone from disk, not merely unindexed.
    expect(existsSync(firstPath)).toBe(false);

    // Stock 200: the same three captures all survive.
    const stock = harness(freshConfig(), join(root, 'state-artifacts-200'));
    stock.answer('once');
    stock.returnCapture(true);
    const kept = requireArtifact(await stock.run(CAMERA_REAR));
    advanceClock(MINUTE);
    await stock.run(SCREEN);
    advanceClock(MINUTE);
    await stock.run(CAMERA_REAR);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.artifacts.removed).toHaveLength(0);
    expect(stockSweep.artifacts.retained).toBe(3);
    expect(existsSync(stock.service.artifacts.pathFor(kept))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // device.capture.sweepIntervalMinutes
  // -------------------------------------------------------------------------

  test('device.capture.sweepIntervalMinutes: the configured minutes are the period of the sweep that actually reaps', async () => {
    const intervals = captureIntervals();
    try {
      const stock = harness(freshConfig(), join(root, 'state-sweep-stock'));
      await stock.service.startHousekeeping();
      expect(intervals.delays[intervals.delays.length - 1]).toBe(30 * MINUTE);
      stock.service.stopHousekeeping();

      const fastConfig = freshConfig();
      fastConfig.set('device.capture.sweepIntervalMinutes', 5);
      fastConfig.set('device.capture.retentionHours', 1);
      const fast = harness(fastConfig, join(root, 'state-sweep-fast'));
      fast.answer('once');
      fast.returnCapture(true);
      const artifact = requireArtifact(await fast.run(CAMERA_REAR));

      await fast.service.startHousekeeping();
      expect(intervals.delays[intervals.delays.length - 1]).toBe(5 * MINUTE);
      // The recovery sweep at start ran before the TTL, so the capture is still here.
      expect(await fast.service.artifacts.list()).toHaveLength(1);

      // Firing the registered periodic callback does real housekeeping: past the
      // TTL it reaps the capture without anyone calling sweep() by hand.
      advanceClock(2 * HOUR);
      intervals.fireLast();
      await waitFor(
        async () => (await fast.service.housekeeper.listDisclosures()).some((report) => report.trigger === 'periodic'),
        'the periodic sweep to run and disclose what it removed',
      );
      expect(existsSync(fast.service.artifacts.pathFor(artifact))).toBe(false);
      expect(await fast.service.artifacts.list()).toHaveLength(0);
      fast.service.stopHousekeeping();
    } finally {
      intervals.restore();
    }
  });

  // -------------------------------------------------------------------------
  // device.grants.expiryDays
  // -------------------------------------------------------------------------

  test('device.grants.expiryDays: a grant stops being honoured once the configured days pass', async () => {
    const shortConfig = freshConfig();
    shortConfig.set('device.grants.expiryDays', 1);
    const short = harness(shortConfig, join(root, 'state-expiry-1d'));
    short.answer('always');
    expect(label(await short.run(SCREEN))).toBe('ok:confirmed-always');

    advanceClock(2 * DAY);
    // Expired: never honoured, even before housekeeping gets to it.
    expect(await short.service.grants.list()).toHaveLength(0);
    const sweep = await short.service.housekeeper.sweep('manual');
    expect(sweep.grants.removed.map((removal) => removal.reason)).toContain('expired');
    expect(label(await short.run(SCREEN))).toBe('ok:confirmed-always');
    expect(short.grantEvaluations).toHaveLength(2);

    // Stock 90 days: the same two days pass and the grant still answers.
    const stock = harness(freshConfig(), join(root, 'state-expiry-90d'));
    stock.answer('always');
    expect(label(await stock.run(SCREEN))).toBe('ok:confirmed-always');
    advanceClock(2 * DAY);
    expect(label(await stock.run(SCREEN))).toBe('ok:existing-grant');
    expect(stock.grantEvaluations).toHaveLength(1);
    expect((await stock.service.housekeeper.sweep('manual')).grants.removed).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // device.grants.maxPerNode
  // -------------------------------------------------------------------------

  test('device.grants.maxPerNode: the per-node cap decides how many grants survive a sweep', async () => {
    const cappedConfig = freshConfig();
    cappedConfig.set('device.grants.maxPerNode', 2);
    const capped = harness(cappedConfig, join(root, 'state-grants-2'));
    capped.answer('always');

    expect(label(await capped.run(NOTIFY))).toBe('ok:confirmed-always');
    advanceClock(MINUTE);
    expect(label(await capped.run(VIBRATE))).toBe('ok:confirmed-always');
    advanceClock(MINUTE);
    expect(label(await capped.run(SCREEN))).toBe('ok:confirmed-always');
    expect(await capped.service.grants.list()).toHaveLength(3);

    const sweep = await capped.service.housekeeper.sweep('manual');
    expect(sweep.grants.removed.map((removal) => removal.reason)).toEqual(['per-node-cap']);
    expect(sweep.grants.retained).toBe(2);
    expect((await capped.service.grants.list()).map((grant) => grant.capabilityId).sort())
      .toEqual([SCREEN, VIBRATE].sort());
    // The reaped capability has to be asked about again.
    const before = capped.grantEvaluations.length;
    expect(label(await capped.run(NOTIFY))).toBe('ok:confirmed-always');
    expect(capped.grantEvaluations).toHaveLength(before + 1);

    // Stock 64: the same three grants are all kept.
    const stock = harness(freshConfig(), join(root, 'state-grants-64'));
    stock.answer('always');
    await stock.run(NOTIFY);
    advanceClock(MINUTE);
    await stock.run(VIBRATE);
    advanceClock(MINUTE);
    await stock.run(SCREEN);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.grants.removed).toHaveLength(0);
    expect(stockSweep.grants.retained).toBe(3);
    const stockApprovals = stock.grantEvaluations.length;
    expect(label(await stock.run(NOTIFY))).toBe('ok:existing-grant');
    expect(stock.grantEvaluations).toHaveLength(stockApprovals);
  });

  // -------------------------------------------------------------------------
  // device.grants.auditRetentionDays
  // -------------------------------------------------------------------------

  test('device.grants.auditRetentionDays: the ledger drops records older than the configured days at the next sweep', async () => {
    const shortConfig = freshConfig();
    shortConfig.set('device.grants.auditRetentionDays', 1);
    const short = harness(shortConfig, join(root, 'state-audit-1d'));
    short.answer('always');
    await short.run(NOTIFY);
    await short.run(NOTIFY);
    expect((await short.service.grants.listAudit()).length).toBeGreaterThanOrEqual(2);

    advanceClock(2 * DAY);
    const shortSweep = await short.service.housekeeper.sweep('manual');
    // The grant itself is still live (expiryDays is at its stock 90), so this is
    // the audit retention and nothing else deciding what is left.
    expect(shortSweep.grants.retained).toBe(1);
    expect(shortSweep.grants.auditTrimmed).toBeGreaterThanOrEqual(2);
    expect(await short.service.grants.listAudit()).toHaveLength(0);

    // Stock 30 days: the same records are still readable after the same two days.
    const stock = harness(freshConfig(), join(root, 'state-audit-30d'));
    stock.answer('always');
    await stock.run(NOTIFY);
    await stock.run(NOTIFY);
    const stockBefore = await stock.service.grants.listAudit();
    advanceClock(2 * DAY);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.grants.auditTrimmed).toBe(0);
    expect(await stock.service.grants.listAudit()).toHaveLength(stockBefore.length);
  });

  // -------------------------------------------------------------------------
  // Liveness: the composition hands over a live reader, not a snapshot
  // -------------------------------------------------------------------------

  test('a device.* change made while this daemon is running governs the next request', async () => {
    const configManager = freshConfig();
    const live = harness(configManager, join(root, 'state-live'));
    live.answer('once');
    expect(label(await live.run(CAMERA_REAR))).toBe('ok:confirmed-once');

    // Same service object, same stores, no rebuild and no restart.
    configManager.set('device.capabilities.mode', 'off');
    expect(label(await live.run(CAMERA_REAR))).toBe('refused:disabled-by-config');
    expect(live.dispatches).toHaveLength(1);

    configManager.set('device.capabilities.mode', 'honor-grants');
    configManager.set('device.capabilities.requestTimeoutSeconds', 15);
    expect(label(await live.run(CAMERA_REAR))).toBe('ok:confirmed-once');
    expect(live.dispatches[live.dispatches.length - 1]?.timeoutMs).toBe(15_000);
  });
});

describe('device.* posture: the wiring that makes the keys reachable', () => {
  test('the phone tool registered on a tool registry reaches this daemon\'s capability service', async () => {
    const h = harness(freshConfig(), join(root, 'state-tool'));
    h.answer('once');
    const registry = new ToolRegistry();
    registerDevicePhoneTool(registry, h.service);
    expect(registry.has('phone')).toBe(true);

    const result = await h.judgments.run(() => registry.execute('call-1', 'phone', { action: 'notify', title: 'hello', reason: 'wiring test' }));
    expect(result.success).toBe(true);
    // The request went through the real service and recorded Jev decision.
    expect(h.dispatches.map((dispatch) => dispatch.command)).toEqual([NOTIFY]);
    expect(h.grantEvaluations).toHaveLength(1);
  });

  test('a mode of off refuses the tool call as well, with the setting named', async () => {
    const offConfig = freshConfig();
    offConfig.set('device.capabilities.mode', 'off');
    const h = harness(offConfig, join(root, 'state-tool-off'));
    const registry = new ToolRegistry();
    registerDevicePhoneTool(registry, h.service);

    const result = await registry.execute('call-1', 'phone', { action: 'notify', title: 'hi', reason: 'wiring test' });
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('device.capabilities.mode');
    expect(h.dispatches).toHaveLength(0);
  });

  test('the devices.* verbs answer off this composition\'s runtime', async () => {
    const h = harness(freshConfig(), join(root, 'state-verbs'));
    h.answer('always');
    await h.run(NOTIFY);

    const nodes = (await h.gateway.invoke('devices.nodes.list', {
      methodId: 'devices.nodes.list',
      body: {},
    } as never)) as { nodes: Array<{ nodeId: string }>; policy?: { mode?: string } };
    expect(nodes.nodes.map((node) => node.nodeId)).toEqual(['phone-1']);

    const grants = (await h.gateway.invoke('devices.grants.list', {
      methodId: 'devices.grants.list',
      body: {},
    } as never)) as { grants: Array<{ capabilityId: string }> };
    expect(grants.grants.map((grant) => grant.capabilityId)).toEqual([NOTIFY]);
  });
});

// ---------------------------------------------------------------------------
// The composition root itself. Everything above proves the mapping and the
// feature; this proves THIS daemon's graph actually builds it, because a correct
// feature nobody composed is exactly the defect that was found here.
// ---------------------------------------------------------------------------

describe('device.* posture: composed by the runtime this daemon boots', () => {
  const fixture = useGatewayFixture({ hostSessions: false });

  test('createRuntimeServices exposes a device posture runtime reading its own config manager', () => {
    const services = fixture().services;
    expect(services.devicePosture).toBeTruthy();
    expect(services.devicePosture.readPolicy().mode).toBe('honor-grants');
    try {
      services.configManager.set('device.capabilities.mode', 'ask-every-time');
      services.configManager.set('device.capture.retentionHours', 2);
      // Read through the composed runtime, not through a copy of the mapping.
      expect(services.devicePosture.readPolicy().mode).toBe('ask-every-time');
      expect(services.devicePosture.capabilities.getPolicy().captureRetentionMs).toBe(2 * HOUR);
      expect(services.devicePosture.artifacts.getPolicy().retentionMs).toBe(2 * HOUR);
    } finally {
      services.configManager.reset('device.capabilities.mode');
      services.configManager.reset('device.capture.retentionHours');
    }
  });

  test('the devices.* verbs are handler-attached on the composed daemon catalog', async () => {
    const services = fixture().services;
    for (const methodId of ['devices.nodes.list', 'devices.grants.list', 'devices.grants.revoke', 'devices.housekeeping.run']) {
      expect(services.gatewayMethods.get(methodId), `${methodId} descriptor missing`).toBeTruthy();
      expect(services.gatewayMethods.hasHandler(methodId), `${methodId} has no handler`).toBe(true);
    }
    // Invoked end to end: an unhandled descriptor answers 501 rather than an
    // honest empty list, which is what "cataloged but dead" looked like here.
    const result = (await services.gatewayMethods.invoke('devices.nodes.list', {
      methodId: 'devices.nodes.list',
      body: {},
    } as never)) as { nodes: unknown[]; capabilities: unknown[] };
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.capabilities.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Completeness. The original defect was a whole family of keys that governed
// nothing; the way it stayed invisible was that nobody was counting.
// ---------------------------------------------------------------------------

describe('device.* posture: every key in the schema is accounted for', () => {
  test('the schema names no device.* key this file neither drives nor explains', () => {
    const schemaKeys = CONFIG_SCHEMA
      .map((setting) => setting.key as string)
      .filter((key) => key.startsWith('device.'))
      .sort();
    const accounted = new Set([...GOVERNED_KEYS, ...UNGOVERNED_HERE.map((entry) => entry.key)]);
    const unaccounted = schemaKeys.filter((key) => !accounted.has(key));
    expect(
      unaccounted,
      'These device.* settings are in the shared schema and this file neither drives them against '
      + 'the composition nor states what does. A posture key with no behaviour behind it is the '
      + 'defect this suite exists for; add a test, or add an UNGOVERNED_HERE entry saying what '
      + 'governs it and where that is checked.',
    ).toEqual([]);
    // And nothing in the pinned lists has left the schema behind.
    for (const key of accounted) expect(schemaKeys).toContain(key);
  });
});
