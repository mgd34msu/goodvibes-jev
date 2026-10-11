import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { AudioCaptureError, AudioCaptureRequest, CaptureChildProcess } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { createAgentCaptureOpener } from '../../audio/capture.ts';

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

describe('agent recorder semantic reading at the actual capture consumer', () => {
    for (const label of ['permission-denied', 'device-missing', 'device-unavailable', 'none'] as const) {
      test(`agent: canonical ${label} reaches onStopped`, async () => {
        const fixture = answer(label);
        const child = processFixture();
        const stops: Array<{ reason: string; error?: AudioCaptureError | undefined }> = [];
        const stream = await createAgentCaptureOpener({ spawn: () => child.child, isInstalled: () => true, platform: 'linux' })(request,
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
});
