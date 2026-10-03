/**
 * The banner said "listening for the wake phrase" through an entire boot on a
 * machine where `pactl list short source-outputs` was empty, no recorder child
 * existed, and not one wake line was written anywhere. The row was driven by
 * the listener's PHASE, and `starting` was mapped straight onto the listening
 * label, so intent rendered as evidence.
 *
 * Underneath it were two more: a pinned input device that named a Bluetooth
 * headset which was away (believed, never checked, so capture produced nothing
 * silently), and `auto` choosing pw-record because it is first in the probe
 * order and installed, measured on that host, `pw-record --target <a name
 * pactl prints>` answers "no target node available" and exits 1, and with no
 * target it yields zero bytes, while `parecord --device=<the same name>`
 * captures happily.
 *
 * These pin the product wiring: the enumerator this surface supplies, the row
 * it renders, and the diagnostics it writes.
 */
import { describe, expect, test } from 'bun:test';
import type { AudioCaptureHandlers, AudioCaptureRequest } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { readVoiceDiagnostics } from '@goodvibes-jev/engine/sdk/platform/voice';

import { wireWakeRuntime, type WakeRuntimeDeps } from '../../audio/wake-runtime.ts';
import { createInputDeviceEnumerator } from '../../audio/input-devices.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const HEADSET = 'bluez_input.AC:BF:71:00:00:01.headset-head-unit';

function mic(id: string, isDefault = false) {
  return { id, label: id, isMonitor: false, isDefault };
}
function monitor(id: string) {
  return { id, label: id, isMonitor: true };
}

interface HarnessOptions {
  readonly device?: string;
  readonly devices?: () => readonly { id: string; label: string; isMonitor: boolean; isDefault?: boolean }[];
  /** Backends that open but never deliver a frame. */
  readonly silentBackends?: readonly string[];
  readonly managedRoot?: string;
}

/** The wake runtime with a scripted capture opener and device listing. */
function harness(options: HarnessOptions = {}) {
  const notices: string[] = [];
  const opened: Array<{ device: string; exclude: readonly string[] | undefined; backend: string }> = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const managedRoot = options.managedRoot ?? makeProjectTempDir('gv-wake-truth');
  const order = ['pw-record', 'parecord', 'arecord'];
  let emitFrame: (() => void) | null = null;

  const config: Record<string, unknown> = {
    'voice.wake.enabled': true,
    'voice.wake.surfaces.agent': true,
    'voice.wake.inputDevice': options.device ?? '',
    'voice.wake.captureCommand': 'auto',
    'voice.wake.indicator': 'statusline',
  };

  const deps: WakeRuntimeDeps = {
    readConfig: (key) => config[key],
    subscribeConfig: () => () => {},
    openCapture: async (request: AudioCaptureRequest, handlers: AudioCaptureHandlers) => {
      // Mimic the SDK opener's `auto` resolution: first candidate not excluded.
      const excluded = new Set(request.excludeBackends ?? []);
      const backend = order.find((candidate) => !excluded.has(candidate as never)) ?? 'pw-record';
      opened.push({ device: request.device, exclude: request.excludeBackends, backend });
      if (!(options.silentBackends ?? []).includes(backend)) {
        emitFrame = () => handlers.onFrame(new Float32Array(request.frameSamples));
      }
      return { label: `${backend} (auto)`, deviceSelectable: true, stop: async () => {} };
    },
    managedRoot,
    assetDirectory: `${managedRoot}/assets`,
    resolveTranscriber: () => ({ available: false as const, reason: 'not needed for this test' }),
    playActivationSound: () => {},
    submitTurn: () => {},
    writeDraft: () => {},
    notify: (message) => { notices.push(message); },
    render: () => {},
    sessionId: 'test-session',
    warn: () => {},
    enumerateInputDevices: async () => (options.devices ?? (() => [mic('alsa_input.analog-stereo', true)]))(),
    // The models are on disk as far as this test is concerned.
    provisionStatus: () => ({ ready: true, reason: null, vadReady: false }),
    loadSession: async () => ({
      run: async () => ({}),
      release: async () => {},
    }) as never,
    setTimeout: (handler, ms) => { timers.push({ run: handler, ms }); return timers.length; },
    clearTimeout: () => {},
  };

  const runtime = wireWakeRuntime(deps);
  return {
    runtime,
    notices,
    opened,
    timers,
    managedRoot,
    pushFrame: () => emitFrame?.(),
  };
}

