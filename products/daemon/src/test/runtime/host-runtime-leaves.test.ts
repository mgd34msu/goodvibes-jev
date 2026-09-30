import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { GatewayMethodCatalog, type SharedSessionRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { AgentManager, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ArchivableProcessRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { RuntimeEventBus, type ShellPathService } from '../../runtime/index.js';
import { createDevicePostureServices, DAEMON_DEVICE_ACTOR } from '../../runtime/device-posture-composition.js';
import { createTriggerServices } from '../../runtime/trigger-services.js';
import { wireFleetNeedsInputPush } from '../../runtime/fleet-needs-input-push.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function config(values: Record<string, unknown>): ConfigManager {
  return { get: (key: string) => values[key] } as unknown as ConfigManager;
}
function unexpected(): never { throw new Error('Unexpected fixture host effect'); }

test('device composition binds the real gateway family without opening a device or starting housekeeping', () => {
  const root = makeOwnedTempDir('daemon-device-composition');
  const stateDirectory = join(root, 'device-state');
  const gatewayMethods = new GatewayMethodCatalog();
  const { devicePosture } = createDevicePostureServices({
    configManager: config({}), stateDirectory, gatewayMethods,
    distributedRuntime: { listPeers: () => [], invokePeer: unexpected },
    approvals: { requestApproval: unexpected },
  });
  expect(devicePosture.actor).toBe(DAEMON_DEVICE_ACTOR);
  expect(devicePosture.listNodes()).toEqual([]);
  expect(existsSync(stateDirectory)).toBe(false);
  for (const id of ['devices.nodes.list', 'devices.capability.request', 'devices.artifacts.list', 'devices.artifacts.read', 'devices.grants.list', 'devices.grants.revoke', 'devices.housekeeping.run']) {
    expect(gatewayMethods.hasHandler(id)).toBe(true);
  }
  devicePosture.stopHousekeeping();
});

test('device policies read changed owner settings without rebuilding or dispatching a capability', () => {
  const values: Record<string, unknown> = { 'device.capabilities.mode': 'off', 'device.capabilities.requestTimeoutSeconds': 11 };
  const { devicePosture } = createDevicePostureServices({
    configManager: config(values), stateDirectory: join(makeOwnedTempDir('daemon-device-policy'), 'state'),
    distributedRuntime: { listPeers: () => [], invokePeer: unexpected }, approvals: { requestApproval: unexpected },
  });
  expect(devicePosture.readPolicy()).toMatchObject({ mode: 'off', requestTimeoutMs: 11_000 });
  values['device.capabilities.mode'] = 'ask-every-time';
  values['device.capabilities.requestTimeoutSeconds'] = 19;
  expect(devicePosture.readPolicy()).toMatchObject({ mode: 'ask-every-time', requestTimeoutMs: 19_000 });
  devicePosture.stopHousekeeping();
});

test('trigger composition reads its live enable flag and preserves the scoped store without running a probe', async () => {
  const root = makeOwnedTempDir('daemon-trigger-composition');
  const values: Record<string, unknown> = { 'watchers.triggers.enabled': false };
  const manager = createTriggerServices({
    configManager: config(values), surfaceRoot: 'tui',
    shellPaths: { resolveProjectPath: (...parts: string[]) => join(root, ...parts) } as unknown as ShellPathService,
    agentManager: { spawn: unexpected } as unknown as AgentManager,
    processManager: { spawnArgv: unexpected } as unknown as ProcessManager,
    sessionBroker: { getSession: () => null },
  });
  const definition = {
    id: 'fixture-trigger', label: 'Fixture trigger', createdAt: 0,
    spec: { kind: 'condition', probe: { kind: 'http', url: 'https://fixture.invalid/never-requested' }, extract: { kind: 'jsonpath', path: '$.count' }, rule: { kind: 'threshold', direction: 'above', enter: 2, exit: 1 }, intervalMs: 30_000 },
    action: { kind: 'agent-turn' },
  };
  try {
    expect(existsSync(join(root, 'tui', 'triggers.json'))).toBe(false);
    await expect(manager.create(definition)).rejects.toThrow('trigger family is off');
    values['watchers.triggers.enabled'] = true;
    const record = await manager.create(definition);
    expect(record.definition.id).toBe('fixture-trigger');
    expect(existsSync(join(root, 'tui', 'triggers.json'))).toBe(true);
    values['watchers.triggers.enabled'] = false;
    await expect(manager.create({ ...definition, id: 'second-fixture' })).rejects.toThrow('trigger family is off');
  } finally { manager.shutdown(); }
});

test('fleet notice wiring attaches the shared snapshot bridge and reads fresh surface presence per call', () => {
  let subscriptions = 0;
  let present: SharedSessionRecord | null = null;
  const runtimeBus = new RuntimeEventBus();
  const deps = wireFleetNeedsInputPush({
    registry: { subscribe() { subscriptions++; return () => {}; } } as unknown as ArchivableProcessRegistry,
    runtimeBus, sessionBroker: { getSession: () => present },
  });
  expect(subscriptions).toBe(1);
  expect(deps.runtimeBus).toBe(runtimeBus);
  expect(deps.sessionPresence.isAttached('fixture')).toBe(false);
  present = { participants: [{ lastSeenAt: Date.now() }] } as unknown as SharedSessionRecord;
  expect(deps.sessionPresence.isAttached('fixture')).toBe(true);
  present = { participants: [{ lastSeenAt: 0 }] } as unknown as SharedSessionRecord;
  expect(deps.sessionPresence.isAttached('fixture')).toBe(false);
});
