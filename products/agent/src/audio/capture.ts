/**
 * capture.ts, the ONE place this process opens a microphone.
 *
 * Wake-word detection is the consumer today (src/audio/wake-runtime.ts). It is
 * written as a shared opener rather than a private detail of that file because a
 * wake does not END a capture session, it starts one: the SDK listener keeps the
 * same stream open and switches it to recording the utterance that follows, so a
 * second opener would drop the beginning of a sentence and race the operating
 * system for a device that is already held.
 *
 * The framing arithmetic, the recorder argv, the probe order and the utterance
 * policy all live in the SDK (`@goodvibes-jev/engine/sdk/platform/voice/capture`),
 * because getting any of them subtly wrong is SILENT: a container header out of
 * byte alignment, or a frame at 62.5 fps against a 100 fps model, still "works"
 * and simply never detects. What is local is the one thing that cannot be shared
 *, actually starting a process. That mirrors playback exactly (see player.ts):
 * resolve a command off PATH, spawn it, and treat "no tool installed" as a
 * reported state rather than an exception.
 */

import { spawn } from 'node:child_process';
import {
  createRecorderCaptureOpener,
  type AudioCaptureOpener,
  type AudioCaptureWarn,
  type CaptureChildProcess,
  type CaptureSpawn,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { findExecutable } from './player.ts';

/**
 * WHERE NOISE SUPPRESSION HAPPENS, AND WHY NOT HERE
 *
 * This module used to export a `SURFACE_APPLIES_SPEEX_SUPPRESSION = false`
 * constant, because no surface applied the stage and `speex` therefore had to be
 * refused rather than silently skipped. The platform carries the filter now,
 * SpeexDSP's preprocessor as a WebAssembly module, and `WakeListener` wraps
 * whatever opener it is handed with `createNoiseSuppressingOpener`, so the stage
 * runs between the device and every consumer.
 *
 * That means this host deliberately does NOT wrap anything and deliberately does
 * NOT claim the capability: it hands over the same raw opener it always did, and
 * `resolveWakeRuntimeSettings` answers the capability question itself by asking
 * whether this runtime has WebAssembly. A second wrapper here would be a layer
 * that exists for no reason (wrapping is idempotent, so it would filter once and
 * pass through once), and a hardcoded `true` would be the exact lie the row
 * guards against, a surface asserting a filter it does not run.
 *
 * The recorder-level `speexAvailable` flag below stays unset for the same reason,
 * and its meaning is narrower than it looks: it is "the caller filters THIS
 * recorder's frames itself". Anything driving this opener directly with `speex`
 * and no filter of its own is refused rather than served unfiltered audio.
 */

/**
 * Spawn a recorder with its stdout piped and stdin closed.
 *
 * `stdio: ['ignore', 'pipe', 'pipe']` is deliberate on all three: a recorder with
 * an inherited stdin would compete with this shell for the terminal's raw-mode
 * keystrokes, stdout carries the raw PCM, and stderr is the ONLY place the reason
 * a device did not open is written, so it is kept for the error message rather
 * than discarded.
 */
export const spawnRecorderProcess: CaptureSpawn = (command, args): CaptureChildProcess => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Adapted rather than returned directly: the SDK's port declares the signal as
  // a plain `string` (it is shared with a browser bundle that has no
  // NodeJS.Signals) and node's narrower union is not assignable to it. The two
  // event listeners are branched explicitly for the same reason, node's `on` is
  // overloaded per event name and takes no union.
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on(event: 'error' | 'close', listener: (...args: never[]) => void): unknown {
      if (event === 'error') return child.on('error', listener as (error: Error) => void);
      return child.on('close', listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    },
    kill: (signal?: string) => child.kill(signal as NodeJS.Signals | undefined),
  };
};

export interface AgentCaptureOpenerOptions {
  /** Injected in tests so no real recorder is ever started. */
  readonly spawn?: CaptureSpawn;
  /** Injected in tests; defaults to the PATH + X_OK scan player.ts uses. */
  readonly isInstalled?: (command: string) => boolean;
  readonly platform?: string;
  /**
   * Whether the CALLER filters this recorder's frames itself. Left unset: the
   * platform's suppression stage runs one layer up (see the note above), and a
   * caller driving this opener directly with `speex` should be refused rather
   * than handed unfiltered audio.
   */
  readonly speexAvailable?: boolean;
  readonly warn?: AudioCaptureWarn;
}

/**
 * Build this surface's capture opener. Called once during startup wiring, and it
 * opens nothing by itself, a stream exists only once a consumer asks for one.
 */
export function createAgentCaptureOpener(options: AgentCaptureOpenerOptions = {}): AudioCaptureOpener {
  return createRecorderCaptureOpener({
    spawn: options.spawn ?? spawnRecorderProcess,
    isInstalled: options.isInstalled ?? ((command: string) => findExecutable(command, process.env) !== null),
    platform: options.platform ?? process.platform,
    ...(options.speexAvailable !== undefined ? { speexAvailable: options.speexAvailable } : {}),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });
}
