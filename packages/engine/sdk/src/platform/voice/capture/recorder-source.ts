/**
 * recorder-source.ts, a host capture stream built from a recorder subprocess.
 *
 * This is the capture opener for every surface that has a shell: the terminal UI
 * and the daemon child process that hosts the detector. It is the same shape the
 * TUI's audio PLAYBACK already uses in reverse, resolve a command, spawn it,
 * treat "no tool installed" as a real reported state rather than an exception,
 * so a host that already spawns a player has nothing new to learn.
 *
 * `spawn` is INJECTED rather than imported. Two reasons, both load-bearing:
 * this module is part of a bundle a browser tab loads (importing
 * `node:child_process` here would break that bundle outright), and a test must
 * be able to drive the byte path, a partial chunk, a mid-frame exit, a
 * non-zero code, without a real microphone or a real recorder installed.
 */
import { ownRecorderFailure, readRecorderFailure } from './recorder-failure-reading.js';
import { AudioFrameSlicer, pcm16ToFloatSamples } from './frames.js';
import {
  resolveRecorderCommand,
  type ResolvedRecorderCommand,
} from './recorder-command.js';
import {
  AudioCaptureError,
  CAPTURE_SAMPLE_RATE,
  type AudioCaptureHandlers,
  type AudioCaptureOpener,
  type AudioCaptureRequest,
  type AudioCaptureStream,
  type AudioCaptureWarn,
} from './types.js';

/** The narrow slice of a child process this needs. Matches Node and Bun spawns. */
export interface CaptureChildProcess {
  readonly stdout: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  } | null;
  readonly stderr?: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  } | null | undefined;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
}

/** Spawns a recorder. A host passes `node:child_process`'s spawn, wrapped. */
export type CaptureSpawn = (command: string, args: readonly string[]) => CaptureChildProcess;

export interface RecorderCaptureOptions {
  readonly spawn: CaptureSpawn;
  /** True when a command is on PATH. A host checks with `X_OK` access. */
  readonly isInstalled: (command: string) => boolean;
  /** `process.platform`; decides ffmpeg's input format. */
  readonly platform?: string | undefined;
  /**
   * True only when the caller filters this recorder's frames ITSELF.
   *
   * A recorder subprocess produces raw audio and this module does not filter it.
   * The platform's suppression stage does, one layer up:
   * `createNoiseSuppressingOpener` wraps an opener like this one, and both
   * consumers, {@link WakeListener} and {@link PushToTalkSession}, already
   * wrap the opener a host hands them, which is why a host passes nothing here
   * and still gets `voice.wake.noiseSuppression: "speex"` applied.
   *
   * A caller driving this opener DIRECTLY with `speex` and no filter of its own
   * is refused rather than served unfiltered audio, which is what this flag
   * exists to distinguish.
   */
  readonly speexAvailable?: boolean | undefined;
  readonly sampleRate?: number | undefined;
  readonly warn?: AudioCaptureWarn | undefined;
}

/** How long a stopped recorder is given to exit before it is killed harder. */
const RECORDER_TERM_GRACE_MS = 750;

/**
 * Keep complete diagnostic evidence, not a display prefix. Recorders also write
 * harmless progress to stderr, so wording is read only after the process closes.
 * Overflow explicitly holds classification; raw stderr is never a UI message.
 */
const STDERR_KEEP_CHARS = 64 * 1024;

/**
 * Build a capture opener over a recorder subprocess.
 *
 * The returned opener rejects with an {@link AudioCaptureError} when nothing can
 * be opened, and reports a stream that dies later through
 * {@link AudioCaptureHandlers.onStopped}, the distinction matters because the
 * first is "this will never work as configured" and the second is what the
 * detector's restart policy exists to handle.
 */
