/**
 * `engine.tools.memory-class`: the state tool mirrors a `mode=memory
 * action=set` write into a retrievable memory record; this reading chooses
 * the record's class from the memory store's closed set (decision,
 * constraint, incident, pattern, fact, risk, runbook, architecture,
 * ownership). It replaces filing every such record as `fact` whatever it
 * says, so a rule the user set ("never push to main") was retrieved and
 * reviewed as a plain fact.
 *
 * Band: low stakes. The class files a fresh, unreviewed record for retrieval
 * and review; a wrong class is corrected in review and never changes what
 * the flat memory file holds. A reading that acts or confirms files the
 * record under its class; a reading that escalates files it as `fact`, the
 * class that claims nothing beyond the statement being recorded.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';
import type { MemoryClass } from '../../state/memory-store.js';

/** Most characters of the memory value the reading carries. */
export const MAX_JUDGED_MEMORY_CHARS = 1_500;

export const MEMORY_CLASS_OPTIONS = {
  decision: 'A choice that was made and why (a library, design or approach picked over others).',
  constraint: 'A rule or preference that must be followed (always, never, must, do not; a required tool, style or process).',
  incident: 'Something that went wrong at a point in time (an outage, a failed deploy, a bug that hit users) and what happened.',
  pattern: 'How things are usually done in this code (a recurring structure, idiom or convention to copy).',
  fact: 'A plain piece of information (a name, a location, a value, a version) with no rule, choice or event in it.',
  risk: 'A known weakness or danger that could cause harm later (a missing check, a fragile dependency, a possible data loss).',
  runbook: 'Steps to carry out a task or procedure (how to deploy, rotate a key, restore a backup).',
  architecture: 'How the system is built: its components, how they connect and where responsibilities sit.',
  ownership: 'Who owns, maintains or is responsible for something (a team or person for a module or service).',
} as const satisfies Record<MemoryClass, string>;

/** What the reading sees: the memory key and the value being written. */
export function memoryClassView(key: string, value: string): { key: string; value: string } {
  return { key, value: value.length <= MAX_JUDGED_MEMORY_CHARS ? value : `${value.slice(0, MAX_JUDGED_MEMORY_CHARS)}...` };
}

export const memoryClass = defineBattery({
  name: 'engine.tools.memory-class',
  version: 1,
  description: 'Which memory class a project memory written through the state tool belongs to.',
  accuracyFloor: 0.85,
  items: {
    memory_class: oneOf(
      '`value` is a project memory an AI coding agent saved under the name `key` so it can be recalled in later sessions. What kind of memory is it?',
      MEMORY_CLASS_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'database choice', state: memoryClassView('db-choice', 'We chose Postgres over MongoDB because orders need multi-row transactions.'), expect: { memory_class: 'decision' } },
    { name: 'never push to main', state: memoryClassView('git-rule', 'Never push directly to main; every change goes through a pull request.'), expect: { memory_class: 'constraint' } },
    { name: 'package manager preference', state: memoryClassView('tooling', 'Always use bun, not npm or yarn, for installs and scripts in this repo.'), expect: { memory_class: 'constraint' } },
    { name: 'session outage', state: memoryClassView('outage-2026-03', 'On 2026-03-14 Redis ran out of memory, evicted session keys, and every user was logged out for 40 minutes.'), expect: { memory_class: 'incident' } },
    { name: 'handler convention', state: memoryClassView('handlers', 'Route handlers validate the body with a zod schema, then call one service function and map its result to a response.'), expect: { memory_class: 'pattern' } },
    { name: 'staging host', state: memoryClassView('staging-db', 'The staging database host is db.staging.internal on port 5433.'), expect: { memory_class: 'fact' } },
    { name: 'webhook without retry', state: memoryClassView('webhooks', 'The payment webhook handler has no retry or dead-letter queue, so a crash mid-request loses the event.'), expect: { memory_class: 'risk' } },
    { name: 'key rotation steps', state: memoryClassView('rotate-key', 'To rotate the signing key: generate a new key with scripts/keygen.sh, add it to the vault, deploy, then remove the old key after 24 hours.'), expect: { memory_class: 'runbook' } },
    { name: 'daemon and clients', state: memoryClassView('layout', 'The daemon owns all state and serves the TUI and web UI over HTTP; the SDK is embedded in the daemon and the clients only render.'), expect: { memory_class: 'architecture' } },
    { name: 'billing owner', state: memoryClassView('billing-owner', 'The billing module is owned by the payments team; Alice reviews every change to it.'), expect: { memory_class: 'ownership' } },
  ],
});
