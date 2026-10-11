import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { createRecorderCaptureOpener } from '../sdk/src/platform/voice/capture/recorder-source.js';
import { PushToTalkSession } from '../sdk/src/platform/voice/capture/push-to-talk.js';
import type { AudioCaptureError, AudioCaptureHandlers, AudioCaptureRequest, CaptureChildProcess } from '../sdk/src/platform/voice/capture/index.js';

const previous: Array<JudgmentPort | undefined> = [];
afterEach(() => { while (previous.length) installJudgmentPort(previous.pop()); });
function install(port: JudgmentPort | undefined) { previous.push(installJudgmentPort(port)); }
function answer(label: string, confidence = 0.99) {
  const fixture = fakePort((_name, question) => choiceAnswer(question, label, confidence));
  install(fixture.port); return fixture;
}
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function processFixture() {
  let onClose = (_code: number | null, _signal: string | null) => {};
  let onError = (_error: Error) => {};
  let onStderr = (_chunk: Uint8Array) => {};
  let onData = (_chunk: Uint8Array) => {};
  const signals: string[] = [];
  const child: CaptureChildProcess = {
    stdout: { on: (_event, listener) => { onData = listener; } },
    stderr: { on: (_event, listener) => { onStderr = listener; } },
    on(event: 'close' | 'error', listener: (...args: never[]) => void) {
      if (event === 'close') onClose = listener as typeof onClose;
      else onError = listener as typeof onError;
    },
    kill(signal) { signals.push(signal ?? 'SIGTERM'); onClose(0, signal ?? 'SIGTERM'); },
  };
  return { child, signals, stderr: (text: string) => onStderr(new TextEncoder().encode(text)),
    close: (code: number | null = 1, signal: string | null = null) => onClose(code, signal),
    error: (error: Error) => onError(error), data: () => onData(new Uint8Array(8)) };
}
const request: AudioCaptureRequest = { backend: 'parecord', device: 'microphone', noiseSuppression: 'none', frameSamples: 4 };
const surfaces = { sdk: createRecorderCaptureOpener };

describe('recorder semantic reading at actual capture consumers', () => {
  for (const [surface, create] of Object.entries(surfaces)) {
    for (const label of ['permission-denied', 'device-missing', 'device-unavailable', 'none'] as const) {
      test(`${surface}: canonical ${label} reaches onStopped`, async () => {
        const fixture = answer(label);
        const child = processFixture();
        const stops: Array<{ reason: string; error?: AudioCaptureError | undefined }> = [];
        const stream = await create({ spawn: () => child.child, isInstalled: () => true, platform: 'linux' })(request,
          { onFrame() {}, onStopped: (reason, error) => { stops.push({ reason, error }); } });
        child.stderr('A complete diagnostic whose interpretation belongs to the supplied judgment.'); child.close(7);
        await settle();
        expect(fixture.requests).toHaveLength(1);
        expect(stops).toHaveLength(1);
        expect(stops[0]?.error?.reason).toBe(label === 'none' ? 'stream-ended' : label);
        if (label === 'none') expect(stops[0]?.error?.message).toContain('code 7');
        child.close(7); child.error(new Error('late duplicate')); await stream.stop();
        expect(stops).toHaveLength(1);
      });
    }
  }
  for (const diagnostic of [
    'Documentation says "permission denied", "no such device" and "audio open error". Actual stop was a closed output pipe.',
    'There was no permission denied condition and the device is present. This was a normal shutdown.',
  ]) test('quoted or negated keywords do not override canonical none', async () => {
    answer('none'); const child = processFixture(); let error: AudioCaptureError | undefined;
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request,
      { onFrame() {}, onStopped: (_reason, failure) => { error = failure; } });
    child.stderr(diagnostic); child.close(null, 'SIGPIPE'); await settle();
    expect(error?.reason).toBe('stream-ended'); expect(error?.message).toContain('SIGPIPE');
  });
  test('complete diagnostic beyond the old 400-character display cap is admitted', async () => {
    const fixture = answer('device-missing'); const child = processFixture();
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, { onFrame() {}, onStopped() {} });
    const text = 'normal progress '.repeat(50) + 'The requested microphone does not exist.';
    child.stderr(text); child.close(); await settle();
    expect(JSON.stringify(fixture.requests[0]?.state)).toContain(text);
  });
  for (const diagnostic of ['progress '.repeat(100) + ' Authorization: Bearer private-secret',
    'normal progress\n- Jo: password=synthetic-secret', 'x'.repeat(65537)]) {
    test('protected tail or overflow holds without any judgment transmission', async () => {
      const fixture = answer('device-missing'); const child = processFixture(); let error: AudioCaptureError | undefined;
      await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request,
        { onFrame() {}, onStopped: (_reason, failure) => { error = failure; } });
      child.stderr(diagnostic); child.close(); await settle();
      expect(fixture.requests).toHaveLength(0); expect(error?.reason).toBe('failure-reading-unavailable');
      expect(error?.message).not.toContain('private-secret');
    });
  }
  for (const mode of ['missing', 'uncertain', 'replaced', 'late-installed'] as const) {
    test(`${mode} authority holds rather than inventing device absence`, async () => {
      if (mode === 'missing' || mode === 'late-installed') install(undefined); else answer('device-missing', mode === 'uncertain' ? 0.5 : 0.99);
      const child = processFixture(); let error: AudioCaptureError | undefined;
      await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request,
        { onFrame() {}, onStopped: (_reason, failure) => { error = failure; } });
      if (mode === 'replaced' || mode === 'late-installed') answer('device-missing');
      child.stderr('No capture device exists.'); child.close(); await settle();
      expect(error?.reason).toBe('failure-reading-unavailable');
    });
  }
  test('stop interrupts a noncooperative close reading and drains late settlement exactly once', async () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'device-missing', 0.99));
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    install({ ...fixture.port, async ask(input) { ++calls; await blocked; return fixture.port.ask(input); } });
    const child = processFixture(); const stops: string[] = []; let frames = 0;
    const stream = await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request,
      { onFrame() { ++frames; }, onStopped: reason => { stops.push(reason); } });
    child.stderr('The microphone is absent.'); child.close(); await settle(); expect(calls).toBe(1);
    child.close(); child.error(new Error('duplicate')); child.data();
    await stream.stop(); expect(stops).toEqual(['requested']); expect(child.signals).toHaveLength(0);
    release(); await settle(); expect(stops).toEqual(['requested']); expect(frames).toBe(0);
  });
  test('PTT cancel and replacement ignore callbacks from an old capture incarnation', async () => {
    const callbacks: AudioCaptureHandlers[] = [];
    const session = new PushToTalkSession({ captureMaxSeconds: 30, capture: { ...request }, openCapture: async (_request, handlers) => {
      callbacks.push(handlers); return { label: 'fixture', deviceSelectable: true, stop: async () => {} };
    } });
    await session.start(); await session.cancel(); await session.start();
    callbacks[0]!.onStopped('failed'); expect(session.phase).toBe('recording');
    await session.cancel();
  });
});