export function createRecorderCaptureOpener(options: RecorderCaptureOptions): AudioCaptureOpener {
  return async (request: AudioCaptureRequest, handlers: AudioCaptureHandlers): Promise<AudioCaptureStream> => {
    if (request.noiseSuppression === 'speex' && options.speexAvailable !== true) {
      throw new AudioCaptureError(
        'noise-suppression-unavailable',
        'voice.wake.noiseSuppression is set to "speex", but a recorder subprocess produces raw audio and this '
        + 'opener does not filter it. The platform\'s speexdsp stage runs one layer up: wrap this opener with '
        + 'createNoiseSuppressingOpener, which the wake listener and the push-to-talk session already do. '
        + 'Refusing rather than handing you unfiltered audio through a filter you configured.',
      );
    }
    const resolved = resolveRecorderCommand(request.backend, {
      isInstalled: options.isInstalled,
      device: request.device,
      sampleRate: options.sampleRate ?? CAPTURE_SAMPLE_RATE,
      // Recorders already proven silent on this host. Dropping these here is
      // what made the exclusion dead: the listener worked out which recorder
      // could not capture, put it on the request, and the opener resolved
      // `auto` as if it had never been told.
      ...(request.excludeBackends !== undefined ? { exclude: request.excludeBackends } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    if (resolved === null) {
      throw new AudioCaptureError('no-recorder', describeMissingRecorder(request.backend));
    }
    return startRecorderStream(resolved, request, handlers, options);
  };
}

function describeMissingRecorder(backend: string): string {
  return backend === 'auto'
    ? 'no audio recorder is installed: none of pw-record, parecord, arecord, ffmpeg or sox was found on PATH. '
      + 'Install one of them, or name a different recorder in voice.wake.captureCommand.'
    : `voice.wake.captureCommand names "${backend}", which is not installed on this host. `
      + 'Install it, or set the row to "auto" to use whichever recorder is present.';
}

function startRecorderStream(
  resolved: ResolvedRecorderCommand,
  request: AudioCaptureRequest,
  handlers: AudioCaptureHandlers,
  options: RecorderCaptureOptions,
): AudioCaptureStream {
  const slicer = new AudioFrameSlicer(request.frameSamples);
  const onFrame = handlers.onFrame.bind(handlers);
  const onStopped = handlers.onStopped.bind(handlers);
  let stderrText = '';
  let stderrOverflow = false;
  const decoder = new TextDecoder();
  let processClosed = false;
  const lifetime = new AbortController();
  const configuration = Object.freeze({ command: resolved.command, args: Object.freeze([...resolved.args]),
    backend: resolved.backend, device: request.device, frameSamples: request.frameSamples,
    noiseSuppression: request.noiseSuppression, sampleRate: options.sampleRate ?? CAPTURE_SAMPLE_RATE });
  const owner = ownRecorderFailure(configuration, lifetime.signal);
  let stopped = false;
  let stopRequested = false;
  const exited: Array<() => void> = [];
  const child = options.spawn(resolved.command, resolved.args);

  const finish = (reason: 'requested' | 'stream-ended' | 'failed', error?: AudioCaptureError): void => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    // Drain shutdown before invoking a possibly reentrant consumer.
    for (const resolve of exited.splice(0)) resolve();
    if (error !== undefined) onStopped(reason, error);
    else onStopped(reason);
  };

  child.stdout?.on('data', (chunk: Uint8Array) => {
    if (stopped || processClosed || stopRequested) return;
    for (const frame of slicer.push(pcm16ToFloatSamples(chunk))) onFrame(frame);
  });
  const appendStderr = (text: string): void => {
    if (stderrOverflow) return;
    if (stderrText.length + text.length > STDERR_KEEP_CHARS) {
      // An incomplete diagnostic is never evidence for a semantic decision.
      stderrOverflow = true;
      stderrText = '';
      return;
    }
    stderrText += text;
  };
  child.stderr?.on('data', (chunk: Uint8Array) => {
    if (stopped || processClosed || stderrOverflow) return;
    appendStderr(decoder.decode(chunk, { stream: true }));
  });
  child.on('error', (error: Error) => {
    if (stopped || processClosed) return;
    finish(stopRequested ? 'requested' : 'failed', stopRequested ? undefined
      : new AudioCaptureError('device-unavailable', `the recorder could not be started: ${error.message}`));
  });
  child.on('close', (code: number | null, signal: string | null) => {
    if (stopped || processClosed) return;
    processClosed = true;
    for (const resolve of exited.splice(0)) resolve();
    if (stopRequested) { finish('requested'); return; }
    appendStderr(decoder.decode());
    const evidence = Object.freeze({ ...configuration, stderr: stderrText, code, signal });
    const exit = code !== null && code !== 0 ? `exited with code ${code}${signal ? ` on signal ${signal}` : ''}`
      : signal ? `exited on signal ${signal}` : 'exited on its own';
    const complete = async (): Promise<void> => {
      let cause: Awaited<ReturnType<typeof readRecorderFailure>> = stderrOverflow ? 'unavailable' : stderrText.length === 0 ? 'none'
        : await readRecorderFailure(evidence, owner);
      if (stopped || stopRequested || lifetime.signal.aborted) return;
      // The async return is another ownership boundary: the installation may
      // retire after the reader's final check but before this continuation.
      if (cause !== 'unavailable' && stderrText.length > 0) {
        try {
          if (!owner.capture) throw new Error('Recorder failure reader is unavailable.');
          owner.capture.assertCurrent();
        } catch { cause = 'unavailable'; }
      }
      if (stopped || stopRequested || lifetime.signal.aborted) return;
      if (cause === 'unavailable') {
        finish('failed', new AudioCaptureError('failure-reading-unavailable',
          `The recorder ${resolved.command} ${exit}, but its failure could not be safely determined. Capture is paused; retry after checking the recorder and judgment service.`));
        return;
      }
      if (cause !== 'none') {
        finish('failed', new AudioCaptureError(cause, `the recorder ${resolved.command} ${exit}: ${cause}`));
        return;
      }
      // Exit code and signal remain exact process facts, never prose guesses.
      finish('failed', new AudioCaptureError('stream-ended', `the recorder ${resolved.command} ${exit}`));
    };
    // Always drain the task, including a consumer callback that throws.
    void complete().catch(() => {
      if (!stopped && !stopRequested) finish('failed', new AudioCaptureError('failure-reading-unavailable', 'The recorder failure reading is unavailable.'));
    });
  });

  if (!resolved.deviceSelectable && request.device.trim().length > 0) {
    options.warn?.('capture backend cannot target a device; using the system default', {
      backend: resolved.backend,
      device: request.device,
    });
  }

  let stopTask: Promise<void> | undefined;
  const stopRecorder = async (): Promise<void> => {
    stopRequested = true;
    lifetime.abort();
    if (stopped) return;
    if (processClosed) { finish('requested'); return; }
    try { child.kill('SIGTERM'); } catch { /* Escalation below still has a bounded deadline. */ }
    if (stopped || processClosed) { finish('requested'); return; }
    // Wait for the process to actually go, but never for its pending judgment.
    await new Promise<void>((resolve) => {
      const done = (): void => { clearTimeout(timer); resolve(); };
      exited.push(done);
      const timer = setTimeout(() => {
        try { if (!stopped && !processClosed) child.kill('SIGKILL'); }
        catch { /* A host kill failure must not leave stop waiting forever. */ }
        finally { resolve(); }
      }, RECORDER_TERM_GRACE_MS);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    finish('requested');
  };
  return {
    label: resolved.label,
    deviceSelectable: resolved.deviceSelectable,
    stop: (): Promise<void> => stopTask ??= stopRecorder(),
  };
}
