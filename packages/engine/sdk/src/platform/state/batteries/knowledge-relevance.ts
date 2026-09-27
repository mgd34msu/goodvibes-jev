/**
 * `engine.state.knowledge-relevance`: how one project-memory record relates to
 * the task an agent is about to do, read by Jev in place of the token
 * substring tests and hand-weighted point totals knowledge-injection.ts used to
 * guess with (determineReason, hasKeywordMatch, determineIngestMode,
 * scoreKnowledge and the semantic*70 bonus).
 *
 * This is the re-ranking cookbook with a fan-out: one request per shortlisted
 * record asks every question about that record, so no record becomes context
 * for another. `relevant` orders the shortlist; `task_match` and `scope_match`
 * are the evidence the injection's reason and ingest mode report. Retrieval
 * (the confidence gate, review-state exclusion and the vector index that
 * builds the shortlist) stays code in knowledge-injection.ts.
 *
 * State: `{ task, write_scope, record }` where `record` carries the memory's
 * class, summary, detail, tags and the files its provenance names.
 *
 * Band: low stakes. An injected record is framed to the agent as untrusted
 * reference material for this task only; a wrong pick costs a few prompt
 * tokens and is never acted on as policy.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

const LOW = STAKES_BANDS.low.yesNo;

const JWT_RECORD = {
  class: 'decision',
  summary: 'Auth module signs session tokens as JWTs with RS256; keys rotate monthly',
  detail: 'Private keys live in config/keys/. verifySession() in src/auth/session.ts rejects HS256 tokens.',
  tags: ['auth', 'jwt'],
  files: ['src/auth/session.ts'],
};

const RELEASE_RECORD = {
  class: 'runbook',
  summary: 'Release checklist: bump the version in package.json, run bun run build, then tag vX.Y.Z',
  detail: 'Tags must be pushed before publishing; the publish workflow reads the tag.',
  tags: ['release'],
  files: [],
};

const LOGGER_RECORD = {
  class: 'constraint',
  summary: 'Never log request bodies in src/http/logger.ts; they can carry user passwords',
  tags: ['logging', 'http'],
  files: ['src/http/logger.ts'],
};

const MIGRATION_RECORD = {
  class: 'pattern',
  summary: 'Database migrations are plain SQL files under db/migrations numbered 0001_, 0002_ and so on',
  detail: 'Each migration runs inside a transaction; never edit a migration that has shipped, add a new one.',
  tags: ['database', 'migrations'],
  files: ['db/migrations/'],
};

export const knowledgeRelevance = defineBattery({
  name: 'engine.state.knowledge-relevance',
  version: 1,
  description: 'Whether one project-memory record helps with the task at hand, and whether it matches the task itself or the files the task will write.',
  accuracyFloor: 0.9,
  items: {
    relevant: yesNo(
      'Would an agent doing `task`, and changing the files in `write_scope`, be helped by knowing `record`: a fact, decision, convention, constraint or procedure it should follow or take into account while doing that work?',
      LOW,
      {
        true: 'The record bears on how the task should be done or on what the task changes.',
        false: 'The record is about something the task does not touch; knowing it would not change how the task is done.',
      },
    ),
    task_match: yesNo(
      'Is `record` about the same subject as `task`: the same component, feature, tool, command or problem the task names?',
      LOW,
    ),
    scope_match: yesNo(
      'Is `record` about any of the files or directories listed in `write_scope`, or code that lives in them?',
      LOW,
    ),
  },
  fixtures: [
    {
      name: 'auth task meets the auth token decision',
      state: { task: 'Fix the auth module so expired session tokens are refused', write_scope: ['src/auth/session.ts'], record: JWT_RECORD },
      expect: { relevant: 'yes', task_match: 'yes', scope_match: 'yes' },
    },
    {
      name: 'auth task meets the release runbook',
      state: { task: 'Fix the auth module so expired session tokens are refused', write_scope: ['src/auth/session.ts'], record: RELEASE_RECORD },
      expect: { relevant: 'no', task_match: 'no', scope_match: 'no' },
    },
    {
      name: 'release task meets the release runbook',
      state: { task: 'Cut the 2.4.0 release', write_scope: ['package.json', 'CHANGELOG.md'], record: RELEASE_RECORD },
      expect: { relevant: 'yes', task_match: 'yes' },
    },
    {
      name: 'vague task text, but the file to edit carries a constraint',
      state: { task: 'Add the request id to every log line', write_scope: ['src/http/logger.ts'], record: LOGGER_RECORD },
      expect: { relevant: 'yes', scope_match: 'yes' },
    },
    {
      name: 'schema change task meets the migration convention',
      state: { task: 'Add a last_login_at column to the users table', write_scope: ['db/migrations/'], record: MIGRATION_RECORD },
      expect: { relevant: 'yes', scope_match: 'yes' },
    },
    {
      name: 'css task meets the migration convention',
      state: { task: 'Make the settings page buttons match the new colour palette', write_scope: ['web/src/settings.css'], record: MIGRATION_RECORD },
      expect: { relevant: 'no', task_match: 'no', scope_match: 'no' },
    },
    {
      name: 'logging task in another file meets the logger constraint',
      state: { task: 'Log slow database queries with their duration', write_scope: ['src/db/pool.ts'], record: LOGGER_RECORD },
      expect: { scope_match: 'no' },
    },
  ],
});
