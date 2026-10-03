/**
 * power-keep-awake-composition.test.ts
 *
 * Item: keep-awake reaches the daemon.
 *
 * This repo's settings toggle used to live-apply ONLY to the agent's own
 * in-process PowerManager via a bespoke onSettingApplied special case in
 * ui-openers.ts. Two things replace that:
 *
 *  1. services.ts now wires wireRuntimePower's `subscribeConfig` option (the
 *     SDK's own PowerManager config subscription), so ANY power.keepAwake
 *     config change, from the settings modal, a CLI flag, or an external
 *     settings.json edit reaching configManager via watchConfigFiles(),
 *     flips the real LOCAL inhibitor with no bespoke call site needed.
 *  2. services.ts separately subscribes to power.keepAwake and forwards the
 *     toggle to an ADOPTED daemon over the wire (power-keep-awake-remote.ts),
 *     since power.keepAwake is a surface-local config key (not shared-tier)
 *     and a local-only apply would never survive this agent process exiting.
 *
 * This test pins (1) end-to-end through the real composition root; (2) is
 * covered per-topology in agent/power-keep-awake-remote.test.ts (the
 * network-facing half is intentionally unit-tested there rather than through
 * a real daemon here).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createHostPowerSeam } from '@goodvibes-jev/engine/sdk/platform/power';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('power.keepAwake local live-apply (config-subscription path)', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeServices(): RuntimeServices {
    root = makeProjectTempDir('goodvibes-agent-power-composition');
    const workingDir = join(root, 'workspace');
    const homeDir = join(root, 'home');
    const configDir = join(homeDir, '.goodvibes', 'agent');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir, homeDir, configDir });
    return createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
    });
  }

  test('a config write (mirroring the settings modal\'s setDynamic call) flips the real PowerManager state, with no bespoke call site', async () => {
    const services = makeServices();
    try {
      expect(services.powerManager.getState().keepAwake.enabled).toBe(false);

      // wireRuntimePower's manager.start() (async: it reaps orphan inhibitors
      // over the real platform seam, THEN registers the config subscription)
      // is fire-and-forget from services.ts, exactly as the SDK composition
      // root does it. Give start() room to finish registering before driving
      // the toggle, so the test exercises the live-subscription path itself
      // rather than racing it, a config write issued before registration
      // completes cannot be seen by a subscription that does not exist yet.
      await new Promise((resolve) => setTimeout(resolve, 500));

      async function waitForKeepAwake(expected: boolean): Promise<boolean> {
        const deadline = Date.now() + 2000;
        let observed = services.powerManager.getState().keepAwake.enabled;
        while (observed !== expected && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          observed = services.powerManager.getState().keepAwake.enabled;
        }
        return observed;
      }

      // This is exactly what the settings modal's default apply path does,
      // NOT a direct services.powerManager.setKeepAwake(...) call. The old
      // onSettingApplied special case that used to bridge these two is gone
      // from ui-openers.ts; this config write alone must now reach the
      // PowerManager through wireRuntimePower's subscribeConfig option.
      services.configManager.setDynamic('power.keepAwake', true);
      expect(await waitForKeepAwake(true)).toBe(true);

      services.configManager.setDynamic('power.keepAwake', false);
      expect(await waitForKeepAwake(false)).toBe(false);
    } finally {
      services.providerRegistry.stopWatching();
      services.configManager.stopWatchingConfigFiles();
    }
  });

  test('a test-constructed runtime (no powerSeam) defaults to the NON-spawning unavailable seam', () => {
    // SDK 1.9.0 moved seam selection to an explicit opt-in: createRuntimeServices
    // now defaults an ABSENT powerSeam to the SDK's "unavailable" no-spawn seam,
    // so a test-constructed runtime never spawns systemd-inhibit inhibitors or a
    // dbus-monitor sleep-edge watcher. makeServices() passes no powerSeam, so the
    // composed PowerManager must report the honest 'unavailable (...)' platform,
    // yet keep-awake state still flips (the live-apply tests above), because the
    // PowerManager tracks the enabled intent independently of seam availability.
    const services = makeServices();
    try {
      expect(services.powerManager.getState().platform.startsWith('unavailable')).toBe(true);
    } finally {
      services.providerRegistry.stopWatching();
      services.configManager.stopWatchingConfigFiles();
    }
  });

  test('the host power seam opt-in wires the real platform, and constructing it spawns nothing', () => {
    // The live-seam WIRING pin: createHostPowerSeam() is exactly what the
    // embedded interactive runtime (bootstrap-core.ts) passes as powerSeam to
    // own the sleep edge. Constructing the seam is inert, it spawns nothing
    // until inhibit()/onPrepareForSleep()/reapOrphans() run, so this asserts
    // the WIRING (the platform label the opt-in selects), never a spawn. It is
    // deliberately NOT wired through wireRuntimePower here, so the suite holds
    // no live inhibitor or sleep-edge watcher on account of this assertion.
    const seam = createHostPowerSeam();
    if (process.platform === 'linux') {
      expect(seam.platform).toBe('linux-logind');
    } else {
      expect(seam.platform.startsWith('unavailable')).toBe(true);
    }
  });

  test('an external settings.json edit (no in-process call at all) also reaches the PowerManager, via watchConfigFiles + subscribeConfig', async () => {
    const services = makeServices();
    try {
      expect(services.powerManager.getState().keepAwake.enabled).toBe(false);

      // Simulate an external process editing the surface's settings.json
      // directly, the same path an externally-adopted daemon sharing this
      // config file (or a hand edit) would take.
      const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
      const settingsPath = services.configManager.getConfigPath();
      const onDisk: Record<string, unknown> = existsSync(settingsPath)
        ? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>)
        : {};
      onDisk.power = { ...(onDisk.power as Record<string, unknown> | undefined), keepAwake: true };
      writeFileSync(settingsPath, JSON.stringify(onDisk, null, 2), 'utf-8');

      const deadline = Date.now() + 2000;
      let enabled = services.powerManager.getState().keepAwake.enabled;
      while (!enabled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        enabled = services.powerManager.getState().keepAwake.enabled;
      }
      expect(enabled).toBe(true);
    } finally {
      services.providerRegistry.stopWatching();
      services.configManager.stopWatchingConfigFiles();
    }
  });
});
