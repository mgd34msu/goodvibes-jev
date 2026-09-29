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
 *    all three questions in one request:
 *      restates yes -> duplicate: the loser is merged into the survivor.
 *      conflicts yes -> contradiction, settled by `replaces`:
 *        a_replaces_b or b_replaces_a -> in one scope, when the replacing
 *                       record is at least as reviewed as the other, the
 *                       replaced record is marked stale, superseded;
 *        neither      -> both are flagged contradicted for a person.
 *      neither      -> related records that both stand: no action.
 *    The pass acts on a yes or a choice only when the reading's outcome is
 *    act. `replaces` reads the records' words and their created and updated
 *    dates; a newer date alone is not a replacement, so a newer mistaken note
 *    never silently stales the right one.
 *    The agreement is its own battery rather than a per-field question on the
 *    aligner because the aligner's fixtures check only the alignment level;
 *    a battery gives each yes and no its own labelled example.
 *
 * Bands. The aligner reads on the medium band: a wrong "same" or "review"
 * only costs one more request. `restates` and `conflicts` read on the low
 * band because they are the second gate on a pair the aligner already
 * matched, and what they trigger is reversible and receipted: a stale mark
 * with the survivor's id, or a contradicted flag that sends both records to a
 * person. `replaces` reads on the medium band: acting on it marks a record
 * stale with no person involved (reversible and receipted), where a weaker
 * reading sends the pair to a person instead. Nothing is ever deleted.
 */
import { defineBattery, defineEntityAligner, oneOf, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
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

/** The calendar day of a timestamp, as the agreement reading sees a record's dates. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * What the agreement reading sees of a record: its words and class, and when
 * it was created and last updated (so a later correction can be told from an
 * earlier statement). Never its ids, scores or review state.
 */
export function agreementContent(
  record: Pick<MemoryRecord, 'cls' | 'summary' | 'detail' | 'tags' | 'createdAt' | 'updatedAt'>,
): { [field: string]: string | string[] } {
  return { ...alignmentContent(record), created: day(record.createdAt), updated: day(record.updatedAt) };
}

/** Which of two records, if either, is a later correction or update that replaces the other. */
export const REPLACES_OPTIONS = {
  a_replaces_b: '`record_a` is a later correction or update of `record_b`: it says or clearly shows that what `record_b` states has changed or was wrong (a move, a migration, a new version, "now", "no longer", "instead"), and its dates do not contradict that.',
  b_replaces_a: '`record_b` is a later correction or update of `record_a`: it says or clearly shows that what `record_a` states has changed or was wrong (a move, a migration, a new version, "now", "no longer", "instead"), and its dates do not contradict that.',
  neither: 'Neither record says or shows that it corrects or updates the other: two claims with no sign which one is current (a newer date alone is not a correction), or records that do not disagree.',
} as const;

export type MemoryReplacement = keyof typeof REPLACES_OPTIONS;

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

/** A fixture record with the dates the agreement reading sees. */
const dated = (record: { [field: string]: string | string[] }, created: string, updated = created) => ({ ...record, created, updated });

const PORT_MOVED = { class: 'fact', summary: 'The daemon port moved from 8080 to 3421 in v2', tags: ['daemon'] };
const VITEST_NOW = { class: 'fact', summary: 'Engine tests now run with vitest; the suite moved off bun test in March', tags: ['testing'] };
const ROLLOUT_INSTEAD = { class: 'runbook', summary: 'Deploys no longer use deploy/staging.sh; run deploy/rollout.sh instead', tags: ['deploy'] };
const NODE_18 = { class: 'fact', summary: 'Node 18 is the minimum supported Node version', tags: ['runtime'] };
const NODE_20 = { class: 'fact', summary: 'Minimum Node version raised to 20 after Node 18 reached end of life', tags: ['runtime'] };
const RATE_100 = { class: 'fact', summary: 'The public API allows 100 requests per minute per key', tags: ['api'] };
const RATE_60 = { class: 'fact', summary: 'The public API allows 60 requests per minute per key', tags: ['api'] };

export const memoryAgreement = defineBattery({
  name: 'engine.state.memory-agreement',
  version: 2,
  description: 'For two project-memory records that state the same fact or variants of one fact: whether they say the same thing, whether they contradict each other, and which one, if either, is a later correction that replaces the other.',
  accuracyFloor: 0.9,
  items: {
    restates: yesNo(
      'Do `record_a` and `record_b` give the same information, so that either one alone says everything the two say together?',
      LOW.yesNo,
    ),
    conflicts: yesNo(
      'Taking each record as a statement of how things are now, do `record_a` and `record_b` say things that cannot both be true at the same time?',
      LOW.yesNo,
    ),
    replaces: oneOf(
      'Two project-memory records, `record_a` and `record_b`, each with the dates it was `created` and last `updated`. Is one of them a later correction or update that replaces the other, and which?',
      REPLACES_OPTIONS,
      MEDIUM.confidence,
    ),
  },
  fixtures: [
    {
      name: 'the same fact worded twice',
      state: { record_a: dated(BUN_TEST_AGAIN, '2026-05-10'), record_b: dated(BUN_TEST, '2026-03-01') },
      expect: { restates: 'yes', conflicts: 'no', replaces: 'neither' },
    },
    {
      name: 'two test runner claims with no stated change',
      state: { record_a: dated(VITEST, '2026-06-02'), record_b: dated(BUN_TEST, '2026-01-10') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'neither' },
    },
    {
      name: 'two default ports with no stated change',
      state: { record_a: dated(PORT, '2026-04-20'), record_b: dated(PORT_OLD, '2026-04-18') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'neither' },
    },
    {
      name: 'a newer rate limit with no stated change',
      state: { record_a: dated(RATE_60, '2026-07-14'), record_b: dated(RATE_100, '2026-02-03') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'neither' },
    },
    {
      name: 'runner and timeout facts that both hold',
      state: { record_a: dated(TEST_TIMEOUT, '2026-05-01'), record_b: dated(BUN_TEST, '2026-03-01') },
      expect: { restates: 'no', conflicts: 'no', replaces: 'neither' },
    },
    {
      name: 'the port moved in v2, after the old port was noted',
      state: { record_a: dated(PORT_OLD, '2025-11-02'), record_b: dated(PORT_MOVED, '2026-02-15') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'b_replaces_a' },
    },
    {
      name: 'the suite moved to vitest, after bun test was noted',
      state: { record_a: dated(VITEST_NOW, '2026-03-20'), record_b: dated(BUN_TEST, '2025-12-01') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'a_replaces_b' },
    },
    {
      name: 'deploys no longer use the staging script',
      state: { record_a: dated(ROLLOUT_INSTEAD, '2026-06-11'), record_b: dated(STAGING_DEPLOY, '2026-01-05', '2026-02-09') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'a_replaces_b' },
    },
    {
      name: 'the minimum Node version was raised',
      state: { record_a: dated(NODE_18, '2025-08-30'), record_b: dated(NODE_20, '2026-05-04') },
      expect: { restates: 'no', conflicts: 'yes', replaces: 'b_replaces_a' },
    },
  ],
});
