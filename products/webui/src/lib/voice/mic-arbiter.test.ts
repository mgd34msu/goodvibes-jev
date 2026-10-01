/**
 * mic-arbiter.ts, one device, two consumers.
 *
 * The bug this whole refactor exists to prevent is two concurrent getUserMedia
 * streams on one input, so these tests are about exactly that: a second open is
 * refused, and a push-to-talk press stands the wake listener down (and waits for it
 * to actually release) before it takes the device.
 */
import { describe, expect, test } from 'bun:test';
import { AudioCaptureError } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import type {
  AudioCaptureHandlers,
  AudioCaptureOpener,
  AudioCaptureRequest,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { MicArbiter, type MicLease } from './mic-arbiter';

const REQUEST: AudioCaptureRequest = {
  frameSamples: 1280,
  device: '',
  backend: 'auto',
  noiseSuppression: 'none',
};

const HANDLERS: AudioCaptureHandlers = { onFrame: () => undefined, onStopped: () => undefined };

interface CountingOpener {
  opener: AudioCaptureOpener;
  /** How many times a real device was opened. This is the number under test. */
  opens: number;
  live: number;
}

function countingOpener(): CountingOpener {
  const state: CountingOpener = {
    opens: 0,
    live: 0,
    opener: async () => {
      state.opens += 1;
      state.live += 1;
      return {
        label: 'fake',
        deviceSelectable: true,
        stop: async () => {
          state.live -= 1;
        },
      };
    },
  };
  return state;
}

describe('a second concurrent stream is refused, not opened', () => {
  test('two opens without a stop in between: the second is device-unavailable', async () => {
    const device = countingOpener();
    const arbiter = new MicArbiter(device.opener);

    const first = await arbiter.openCapture(REQUEST, HANDLERS);
    const error = await arbiter.openCapture(REQUEST, HANDLERS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AudioCaptureError);
    expect((error as AudioCaptureError).reason).toBe('device-unavailable');
    expect(device.opens).toBe(1);
    expect(arbiter.openStreams).toBe(1);

    await first.stop();
    expect(arbiter.openStreams).toBe(0);
  });

  test('after a stop the device can be opened again', async () => {
    const device = countingOpener();
    const arbiter = new MicArbiter(device.opener);
    await (await arbiter.openCapture(REQUEST, HANDLERS)).stop();
    const second = await arbiter.openCapture(REQUEST, HANDLERS);
    expect(device.opens).toBe(2);
    expect(device.live).toBe(1);
    await second.stop();
  });

  test('a stop that throws still releases the arbiter, so the mic is not wedged shut', async () => {
    const arbiter = new MicArbiter(async () => ({
      label: 'fake',
      deviceSelectable: true,
      stop: () => Promise.reject(new Error('teardown blew up')),
    }));
    const stream = await arbiter.openCapture(REQUEST, HANDLERS);
    await expect(stream.stop()).rejects.toThrow('teardown blew up');
    expect(arbiter.openStreams).toBe(0);
    await expect(arbiter.openCapture(REQUEST, HANDLERS)).resolves.toBeDefined();
  });
});

describe('push-to-talk takes the device from wake detection', () => {
  test('the wake listener is suspended before the press opens anything, and resumed after', async () => {
    const device = countingOpener();
    const arbiter = new MicArbiter(device.opener);
    const order: string[] = [];

    // A stand-in wake listener that genuinely holds a stream, so "did it release
    // before the press opened?" is a real question and not a bookkeeping one.
    let wakeStream: { stop(): Promise<void> } | null = null;
    arbiter.registerWake({
      suspend: async () => {
        order.push('wake-suspend');
        await wakeStream?.stop();
        wakeStream = null;
      },
      resume: async () => {
        order.push('wake-resume');
        wakeStream = await arbiter.openCapture(REQUEST, HANDLERS);
      },
    });
    wakeStream = await arbiter.openCapture(REQUEST, HANDLERS);
    expect(arbiter.openStreams).toBe(1);

    const lease = await arbiter.acquireExclusive();
    order.push('press-open');
    // The critical assertion: by the time the press opens, the wake stream is gone,
    // so this open is the ONLY live stream rather than a second one.
    expect(arbiter.openStreams).toBe(0);
    const pressStream = await arbiter.openCapture(REQUEST, HANDLERS);
    expect(device.live).toBe(1);

    await pressStream.stop();
    await lease();

    expect(order).toEqual(['wake-suspend', 'press-open', 'wake-resume']);
    expect(device.live).toBe(1);
    expect(arbiter.openStreams).toBe(1);
    await wakeStream?.stop();
  });

  test('a press with no wake listener registered simply takes the device', async () => {
    const device = countingOpener();
    const arbiter = new MicArbiter(device.opener);
    const lease = await arbiter.acquireExclusive();
    const stream = await arbiter.openCapture(REQUEST, HANDLERS);
    await stream.stop();
    await lease();
    expect(device.opens).toBe(1);
    expect(arbiter.exclusiveHeld).toBe(false);
  });

  test('overlapping presses are serialised rather than suspending an already-suspended listener', async () => {
    const arbiter = new MicArbiter(countingOpener().opener);
    let suspends = 0;
    let resumes = 0;
    arbiter.registerWake({
      suspend: async () => { suspends += 1; },
      resume: async () => { resumes += 1; },
    });

    const first = await arbiter.acquireExclusive();
    const secondSettled: { lease: MicLease | null } = { lease: null };
    const secondPending = arbiter.acquireExclusive().then((lease) => {
      secondSettled.lease = lease;
    });
    // The second press is genuinely waiting; the listener has been stood down once.
    await Promise.resolve();
    expect(secondSettled.lease).toBeNull();
    expect(suspends).toBe(1);

    await first();
    await secondPending;
    expect(secondSettled.lease).not.toBeNull();
    expect(suspends).toBe(2);
    await secondSettled.lease?.();
    expect(resumes).toBe(2);
  });

  test('a wake listener that cannot stand down does not block dictation', async () => {
    const device = countingOpener();
    const arbiter = new MicArbiter(device.opener);
    arbiter.registerWake({
      suspend: () => Promise.reject(new Error('already dead')),
      resume: () => Promise.resolve(),
    });
    const lease = await arbiter.acquireExclusive();
    const stream = await arbiter.openCapture(REQUEST, HANDLERS);
    expect(device.live).toBe(1);
    await stream.stop();
    await lease();
  });

  test('unregistering stops the arbiter from resuming a listener that has gone', async () => {
    const arbiter = new MicArbiter(countingOpener().opener);
    let resumes = 0;
    const unregister = arbiter.registerWake({
      suspend: () => Promise.resolve(),
      resume: async () => { resumes += 1; },
    });
    const lease = await arbiter.acquireExclusive();
    unregister();
    await lease();
    expect(resumes).toBe(0);
  });
});
