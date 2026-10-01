/**
 * device-settings-behavior.test.ts, behaviour verification for the twelve
 * `device.*` settings.
 *
 * Every test here drives ONE setting to at least two distinct values (the
 * schema default and a clearly different non-default), runs the real consuming
 * code, and asserts an outcome that differs between the two. Nothing in this
 * file asserts that a key exists, has a description, or round-trips through
 * ConfigManager, a test like that would still pass if the consuming code threw
 * the value away, which is exactly the failure this suite exists to prevent.
 *
 * WHOSE code this is, precisely, because it changed. The runtime under test is
 * the platform's `createDevicePostureRuntime`, the grants ledger, the capture
 * store, the capability service, the housekeeping cadence, and the mapping from
 * every `device.*` key onto them. That runtime is the DAEMON's now. This agent
 * composes no second copy of it: a second `createDevicePostureRuntime` writing
 * the same grants ledger would be the second-writer hazard this file exists
 * to prevent.
 *
 * So this file no longer holds "the agent's end" of the mapping, the agent has
 * no end of it, and asserting otherwise would be a claim this repo cannot back.
 * What it holds is the CONTRACT the agent's phone tool now depends on across a
 * process boundary: every refusal code, every authority path, every retention
 * window a `devices.capability.request` will come back with. If one of these
 * keys stops being honoured, the agent's phone tool silently starts doing
 * something else, and this is the suite that catches it.
 *
 * The agent's own end, that it forwards and re-decides nothing, is pinned in
 * agent-phone-tool.test.ts beside it.
 *
 * The config side is a real ConfigManager over a temp home directory, so every
 * value used here is one the shared schema actually accepts (enums from the enum
 * list, numbers inside their declared range).
 *
 * Two seams are stubbed, both of them the ones the service is designed to take
 * from outside:
 *  - the peer transport (`listPeers` / `invokePeer`), which records what the
 *    device was asked to do and answers with a contract-shaped result,
 *  - the approval bridge, which records the question that was put to the person
 *    and answers once / always / deny.
 * No real camera, clipboard, or location source is involved, and the clock is
 * driven with bun's `setSystemTime` rather than by waiting.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  DEVICE_CAPABILITY_CONTRACT_VERSION,
  DEVICE_CAPABILITY_IDS,
  getDeviceCapability,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import type {
  DeviceCapabilityId,
  DeviceCapabilityOutcome,
  DeviceCaptureArtifact,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type {
  DistributedPeerRecord,
  DistributedPendingWork,
  DistributedRuntimeManager,
} from '@/runtime/index.ts';
import {
  createDevicePostureRuntime,
  DEVICE_NODE_ANNOUNCEMENT_KEY,
  type DevicePostureRuntime,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_TIME = Date.UTC(2026, 6, 25, 12, 0, 0);

const CAMERA_REAR: DeviceCapabilityId = 'device.camera.rear.capture';
const CAMERA_FRONT: DeviceCapabilityId = 'device.camera.front.capture';
const SCREEN: DeviceCapabilityId = 'device.screen.capture';
const LOCATION_COARSE: DeviceCapabilityId = 'device.location.coarse';
const LOCATION_PRECISE: DeviceCapabilityId = 'device.location.precise';
const CLIPBOARD_READ: DeviceCapabilityId = 'device.clipboard.read';
const CLIPBOARD_WRITE: DeviceCapabilityId = 'device.clipboard.write';
const NOTIFY: DeviceCapabilityId = 'device.command.notify';
const VIBRATE: DeviceCapabilityId = 'device.command.vibrate';

/** Deterministic capture payload, base64 the way a node would send it. */
const CAPTURE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const CAPTURE_BASE64 = Buffer.from(CAPTURE_BYTES).toString('base64');

let root = '';
let clock = BASE_TIME;
let homeSeq = 0;

