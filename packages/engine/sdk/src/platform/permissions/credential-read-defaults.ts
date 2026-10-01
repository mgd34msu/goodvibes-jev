/**
 * credential-read-defaults.ts: whether a read-only tool call touches secret or
 * credential material.
 *
 * This module used to hold a shipped list of credential-store path globs
 * (~/.ssh, ~/.aws/credentials, browser login databases...) and managed deny
 * rules built from it. What the list decided was "does reading this path
 * expose secrets", and it decided every unlisted path by omission: a token in
 * `~/.config/gh/hosts.yml`, a `.env.production` or a keystore anywhere else read
 * as harmless. That is a judgment about what a file holds, so it is now Jev's
 * reading: the side-effect battery's `secrets` question, asked for every call
 * of a built-in read-only tool (read, find, analyze, inspect, state, registry
 * and the other read-category tools) and for every file a search or map is
 * about to surface.
 *
 * A yes (or an uncertain reading) sends the call through the gate's full
 * reading, where touching secrets is at least high stakes. Readings are kept
 * per call for the life of the process, so a path read twice is asked once.
 */
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { sideEffect } from '../gate/batteries/side-effect.js';
import { readingState } from '../gate/reading.js';

const SEEN = new Map<string, boolean>();
const SEEN_LIMIT = 2_048;

/** The decision site read-only secrets readings are logged under. */
export const READ_SECRETS_SITE = 'engine.gate.read-secrets';

/**
 * Whether a read-only tool call touches secret or credential material, read
 * by Jev (`engine.gate.side-effect`, `secrets`). Uncertain counts as yes.
 */
export async function readTouchesSecrets(toolName: string, args: Record<string, unknown>, workingDirectory?: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const state = readingState(toolName, args, workingDirectory);
  const key = JSON.stringify(state);
  const seen = SEEN.get(key);
  if (seen !== undefined) return seen;
  const run = await executePolicyCheck(
    () => sideEffect.run(judgmentPort(READ_SECRETS_SITE), state, { site: READ_SECRETS_SITE, only: ['secrets'], ...(signal === undefined ? {} : { signal }) }),
    signal,
  );
  signal?.throwIfAborted();
  const touches = run.readings.secrets.verdict !== 'no';
  run.recordAction(touches ? 'secrets' : 'no-secrets');
  SEEN.set(key, touches);
  if (SEEN.size > SEEN_LIMIT) SEEN.delete(SEEN.keys().next().value!);
  return touches;
}

/** Forgets every remembered reading (tests, and a settings change that alters the model). */
export function forgetReadSecrets(): void {
  SEEN.clear();
}
