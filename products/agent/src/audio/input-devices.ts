/**
 * input-devices.ts, what microphones this host actually has.
 *
 * The SDK decides what a configured `voice.wake.inputDevice` MEANS, present,
 * absent and falling back, or a machine with no real microphone at all, but it
 * cannot go and look, because the same policy runs in a browser tab. Looking is
 * this surface's job, and it is one command.
 *
 * Why it exists: a pinned device naming a Bluetooth headset that was away made
 * wake detection capture nothing, silently, for as long as the headset stayed
 * off. Nothing checked whether the name referred to anything. It does now, and
 * the check is only as good as this listing.
 *
 * DEGRADING IS PART OF THE CONTRACT. A host without `pactl` is not broken and
 * must not lose wake detection over it: this returns an empty answer by
 * THROWING, which the SDK reads as "this host cannot tell" and treats the pin
 * as unverified, exactly the behaviour every surface had before any of this
 * existed. Returning an empty LIST would be a different and much worse claim:
 * it means "there are no microphones here", which would stop capture on a
 * perfectly good machine that merely lacks a PulseAudio CLI.
 */

import { execFile } from 'node:child_process';
import {
  parsePactlSources,
  type AudioInputDevice,
  type AudioInputDeviceEnumerator,
} from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { findExecutable } from './player.ts';

/** How long the listing may take before it is abandoned. */
const PACTL_TIMEOUT_MS = 3_000;

export interface InputDeviceEnumeratorOptions {
  /** Injected in tests; defaults to the PATH + X_OK scan player.ts uses. */
  readonly isInstalled?: ((command: string) => boolean) | undefined;
  /** Injected in tests so no real process is started. */
  readonly run?: ((command: string, args: readonly string[]) => Promise<string>) | undefined;
}

/** Run a command and return its stdout, rejecting on any non-zero exit. */
function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: PACTL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Build the device enumerator this surface hands the wake listener.
 *
 * Two commands, because they answer different halves: `list short sources` is
 * the inventory, and `get-default-source` is which one the OS is currently
 * using. The default is best-effort, a listing without it still resolves every
 * case that matters, so a failure there does not fail the enumeration.
 */
export function createInputDeviceEnumerator(
  options: InputDeviceEnumeratorOptions = {},
): AudioInputDeviceEnumerator {
  const isInstalled = options.isInstalled ?? ((command: string) => findExecutable(command, process.env) !== null);
  const run = options.run ?? runCommand;

  return async (): Promise<readonly AudioInputDevice[]> => {
    if (!isInstalled('pactl')) {
      // Not an empty list. See the note above: "I cannot tell" and "there are
      // no microphones" are opposite claims and only one of them is true here.
      throw new Error('pactl is not installed, so the input devices on this host cannot be listed');
    }
    const stdout = await run('pactl', ['list', 'short', 'sources']);
    let defaultSource: string | undefined;
    try {
      defaultSource = (await run('pactl', ['get-default-source'])).trim() || undefined;
    } catch {
      // Which source is default is a nicety; the inventory is the answer.
      defaultSource = undefined;
    }
    return parsePactlSources(stdout, defaultSource);
  };
}