beforeEach(() => {
  root = makeProjectTempDir('gv-agent-device-settings');
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

/** A real ConfigManager over a fresh temp home, built the way the agent builds it. */
function freshConfig(): ConfigManager {
  homeSeq += 1;
  const homeDir = join(root, `home-${homeSeq}`);
  mkdirSync(homeDir, { recursive: true });
  return new ConfigManager({ homeDir, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT });
}

/** A paired peer carrying a device-node announcement for every catalog capability. */
function devicePeer(nodeId = 'phone-1'): DistributedPeerRecord {
  return {
    id: nodeId,
    kind: 'device',
    label: 'Test phone',
    requestedId: nodeId,
    platform: 'android',
    version: '1.0.0',
    capabilities: [...DEVICE_CAPABILITY_IDS],
    commands: [],
    status: 'connected',
    pairedAt: BASE_TIME,
    tokens: [],
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

/** One ask that reached the approval bridge. */
interface ApprovalCall {
  readonly request: PermissionPromptRequest;
  readonly timeoutMs: number | undefined;
  readonly metadata: Record<string, unknown> | undefined;
}

/** One request that reached the peer transport. */
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
  readonly approvals: ApprovalCall[];
  readonly dispatches: DispatchCall[];
  /** What the person answers the next time they are asked. */
  answer(decision: Answer): void;
  /** Whether the node returns capture bytes with its result. */
  returnCapture(enabled: boolean): void;
  run(capabilityId: DeviceCapabilityId, reason?: string): Promise<DeviceCapabilityOutcome>;
}

function payloadTimeout(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>).timeoutMs;
  return typeof value === 'number' ? value : undefined;
}

function harness(configManager: ConfigManager, stateDirectory: string): Harness {
  const approvals: ApprovalCall[] = [];
  const dispatches: DispatchCall[] = [];
  const peers = [devicePeer()];
  let answer: Answer = 'always';
  let capture = false;

  const transport = {
    listPeers(kind?: string): DistributedPeerRecord[] {
      return peers.filter((peer) => kind === undefined || peer.kind === kind);
    },
    async invokePeer(input: {
      readonly peerId: string;
      readonly command: string;
      readonly payload?: unknown | undefined;
      readonly waitMs?: number | undefined;
      readonly timeoutMs?: number | undefined;
    }): Promise<{ work: DistributedPendingWork; completed: boolean }> {
      dispatches.push({
        peerId: input.peerId,
        command: input.command,
        waitMs: input.waitMs,
        timeoutMs: input.timeoutMs,
        payloadTimeoutMs: payloadTimeout(input.payload),
      });
      const work: DistributedPendingWork = {
        id: `work-${dispatches.length}`,
        peerId: input.peerId,
        peerKind: 'device',
        type: 'device.capability',
        command: input.command,
        priority: 'normal',
        status: 'completed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: Date.now(),
        queuedBy: 'test',
        metadata: {},
        result: {
          contractVersion: DEVICE_CAPABILITY_CONTRACT_VERSION,
          capabilityId: input.command,
          ok: true,
          data: { served: input.command },
          ...(capture ? { mediaBase64: CAPTURE_BASE64, mediaType: 'image/png' } : {}),
        },
      };
      return { work, completed: true };
    },
  };

  const service = createDevicePostureRuntime({
    // The runtime reaches exactly two members of a peer transport, listPeers
    // and invokePeer, so the stub implements those two and is cast once here.
    // A real DistributedRuntimeManager would need a live peer process to claim
    // and complete the work item.
    transport: transport as unknown as DistributedRuntimeManager,
    actor: 'daemon:phone-runtime',
    approvals: {
      async requestApproval(input): Promise<PermissionPromptDecision> {
        approvals.push({
          request: input.request,
          timeoutMs: input.timeoutMs,
          metadata: input.metadata,
        });
        if (answer === 'deny') return { approved: false, reason: 'not right now' };
        if (answer === 'always') return { approved: true, rememberTier: 'tool' };
        return { approved: true };
      },
    },
    config: configManager,
    stateDirectory,
  });

  return {
    service,
    approvals,
    dispatches,
    answer(decision: Answer): void {
      answer = decision;
    },
    returnCapture(enabled: boolean): void {
      capture = enabled;
    },
    run(capabilityId: DeviceCapabilityId, reason = 'behaviour test'): Promise<DeviceCapabilityOutcome> {
      return service.capabilities.request({
        nodeId: 'phone-1',
        capabilityId,
        reason,
        input: minimalCapabilityInput(capabilityId),
      });
    },
  };
}

/**
 * The smallest input a capability's own contract accepts.
 *
 * Read from the catalog rather than written out per capability: `notify` needs
 * a title and `clipboard.write` needs the text, and a hand-written fixture that
 * omits a field the contract later marks required refuses as invalid-input,
 * which reads as a settings-behaviour failure and is not one. Deriving it means
 * a new required field is satisfied here the moment the contract declares it.
 */
function minimalCapabilityInput(capabilityId: DeviceCapabilityId): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of getDeviceCapability(capabilityId)?.inputFields ?? []) {
    if (!field.required) continue;
    input[field.name] = field.type === 'number' ? 1 : `behaviour test ${field.name}`;
  }
  return input;
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
 * out a real interval. Returns real (unref-able, clearable) timers so
 * DeviceHousekeeper.start/stop behave exactly as they do in production.
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
  // The DOM/Bun setInterval type is overloaded; the shim only needs the
  // (callback, delay) form the housekeeper uses, so it is cast once.
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

describe('device.* settings: behaviour', () => {
  // -------------------------------------------------------------------------
  // device.capabilities.mode
  // -------------------------------------------------------------------------

  test('device.capabilities.mode: off refuses every request with disabled-by-config, honor-grants serves it', async () => {
    const stock = harness(freshConfig(), join(root, 'state-stock'));
    stock.answer('once');
    const served = await stock.run(CAMERA_REAR);
    expect(label(served)).toBe('ok:confirmed-once');
    expect(stock.dispatches).toHaveLength(1);

    const offConfig = freshConfig();
    offConfig.set('device.capabilities.mode', 'off');
    const off = harness(offConfig, join(root, 'state-off'));
    off.answer('once');

    for (const capabilityId of [CAMERA_REAR, LOCATION_COARSE, CLIPBOARD_WRITE, NOTIFY] as const) {
      const outcome = await off.run(capabilityId);
      expect(label(outcome)).toBe('refused:disabled-by-config');
    }
    // Turned off means nothing reached the phone and nobody was asked.
    expect(off.dispatches).toHaveLength(0);
    expect(off.approvals).toHaveLength(0);
  });

  test('device.capabilities.mode: ask-every-time asks again even with a live grant, honor-grants uses the grant', async () => {
    const shared = join(root, 'state-mode-shared');

    // honor-grants (the schema default): the durable grant answers the second request.
    const honor = harness(freshConfig(), shared);
    honor.answer('always');
    expect(label(await honor.run(SCREEN))).toBe('ok:confirmed-always');
    expect(honor.approvals).toHaveLength(1);
    expect(label(await honor.run(SCREEN))).toBe('ok:existing-grant');
    expect(honor.approvals).toHaveLength(1);

    // Same grant on disk, same capability, same node, only the setting differs.
    const askConfig = freshConfig();
    askConfig.set('device.capabilities.mode', 'ask-every-time');
    const ask = harness(askConfig, shared);
    ask.answer('once');
    expect(await ask.service.grants.list()).toHaveLength(1);

    expect(label(await ask.run(SCREEN))).toBe('ok:confirmed-once');
    expect(ask.approvals).toHaveLength(1);
    expect(label(await ask.run(SCREEN))).toBe('ok:confirmed-once');
    expect(ask.approvals).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // device.capabilities.allowAlwaysOffer
  // -------------------------------------------------------------------------

  test('device.capabilities.allowAlwaysOffer: every-capability stores a durable grant for an elevated capability, standard-only refuses to', async () => {
    const every = harness(freshConfig(), join(root, 'state-every'));
    every.answer('always');
    expect(label(await every.run(CAMERA_FRONT))).toBe('ok:confirmed-always');
    expect(every.approvals[0].request.rememberOptions).toBeDefined();
    expect(every.approvals[0].metadata?.allowAlwaysOffered).toBe(true);
    expect(await every.service.grants.list()).toHaveLength(1);
    // The stored grant is what makes the second request silent.
    expect(label(await every.run(CAMERA_FRONT))).toBe('ok:existing-grant');
    expect(every.approvals).toHaveLength(1);

    const standardConfig = freshConfig();
    standardConfig.set('device.capabilities.allowAlwaysOffer', 'standard-only');
    const standard = harness(standardConfig, join(root, 'state-standard'));
    standard.answer('always');
    // Front camera is elevated: the prompt must not offer a durable grant, and
    // an "always" answer must not be turned into one.
    expect(label(await standard.run(CAMERA_FRONT))).toBe('ok:confirmed-once');
    expect(standard.approvals[0].request.rememberOptions).toBeUndefined();
    expect(standard.approvals[0].metadata?.allowAlwaysOffered).toBe(false);
    expect(await standard.service.grants.list()).toHaveLength(0);
    expect(label(await standard.run(CAMERA_FRONT))).toBe('ok:confirmed-once');
    expect(standard.approvals).toHaveLength(2);
  });

  test('device.capabilities.allowAlwaysOffer: standard-only still grants a standard-sensitivity capability, never grants nothing at all', async () => {
    const standardConfig = freshConfig();
    standardConfig.set('device.capabilities.allowAlwaysOffer', 'standard-only');
    const standard = harness(standardConfig, join(root, 'state-standard-notify'));
    standard.answer('always');
    // notify is standard sensitivity, so standard-only leaves it grantable,
    // the setting discriminates by sensitivity rather than switching grants off.
    expect(label(await standard.run(NOTIFY))).toBe('ok:confirmed-always');
    expect(standard.approvals[0].metadata?.allowAlwaysOffered).toBe(true);
    expect(await standard.service.grants.list()).toHaveLength(1);

    const neverConfig = freshConfig();
    neverConfig.set('device.capabilities.allowAlwaysOffer', 'never');
    const never = harness(neverConfig, join(root, 'state-never'));
    never.answer('always');
    expect(label(await never.run(NOTIFY))).toBe('ok:confirmed-once');
    expect(label(await never.run(VIBRATE))).toBe('ok:confirmed-once');
    expect(never.approvals[0].metadata?.allowAlwaysOffered).toBe(false);
    expect(never.approvals[0].request.rememberOptions).toBeUndefined();
    expect(await never.service.grants.list()).toHaveLength(0);
    // Nothing durable was stored, so every later request is asked again.
    expect(label(await never.run(NOTIFY))).toBe('ok:confirmed-once');
    expect(never.approvals).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // device.capabilities.requestTimeoutSeconds
  // -------------------------------------------------------------------------

  test('device.capabilities.requestTimeoutSeconds: the configured seconds are the deadline on the dispatch, the wire payload, and the prompt', async () => {
    const stock = harness(freshConfig(), join(root, 'state-timeout-stock'));
    stock.answer('once');
    await stock.run(NOTIFY);
    expect(stock.dispatches[0].waitMs).toBe(60_000);
    expect(stock.dispatches[0].timeoutMs).toBe(60_000);
    expect(stock.dispatches[0].payloadTimeoutMs).toBe(60_000);
    expect(stock.approvals[0].timeoutMs).toBe(60_000);

    const shortConfig = freshConfig();
    shortConfig.set('device.capabilities.requestTimeoutSeconds', 5);
    const short = harness(shortConfig, join(root, 'state-timeout-short'));
    short.answer('once');
    await short.run(NOTIFY);
    expect(short.dispatches[0].waitMs).toBe(5_000);
    expect(short.dispatches[0].timeoutMs).toBe(5_000);
    expect(short.dispatches[0].payloadTimeoutMs).toBe(5_000);
    expect(short.approvals[0].timeoutMs).toBe(5_000);
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

    const refused = await coarse.run(LOCATION_PRECISE);
    expect(label(refused)).toBe('refused:disabled-by-config');
    expect(coarse.dispatches).toHaveLength(0);
    // Only the precise fix is gated; the approximate one is untouched.
    expect(label(await coarse.run(LOCATION_COARSE))).toBe('ok:confirmed-once');
    expect(coarse.dispatches).toHaveLength(1);
  });

  test('device.location.precision: ask-precise keeps precise location working but stores no durable grant for it', async () => {
    const askConfig = freshConfig();
    askConfig.set('device.location.precision', 'ask-precise');
    const ask = harness(askConfig, join(root, 'state-loc-ask'));
    ask.answer('always');

    expect(label(await ask.run(LOCATION_PRECISE))).toBe('ok:confirmed-once');
    expect(ask.approvals[0].metadata?.allowAlwaysOffered).toBe(false);
    expect(await ask.service.grants.list()).toHaveLength(0);
    expect(label(await ask.run(LOCATION_PRECISE))).toBe('ok:confirmed-once');
    expect(ask.approvals).toHaveLength(2);

    // Approximate location under the same setting is still grantable, so this
    // is a gate on the precise fix and not a blanket "never remember".
    expect(label(await ask.run(LOCATION_COARSE))).toBe('ok:confirmed-always');
    expect(await ask.service.grants.list()).toHaveLength(1);

    // Under the stock value the precise fix is grantable too.
    const stock = harness(freshConfig(), join(root, 'state-loc-grantable'));
    stock.answer('always');
    expect(label(await stock.run(LOCATION_PRECISE))).toBe('ok:confirmed-always');
    expect(label(await stock.run(LOCATION_PRECISE))).toBe('ok:existing-grant');
    expect(stock.approvals).toHaveLength(1);
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
    expect(off.approvals).toHaveLength(0);
    // Putting text ON the clipboard is a different capability and stays available.
    expect(label(await off.run(CLIPBOARD_WRITE))).toBe('ok:confirmed-once');
    expect(off.dispatches).toHaveLength(1);
  });

  test('device.clipboard.readMode: ask-only keeps clipboard reads working but stores no durable grant', async () => {
    const askConfig = freshConfig();
    askConfig.set('device.clipboard.readMode', 'ask-only');
    const ask = harness(askConfig, join(root, 'state-clip-ask'));
    ask.answer('always');

    expect(label(await ask.run(CLIPBOARD_READ))).toBe('ok:confirmed-once');
    expect(ask.approvals[0].metadata?.allowAlwaysOffered).toBe(false);
    expect(await ask.service.grants.list()).toHaveLength(0);
    expect(label(await ask.run(CLIPBOARD_READ))).toBe('ok:confirmed-once');
    expect(ask.approvals).toHaveLength(2);

    // Stock value: the same capability is grantable and the second read is silent.
    const stock = harness(freshConfig(), join(root, 'state-clip-grantable'));
    stock.answer('always');
    expect(label(await stock.run(CLIPBOARD_READ))).toBe('ok:confirmed-always');
    expect(label(await stock.run(CLIPBOARD_READ))).toBe('ok:existing-grant');
    expect(stock.approvals).toHaveLength(1);
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
    expect((await short.service.artifacts.read(shortArtifact.id)).ok).toBe(false);

    // Stock 24h: the same two hours pass and the capture is still there.
    const stock = harness(freshConfig(), join(root, 'state-retention-24h'));
    stock.answer('once');
    stock.returnCapture(true);
    const stockArtifact = requireArtifact(await stock.run(CAMERA_REAR));
    expect(stockArtifact.expiresAt - stockArtifact.capturedAt).toBe(24 * HOUR);
    const stockPath = stock.service.artifacts.pathFor(stockArtifact);

    advanceClock(2 * HOUR);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.artifacts.removed).toHaveLength(0);
    expect(await stock.service.artifacts.list()).toHaveLength(1);
    expect(existsSync(stockPath)).toBe(true);
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

    requireArtifact(await capped.run(CAMERA_REAR));
    advanceClock(MINUTE);
    requireArtifact(await capped.run(SCREEN));
    advanceClock(MINUTE);
    requireArtifact(await capped.run(CAMERA_REAR));

    // Same rule as the grants cap below: which capture is reaped is asserted
    // against the `capturedAt` the store recorded, not against the order these
    // calls were made in.
    const retainedBefore = await capped.service.artifacts.list();
    expect(retainedBefore).toHaveLength(3);
    const oldestFirst = [...retainedBefore].sort((a, b) => a.capturedAt - b.capturedAt);
    const reapedArtifact = oldestFirst[0]!;
    const reapedPath = capped.service.artifacts.pathFor(reapedArtifact);
    const expectedSurvivors = oldestFirst.slice(1).map((artifact) => artifact.id).sort();

    const sweep = await capped.service.housekeeper.sweep('manual');
    expect(capped.service.artifacts.getPolicy().maxArtifacts).toBe(2);
    expect(sweep.artifacts.removed).toHaveLength(1);
    expect(sweep.artifacts.removed[0]?.reason).toBe('count-cap');
    expect(sweep.artifacts.removed[0]?.artifactId).toBe(reapedArtifact.id);
    expect(sweep.artifacts.retained).toBe(2);
    const survivors = (await capped.service.artifacts.list()).map((artifact) => artifact.id).sort();
    expect(survivors).toEqual(expectedSurvivors);
    // The reaped capture's bytes are gone from disk, not merely unindexed.
    expect(existsSync(reapedPath)).toBe(false);

    // Stock 200: the same three captures all survive.
    const stock = harness(freshConfig(), join(root, 'state-artifacts-200'));
    stock.answer('once');
    stock.returnCapture(true);
    const keptOne = requireArtifact(await stock.run(CAMERA_REAR));
    advanceClock(MINUTE);
    await stock.run(SCREEN);
    advanceClock(MINUTE);
    await stock.run(CAMERA_REAR);

    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.artifacts.removed).toHaveLength(0);
    expect(stockSweep.artifacts.retained).toBe(3);
    expect(existsSync(stock.service.artifacts.pathFor(keptOne))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // device.capture.sweepIntervalMinutes
  // -------------------------------------------------------------------------

  test('device.capture.sweepIntervalMinutes: the configured minutes are the period of the housekeeping sweep that actually reaps', async () => {
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
        async () => (await fast.service.housekeeper.listDisclosures())
          .some((report) => report.trigger === 'periodic'),
        'the periodic sweep to run and disclose what it removed',
      );
      const periodic = (await fast.service.housekeeper.listDisclosures())
        .filter((report) => report.trigger === 'periodic');
      expect(periodic[periodic.length - 1]?.artifacts.removed.map((removal) => removal.reason))
        .toContain('expired');
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
    expect(short.approvals).toHaveLength(1);

    advanceClock(2 * DAY);
    // Expired: never honoured, even before housekeeping gets to it.
    expect(await short.service.grants.list()).toHaveLength(0);
    const sweep = await short.service.housekeeper.sweep('manual');
    expect(sweep.grants.removed.map((removal) => removal.reason)).toContain('expired');
    // With no live grant left, the capability is asked about again.
    expect(label(await short.run(SCREEN))).toBe('ok:confirmed-always');
    expect(short.approvals).toHaveLength(2);

    // Stock 90 days: the same two days pass and the grant still answers.
    const stock = harness(freshConfig(), join(root, 'state-expiry-90d'));
    stock.answer('always');
    expect(label(await stock.run(SCREEN))).toBe('ok:confirmed-always');
    advanceClock(2 * DAY);
    expect(await stock.service.grants.list()).toHaveLength(1);
    expect(label(await stock.run(SCREEN))).toBe('ok:existing-grant');
    expect(stock.approvals).toHaveLength(1);
    const stockSweep = await stock.service.housekeeper.sweep('manual');
    expect(stockSweep.grants.removed).toHaveLength(0);
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

    // WHICH grant is reaped is asserted against the timestamps the store
    // actually recorded, not against the order these three calls were made in.
    // The clock this file drives is process-wide state, and the reap order is
    // the store's own `grantedAt` ordering, reading it back keeps the assertion
    // about the cap (the behaviour under test) instead of about this file's
    // clock still being the only thing writing timestamps. A stable sort over
    // the stored order reproduces the store's own choice exactly, including how
    // it breaks a tie.
    const recorded = await capped.service.grants.list();
    expect(recorded).toHaveLength(3);
    const oldestFirst = [...recorded].sort((a, b) => a.grantedAt - b.grantedAt);
    const reapedGrant = oldestFirst[0]!;
    const expectedSurvivors = oldestFirst.slice(1).map((grant) => grant.capabilityId).sort();

    const sweep = await capped.service.housekeeper.sweep('manual');
    // The cap is what capped: one grant went, for the cap's reason, and the node
    // is left holding exactly the configured number.
    expect(capped.service.grants.getPolicy().maxGrantsPerNode).toBe(2);
    expect(sweep.grants.removed).toHaveLength(1);
    expect(sweep.grants.removed[0]?.reason).toBe('per-node-cap');
    expect(sweep.grants.removed[0]?.capabilityId).toBe(reapedGrant.capabilityId);
    expect(sweep.grants.removed[0]?.nodeId).toBe('phone-1');
    expect(sweep.grants.retained).toBe(2);
    const survivingGrants = await capped.service.grants.list();
    expect(survivingGrants.map((grant) => grant.capabilityId).sort()).toEqual(expectedSurvivors);
    expect(survivingGrants.filter((grant) => grant.nodeId === 'phone-1')).toHaveLength(2);
    // The reaped capability, whichever one it was, has to be asked about again.
    const approvalsBefore = capped.approvals.length;
    expect(label(await capped.run(reapedGrant.capabilityId))).toBe('ok:confirmed-always');
    expect(capped.approvals).toHaveLength(approvalsBefore + 1);

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
    const stockApprovals = stock.approvals.length;
    expect(label(await stock.run(NOTIFY))).toBe('ok:existing-grant');
    expect(stock.approvals).toHaveLength(stockApprovals);
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
    const shortBefore = await short.service.grants.listAudit();
    expect(shortBefore.length).toBeGreaterThanOrEqual(2);

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
  // Liveness: the agent hands over a live configuration reader, not a snapshot
  // -------------------------------------------------------------------------

  test('a device.* change made while the agent is running governs the next request', async () => {
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
