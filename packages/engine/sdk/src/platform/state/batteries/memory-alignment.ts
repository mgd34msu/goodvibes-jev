/**
 * Duplicate and contradiction detection for idle memory consolidation, read by
 * Jev in place of memory-consolidation.ts normalizeKey (lowercase, strip
 * punctuation) and its exact-string comparison of two records' summaries and
 * details.
 *
 * Two decisions, composed in code (memory-consolidation.ts classifyPair):
 *
 * 1. `engine.state.memory-alignment`, the entity alignment pattern with the
 *    noun "fact": are two records the same fact? Its levels map as follows:
 *      distinct -> unrelated: no action, and no second request.
 *      review   -> closely related: a variant of one fact, such as an older or
 *                  newer answer to the same question. The pair goes to
 *                  question 2, where a contradiction shows up.
 *      same     -> the same fact: the pair goes to question 2, where a
 *                  duplicate shows up.
 *    A weak reading on any level is review (the pattern's rule), so an unsure
 *    pair is still checked by question 2 rather than merged on a guess.
 *
 * 2. `engine.state.memory-agreement`, asked only about a same or review pair,
 *    both questions in one request:
 *      restates yes -> duplicate: the loser is merged into the survivor.
 *      conflicts yes -> contradiction: newer verified wins, else both are
 *                       flagged for a person.
 *      neither      -> related records that both stand: no action.
 *    The pass acts on a yes only when the reading's outcome is act.
 *    The agreement is its own battery rather than a per-field question on the
 *    aligner because the aligner's fixtures check only the alignment level;
 *    a battery gives each yes and no its own labelled example.
 *
 * Bands. The aligner reads on the medium band: a wrong "same" or "review"
 * only costs one more request. The agreement reads on the low band because
 * it is the second gate on a pair the aligner already matched, and what it
 * triggers is reversible and receipted: a stale mark with the survivor's id,
 * or a contradicted flag that sends both records to a person. Nothing is ever
 * deleted.
 */
import { defineBattery, defineEntityAligner, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { MemoryRecord } from '../memory-store.js';

const MEDIUM = STAKES_BANDS.medium;
const LOW = STAKES_BANDS.low;

/** What the readings see of a record: its words and class, never its ids, scores or timestamps. */
export function alignmentContent(record: Pick<MemoryRecord, 'cls' | 'summary' | 'detail' | 'tags'>): { [field: string]: string | string[] } {
  return {
    class: record.cls,
    summary: record.summary,
    ...(record.detail ? { detail: record.detail } : {}),
    tags: [...record.tags],
  };
}

const BUN_TEST = { class: 'fact', summary: 'The engine test suite runs with bun test', tags: ['testing'] };
const BUN_TEST_AGAIN = { class: 'fact', summary: 'Engine tests are run with `bun test`', tags: ['testing', 'engine'] };
const VITEST = { class: 'fact', summary: 'The engine test suite runs with vitest', detail: 'Run npx vitest from packages/engine.', tags: ['testing'] };
const TEST_TIMEOUT = { class: 'fact', summary: 'Engine tests have a 5 second default timeout per test', tags: ['testing'] };
const PORT = { class: 'fact', summary: 'The daemon listens on port 3421 by default', tags: ['daemon'] };
const PORT_AGAIN = { class: 'fact', summary: 'Default daemon port: 3421', tags: ['daemon', 'config'] };
const PORT_OLD = { class: 'fact', summary: 'Daemon default port is 8080', tags: ['daemon'] };
const RELEASE = { class: 'runbook', summary: 'Release: bump package.json, run bun run build, tag vX.Y.Z', tags: ['release'] };
const STAGING_DEPLOY = { class: 'runbook', summary: 'Deploys go out through deploy/staging.sh', detail: 'Run it from the repo root after the build finishes.', tags: ['deploy'] };
const PROD_DEPLOY = { class: 'runbook', summary: 'Production deploys run deploy/rollout.sh with a blue-green switch', tags: ['deploy', 'production'] };

export const memoryAlignment = defineEntityAligner({
  name: 'engine.state.memory-alignment',
  version: 1,
  description: 'Whether two project-memory records state the same fact, closely related variants of one fact (such as an older and a newer answer), or different facts.',
  accuracyFloor: 0.9,
  noun: 'fact',
  fields: [],
  band: MEDIUM.confidence,
  fixtures: [
    { name: 'the same test runner fact worded twice', a: BUN_TEST, b: BUN_TEST_AGAIN, expect: 'same' },
    { name: 'two answers to which test runner', a: BUN_TEST, b: VITEST, expect: 'review' },
    { name: 'two answers to the default port', a: PORT, b: PORT_OLD, expect: 'review' },
    { name: 'the default port worded twice', a: PORT, b: PORT_AGAIN, expect: 'same' },
    { name: 'test runner and release steps', a: BUN_TEST, b: RELEASE, expect: 'distinct' },
    { name: 'daemon port and test runner', a: PORT, b: VITEST, expect: 'distinct' },
    { name: 'a deploy script that may be the staging one or the only one', a: STAGING_DEPLOY, b: PROD_DEPLOY, expect: 'review' },
  ],
});

export const memoryAgreement = defineBattery({
  name: 'engine.state.memory-agreement',
  version: 1,
  description: 'For two project-memory records that state the same fact or variants of one fact: whether they say the same thing, and whether they contradict each other.',
  accuracyFloor: 0.9,
  items: {
    restates: yesNo(
      'Do `record_a` and `record_b` give the same information, so that either one alone says everything the two say together?',
      LOW.yesNo,
    ),
    conflicts: yesNo(
      'Do `record_a` and `record_b` say things that cannot both be true at the same time?',
      LOW.yesNo,
    ),
  },
  fixtures: [
    { name: 'the same fact worded twice', state: { record_a: BUN_TEST, record_b: BUN_TEST_AGAIN }, expect: { restates: 'yes', conflicts: 'no' } },
    { name: 'two different test runners', state: { record_a: BUN_TEST, record_b: VITEST }, expect: { restates: 'no', conflicts: 'yes' } },
    { name: 'two different default ports', state: { record_a: PORT, record_b: PORT_OLD }, expect: { restates: 'no', conflicts: 'yes' } },
    { name: 'runner and timeout facts that both hold', state: { record_a: BUN_TEST, record_b: TEST_TIMEOUT }, expect: { restates: 'no', conflicts: 'no' } },
  ],
});
