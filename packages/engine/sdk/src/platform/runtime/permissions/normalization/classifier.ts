/**
 * What host access a shell command needs, read by Jev.
 *
 * This module used to classify every segment into read, write, network,
 * destructive or escalation by fixed sets of binary and subcommand names, plus
 * a frozen catastrophic list and a dangerous-pattern list. Each of those was a
 * judgment about what a command does made by name matching, and a script, an
 * alias or an unlisted binary walked past every one. The questions they
 * answered are now readings: whether a command is catastrophic is the gate's
 * boundary reading (gate/batteries/boundary.ts), what it changes and how much
 * is at stake is the gate's stakes reading, and what host access it needs
 * inside the sandbox is `engine.gate.sandbox-needs`, read here.
 */
import {
  captureJudgmentPort,
  JudgmentAuthorityRetiredError,
  type JudgmentReadingOptions,
} from '@goodvibes-jev/engine/errors';
import { sandboxNeeds } from '../../../gate/batteries/sandbox-needs.js';

export interface CommandNeeds {
  /** It reaches the network (uncertain counts as yes). */
  readonly needsNetwork: boolean;
  /** It needs host administrator privileges (uncertain counts as yes). */
  readonly needsPrivilege: boolean;
}

interface CachedCommandNeeds {
  readonly needs: CommandNeeds;
  readonly assertCurrent: () => void;
}

let SEEN = new WeakMap<object, Map<string, CachedCommandNeeds>>();
const SEEN_LIMIT = 256;

/** The decision site the sandbox's command readings are logged under. */
export const COMMAND_NEEDS_SITE = 'engine.gate.sandbox-needs';

/** Reuses a command's observation only while its actual Jev authority stays current. */
export async function readCommandNeeds(
  command: string,
  workspace?: string,
  options: Pick<JudgmentReadingOptions, 'signal' | 'assertCurrent'> = {},
): Promise<CommandNeeds> {
  // Caller cancellation retires its reading, never a shared authority's cache.
  const authority = captureJudgmentPort(COMMAND_NEEDS_SITE);
  const reading = captureJudgmentPort(COMMAND_NEEDS_SITE, options);
  authority.assertCurrent();
  reading.assertCurrent();
  if (authority.identity !== reading.identity) throw new JudgmentAuthorityRetiredError();
  let cache = SEEN.get(authority.identity);
  if (!cache) { cache = new Map(); SEEN.set(authority.identity, cache); }
  const key = JSON.stringify([workspace ?? '', command]);
  const seen = cache.get(key);
  if (seen !== undefined) {
    let current = false;
    try { seen.assertCurrent(); current = true; }
    catch (error) { if (!(error instanceof JudgmentAuthorityRetiredError)) throw error; cache.delete(key); }
    reading.assertCurrent();
    if (current) return seen.needs;
  }
  const run = await sandboxNeeds.run(reading.port, { command, ...(workspace ? { workspace } : {}) }, { site: COMMAND_NEEDS_SITE, signal: reading.signal });
  reading.assertCurrent();
  const needs: CommandNeeds = Object.freeze({
    needsNetwork: run.readings.needsNetwork.verdict !== 'no',
    needsPrivilege: run.readings.needsPrivilege.verdict !== 'no',
  });
  run.recordAction(`network:${needs.needsNetwork} privilege:${needs.needsPrivilege}`);
  reading.assertCurrent();
  authority.assertCurrent();
  cache.set(key, { needs, assertCurrent: authority.assertCurrent });
  if (cache.size > SEEN_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return needs;
}

/** Forgets every remembered reading (tests, and a settings change that alters the model). */
export function forgetCommandNeeds(): void {
  SEEN = new WeakMap();
}
