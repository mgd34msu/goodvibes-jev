/**
 * wake-config.ts, `config.get`'s nested tree read as the resolver's flat keys, and
 * the honest capability answers for a browser tab.
 *
 * The path reader matters more than it looks: returning `undefined` for a key the
 * tree does not hold is what makes the resolver apply the SHIPPED default instead of
 * a zero. A reader that answered `null` or 0 for a missing key would resolve a
 * partially-loaded tab into a detector with every threshold at 0.
 */
import { describe, expect, test } from 'bun:test';
import { WAKE_SETTING_KEYS } from '@goodvibes-jev/engine/sdk/platform/voice/wake/runtime';
import { configPathReader, resolveWebuiWakeSettings } from './wake-config';

describe('configPathReader', () => {
  const tree = {
    voice: {
      wake: {
        enabled: true,
        threshold: 0.85,
        surfaces: { tui: true, webui: false },
        indicator: 'banner',
      },
    },
    tts: { provider: 'elevenlabs' },
  };

  test('reads a nested dotted path', () => {
    const read = configPathReader(tree);
    expect(read('voice.wake.enabled')).toBe(true);
    expect(read('voice.wake.threshold')).toBe(0.85);
    expect(read('voice.wake.surfaces.webui')).toBe(false);
    expect(read('voice.wake.indicator')).toBe('banner');
  });

  test('a key the tree does not hold is undefined, so the resolver applies its default', () => {
    const read = configPathReader(tree);
    expect(read('voice.wake.cooldownMs')).toBeUndefined();
    expect(read('voice.wake.surfaces.agent')).toBeUndefined();
    expect(read('nothing.here.at.all')).toBeUndefined();
  });

  test('a path that runs into a non-object is undefined rather than a throw', () => {
    const read = configPathReader(tree);
    expect(read('voice.wake.enabled.deeper')).toBeUndefined();
    expect(read('tts.provider.length')).toBeUndefined();
  });

  test('an empty or missing tree reads as undefined throughout', () => {
    expect(configPathReader({})('voice.wake.enabled')).toBeUndefined();
    expect(configPathReader(undefined)('voice.wake.enabled')).toBeUndefined();
    expect(configPathReader(null)('voice.wake.enabled')).toBeUndefined();
  });

  test('every key the resolver reads is reachable through this reader', () => {
    // Not a claim that all values are set, a claim that no key SHAPE (nested
    // surfaces.*, plain voice.wake.*) is unreadable by this adapter.
    const read = configPathReader({ voice: { wake: { surfaces: {} } } });
    for (const key of WAKE_SETTING_KEYS) {
      expect(() => read(key)).not.toThrow();
    }
  });
});

describe('the surface this tab resolves as', () => {
  test('the shipped default is inactive: an empty tree opens nothing here', () => {
    const settings = resolveWebuiWakeSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.surfaceEnabled).toBe(false);
    expect(settings.active).toBe(false);
  });

  test('voice.wake.surfaces.webui must be turned on explicitly, even with the feature enabled', () => {
    const settings = resolveWebuiWakeSettings({ voice: { wake: { enabled: true } } });
    expect(settings.enabled).toBe(true);
    expect(settings.surfaceEnabled).toBe(false);
    expect(settings.active).toBe(false);
  });

  test('enabled plus the surface row makes it active', () => {
    const settings = resolveWebuiWakeSettings({
      voice: { wake: { enabled: true, surfaces: { webui: true } } },
    });
    expect(settings.active).toBe(true);
    expect(settings.blockers).toEqual([]);
  });
});

describe('what a browser tab cannot do, said out loud', () => {
  // The speex stage is a WebAssembly module the SDK carries, so a tab runs it: the
  // row is honoured rather than refused, and this asserts the capability is asked
  // of the SDK instead of being declared false here.
  test('speex noise suppression is HONOURED: a tab has WebAssembly, so the filter runs', () => {
    const settings = resolveWebuiWakeSettings({
      voice: { wake: { enabled: true, surfaces: { webui: true }, noiseSuppression: 'speex' } },
    });
    expect(settings.active).toBe(true);
    expect(settings.blockers.map((blocker) => blocker.key)).not.toContain('voice.wake.noiseSuppression');
    expect(settings.capture.noiseSuppression).toBe('speex');
  });

  test('a voice-activity floor BLOCKS while the gate is not provisioned, and RUNS once it is', () => {
    const tree = { voice: { wake: { enabled: true, surfaces: { webui: true }, vadThreshold: 0.5 } } };
    // The gate is its own pinned artifact: without it, frames would reach the
    // classifier unscreened while the row says they are being screened.
    const unprovisioned = resolveWebuiWakeSettings(tree);
    expect(unprovisioned.active).toBe(false);
    expect(unprovisioned.blockers.map((blocker) => blocker.key)).toContain('voice.wake.vadThreshold');
    // Provisioned, the same configuration runs and carries the threshold through.
    const provisioned = resolveWebuiWakeSettings(tree, true);
    expect(provisioned.active).toBe(true);
    expect(provisioned.blockers).toEqual([]);
    expect(provisioned.vadThreshold).toBe(0.5);
  });

  test('retaining audio is a LIMITATION: the detector runs and says retention is not happening', () => {
    const settings = resolveWebuiWakeSettings({
      voice: { wake: { enabled: true, surfaces: { webui: true }, retainAudio: 'session-temp' } },
    });
    expect(settings.active).toBe(true);
    expect(settings.retainAudio).toBe('none');
    expect(settings.limitations.map((limitation) => limitation.key)).toContain('voice.wake.retainAudio');
  });

  test('a custom activation sound downgrades to the chime, so a wake stays audible', () => {
    const settings = resolveWebuiWakeSettings({
      voice: {
        wake: {
          enabled: true,
          surfaces: { webui: true },
          activationSound: 'custom',
          activationSoundPath: '/home/me/ding.wav',
        },
      },
    });
    expect(settings.active).toBe(true);
    expect(settings.activationSound.kind).toBe('chime');
    expect(settings.limitations.map((limitation) => limitation.key)).toContain('voice.wake.activationSoundPath');
  });

  test('every blocker and limitation carries a written reason, never a bare key', () => {
    const settings = resolveWebuiWakeSettings({
      voice: {
        wake: {
          enabled: true,
          surfaces: { webui: true },
          noiseSuppression: 'speex',
          retainAudio: 'session-temp',
        },
      },
    });
    for (const row of [...settings.blockers, ...settings.limitations]) {
      expect(row.detail.length).toBeGreaterThan(40);
    }
  });

  test('the frame size is the classifier\'s, not a local choice', () => {
    expect(resolveWebuiWakeSettings({}).capture.frameSamples).toBe(1280);
  });
});