describe('the wake row reports capture truth, not intent', () => {
  test('an open stream with no frames is NOT listening; a frame makes it listening', async () => {
    const wake = harness();
    await wake.runtime.refresh();

    // Open, nothing heard yet. This is the state that used to render as
    // "listening for the wake phrase".
    const before = wake.runtime.status();
    expect(before?.kind).toBe('wake-no-audio');
    expect(before?.detail).toContain('no audio is arriving');

    wake.pushFrame();

    const after = wake.runtime.status();
    expect(after?.kind).toBe('wake-listening');
    expect(after?.detail).toContain('Listening for the wake phrase');
  });

  test('a host with no microphone renders the honest row instead of nothing', async () => {
    const wake = harness({ devices: () => [monitor('alsa_output.hdmi-stereo.monitor')] });
    await wake.runtime.refresh();

    // Nothing was opened at all.
    expect(wake.opened).toEqual([]);
    const row = wake.runtime.status();
    expect(row?.kind).toBe('wake-no-microphone');
    expect(row?.detail).toContain('output monitors');
    expect(wake.notices.join(' ')).toContain('no microphone');
  });

  test('a pinned device that is absent falls back, says so, and still listens', async () => {
    const wake = harness({ device: HEADSET, devices: () => [mic('alsa_input.analog-stereo', true)] });
    await wake.runtime.refresh();

    // The recorder was handed the DEFAULT, not the absent pin.
    expect(wake.opened[0]?.device).toBe('');
    expect(wake.notices.join('\n')).toContain('is not connected');
    wake.pushFrame();
    expect(wake.runtime.status()?.kind).toBe('wake-listening');
  });
});

describe('a recorder that captures nothing is not chosen again', () => {
  test('a silent first backend rotates to the next, with the reason announced', async () => {
    const wake = harness({ silentBackends: ['pw-record'] });
    await wake.runtime.refresh();

    expect(wake.opened[0]?.backend).toBe('pw-record');
    expect(wake.opened[0]?.exclude).toBeUndefined();

    // The first-frame watchdog fires, then the supervisor's restart.
    const firstFrame = wake.timers.find((timer) => timer.ms === 5_000);
    expect(firstFrame).toBeDefined();
    firstFrame!.run();
    const restart = wake.timers.find((timer) => timer.ms > 0 && timer.ms < 5_000);
    expect(restart).toBeDefined();
    restart!.run();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Reopened WITHOUT the recorder that produced silence.
    expect(wake.opened).toHaveLength(2);
    expect(wake.opened[1]?.exclude).toEqual(['pw-record']);
    expect(wake.opened[1]?.backend).toBe('parecord');
    expect(wake.notices.join('\n')).toContain('delivered no audio');
  });

  test('the silence and the rotation are written to the voice diagnostics', async () => {
    const wake = harness({ silentBackends: ['pw-record'] });
    await wake.runtime.refresh();
    wake.timers.find((timer) => timer.ms === 5_000)!.run();

    const entries = readVoiceDiagnostics(wake.managedRoot);
    const capture = entries.find((entry) => entry.operation === 'wake-capture');
    expect(capture?.ok).toBe(false);
    expect(capture?.error).toContain('delivered no audio');
    // The configuration behind the failure is recorded with it, which is what
    // makes it diagnosable after the fact.
    expect(capture?.configSource).toContain('voice.wake.captureCommand=auto');
  });

  test('a start that refuses writes a diagnostic rather than vanishing', async () => {
    const wake = harness({ devices: () => [monitor('alsa_output.hdmi-stereo.monitor')] });
    await wake.runtime.refresh();

    const entries = readVoiceDiagnostics(wake.managedRoot);
    const start = entries.find((entry) => entry.operation === 'wake-capture-start');
    expect(start?.ok).toBe(false);
    expect(start?.error).toContain('no microphone');
  });
});

describe('the device enumerator this surface supplies', () => {
  test('parses pactl output into devices, marking monitors', async () => {
    const enumerate = createInputDeviceEnumerator({
      isInstalled: () => true,
      run: async (_command, args) => (args[0] === 'list'
        ? [
          '0\talsa_output.pci-0000_0c_00.1.hdmi-stereo.monitor\tPipeWire\ts32le 2ch 48000Hz\tRUNNING',
          '1\talsa_input.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED',
        ].join('\n')
        : 'alsa_input.pci-0000_00_1f.3.analog-stereo\n'),
    });

    const devices = await enumerate();
    expect(devices.map((device) => device.isMonitor)).toEqual([true, false]);
    expect(devices.find((device) => device.isDefault)?.id).toBe('alsa_input.pci-0000_00_1f.3.analog-stereo');
  });

  test('a host without pactl THROWS rather than reporting an empty list', async () => {
    // "I cannot tell" and "there are no microphones here" are opposite claims.
    // Returning [] would stop capture on a machine that merely lacks a CLI.
    const enumerate = createInputDeviceEnumerator({ isInstalled: () => false });
    await expect(enumerate()).rejects.toThrow(/pactl is not installed/);
  });

  test('a failing default-source lookup does not fail the whole listing', async () => {
    const enumerate = createInputDeviceEnumerator({
      isInstalled: () => true,
      run: async (_command, args) => {
        if (args[0] === 'get-default-source') throw new Error('no default configured');
        return '0\talsa_input.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tSUSPENDED';
      },
    });
    const devices = await enumerate();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.isDefault).toBeUndefined();
  });
});
