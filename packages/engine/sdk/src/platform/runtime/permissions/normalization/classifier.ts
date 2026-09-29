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
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { sandboxNeeds } from '../../../gate/batteries/sandbox-needs.js';

export interface CommandNeeds {
  /** It reaches the network (uncertain counts as yes). */
  readonly needsNetwork: boolean;
  /** It needs host administrator privileges (uncertain counts as yes). */
  readonly needsPrivilege: boolean;
}

const SEEN = new Map<string, CommandNeeds>();
const SEEN_LIMIT = 256;

/** The decision site the sandbox's command readings are logged under. */
export const COMMAND_NEEDS_SITE = 'engine.gate.sandbox-needs';

/** Reads what host access one shell command needs; a command read before is not asked again. */
export async function readCommandNeeds(command: string, workspace?: string): Promise<CommandNeeds> {
  const key = `${workspace ?? ''}\u0000${command}`;
  const seen = SEEN.get(key);
  if (seen !== undefined) return seen;
  const run = await sandboxNeeds.run(judgmentPort(COMMAND_NEEDS_SITE), { command, ...(workspace ? { workspace } : {}) }, { site: COMMAND_NEEDS_SITE });
  const needs = {
    needsNetwork: run.readings.needsNetwork.verdict !== 'no',
    needsPrivilege: run.readings.needsPrivilege.verdict !== 'no',
  };
  run.recordAction(`network:${needs.needsNetwork} privilege:${needs.needsPrivilege}`);
  SEEN.set(key, needs);
  if (SEEN.size > SEEN_LIMIT) SEEN.delete(SEEN.keys().next().value!);
  return needs;
}

/** Forgets every remembered reading (tests, and a settings change that alters the model). */
export function forgetCommandNeeds(): void {
  SEEN.clear();
}
