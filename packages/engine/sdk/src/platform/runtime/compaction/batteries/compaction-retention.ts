/**
 * `engine.compaction.retention`: how much of what the work depends on does a
 * compacted conversation still carry? One rated rubric over
 * `{ source, compacted }`, both rendered by compaction views
 * (judged-views.ts): `source` numbers every pre-compaction message, and
 * `compacted` shows the text the compaction wrote and names the messages it
 * kept unchanged by those numbers.
 *
 * The quality score uses the reading's normalized score (probability weighted
 * across the levels) as the substance the compaction carries (quality-score.ts).
 *
 * Band: low stakes. A low score only re-runs a compaction strategy or keeps
 * the full conversation, both reversible.
 */
import { defineBattery, rated, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** The rubric, lowest first; the level index is the score. */
export const RETENTION_LEVELS = [
  'None: from `compacted` alone one could not tell what the task is',
  'Little: the task is recognisable, but what was found, what was decided or what is left to do is missing',
  'Most: the task, the findings, the decisions and the open work are all described, but an exact name, path or value from `source` that the open work needs is missing or only described vaguely',
  'All: every fact, decision, constraint and open step in `source` that the work still needs is there, with the exact names, paths and values the open work needs',
] as const;

const DEBUG_MESSAGES = [
  '#1 user: The nightly backup job fails with "EACCES: permission denied, open /var/backups/app/db.dump". Find out why and fix it without running anything as root.',
  '#2 assistant: [calls exec {"command":"ls -ld /var/backups/app"}]',
  '#3 tool result (exec): drwxr-xr-x 2 root root 4096 Sep 20 03:00 /var/backups/app',
  '#4 assistant: The directory is owned by root and the job runs as the app user. Options: change the owner, or write to a directory the app user owns.',
  '#5 user: Do not change ownership under /var. Write the dump to /srv/app/backups instead and keep 7 days of dumps.',
  '#6 assistant: Updated scripts/backup.sh to write to /srv/app/backups and delete dumps older than 7 days. Still to do: update the systemd unit ReadWritePaths so the new path is allowed.',
];
const DEBUG_SESSION = DEBUG_MESSAGES.join('\n\n');

export const compactionRetention = defineBattery({
  name: 'engine.compaction.retention',
  version: 1,
  description: 'How much of what the ongoing work depends on a compacted conversation still carries, compared with the conversation before compaction.',
  accuracyFloor: 0.9,
  items: {
    substance: rated(
      '`source` is a conversation before compaction, with numbered messages. `compacted` is what replaced it: text the compaction wrote, plus markers naming source messages it kept unchanged. How much of what the work in `source` still depends on (the task, what was found, what was decided, constraints, and what is left to do) does `compacted` carry?',
      RETENTION_LEVELS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    {
      name: 'collapse that found no exchange',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Collapse: 2026-09-27T03:10:00.000Z]\nSession: s-81f2\n6 message(s) collapsed to reduce context from ~2400 tokens.\n\n## Most Recent Exchange\n(no user/assistant exchange found)\n\n## Context Note\nThe full conversation history has been collapsed. Please resume from the above context.',
      },
      expect: { substance: 0 },
    },
    {
      name: 'mechanical note that kept only small talk',
      state: {
        source: `${DEBUG_SESSION}\n\n#7 user: thanks\n\n#8 assistant: You're welcome.`,
        compacted: '[Session Micro-Compaction]\n6 earlier message(s) were summarised to reduce context size.\nThe conversation continues from the most recent 2 messages.\n\n[messages #7 to #8 of the source, unchanged]',
      },
      expect: { substance: 0 },
    },
    {
      name: 'summary with the task and nothing after it',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Summary]\nTask: the nightly backup job fails with EACCES writing /var/backups/app/db.dump; fix it without running anything as root.',
      },
      expect: { substance: 1 },
    },
    {
      name: 'summary that loses the open step and a constraint',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Summary]\nThe nightly backup failed with EACCES writing to /var/backups/app. scripts/backup.sh now writes to /srv/app/backups.',
      },
      expect: { substance: 1 },
    },
    {
      name: 'summary that loses the new backup path the open step needs',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Summary]\nTask: the nightly backup failed with EACCES because /var/backups/app is owned by root and the job runs as the app user. Fix without running anything as root.\nDecided: do not change ownership under /var; write dumps to a different directory the app user owns and keep 7 days. scripts/backup.sh is updated.\nOpen: update the systemd unit ReadWritePaths so the new backup directory is allowed.',
      },
      expect: { substance: 2 },
    },
    {
      name: 'handoff keeping the recent messages that hold everything',
      state: {
        source: `#1 user: hi, are you there?\n\n#2 assistant: Yes. What would you like to work on?\n\n${DEBUG_MESSAGES.map((line) => line.replace(/^#(\d+)/, (_, n: string) => `#${Number(n) + 2}`)).join('\n\n')}`,
        compacted: '[Session Auto-Compaction]\n2 earlier message(s) compacted to reduce context size.\nRetaining the 6 most recent messages.\n\n[messages #3 to #8 of the source, unchanged]',
      },
      expect: { substance: 3 },
    },
    {
      name: 'summary carrying every fact',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Summary]\nTask: the nightly backup job failed with "EACCES: permission denied, open /var/backups/app/db.dump"; fix it without running anything as root.\nFound: /var/backups/app is drwxr-xr-x root:root and the job runs as the app user.\nDecided: do not change ownership under /var; write dumps to /srv/app/backups and keep 7 days. scripts/backup.sh now does both.\nOpen: update the systemd unit ReadWritePaths so /srv/app/backups is allowed.',
      },
      expect: { substance: 3 },
    },
    {
      name: 'summary in its own words without the directory listing',
      state: {
        source: DEBUG_SESSION,
        compacted: '[Session Summary]\nTask: the nightly backup failed with EACCES because /var/backups/app is owned by root and the job runs as the app user. Fix without running anything as root.\nDecided: do not change ownership under /var; dumps go to /srv/app/backups and dumps older than 7 days are deleted. scripts/backup.sh is updated.\nOpen: update the systemd unit ReadWritePaths to allow /srv/app/backups.',
      },
      expect: { substance: 3 },
    },
  ],
});
