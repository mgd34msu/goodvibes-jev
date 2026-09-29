/**
 * `engine.ecosystem.trust-note-caution`: does a catalog entry's trust note
 * warn about something a person should weigh before installing it? Read by
 * Jev in place of the `entry.trustNotes ||` half of riskLevel in
 * reviewEcosystemCatalogEntry, which marked every entry with any trust note
 * at all as medium risk, including notes that only reassure ("Maintained by
 * the core team, no network access").
 *
 * One yes/no per entry that has a trust note. The other half of riskLevel
 * (a remote source is medium) stays code in catalog.ts, and an entry with no
 * trust note takes no reading.
 *
 * Band: low stakes. riskLevel is a display label ("risk low" or "risk medium")
 * shown beside the note text itself; nothing is installed or refused on it.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';
import type { EcosystemEntryKind } from '../catalog.js';

const note = (name: string, kind: EcosystemEntryKind, trustNotes: string) => ({ name, kind, trustNotes });

export const trustNoteCaution = defineBattery({
  name: 'engine.ecosystem.trust-note-caution',
  version: 1,
  description: "Whether an ecosystem catalog entry's trust note warns about something to weigh before installing it.",
  accuracyFloor: 0.9,
  items: {
    cautions: yesNo(
      '`trustNotes` is what the catalog author wrote about trusting the catalog entry `name` (a `kind`). Does the note warn about something a person should weigh before installing it, such as elevated access, unreviewed or third-party code, network or credential use, or a stated limit on how far it can be trusted?',
      STAKES_BANDS.low.yesNo,
      {
        true: 'The note raises a caution about installing or running the entry.',
        false: 'The note is reassurance, provenance or neutral information with no caution in it.',
      },
    ),
  },
  fixtures: [
    { name: 'runs shell commands without asking', state: note('Auto fixer', 'hook-pack', 'Runs shell commands after every edit without asking for approval.'), expect: { cautions: 'yes' } },
    { name: 'third-party code not reviewed', state: note('Community lint', 'plugin', 'Contributed by a third party; the code has not been reviewed by the catalog maintainers.'), expect: { cautions: 'yes' } },
    { name: 'sends data to an outside service', state: note('Usage insights', 'plugin', 'Sends file names and command history to an external analytics service.'), expect: { cautions: 'yes' } },
    { name: 'reads stored credentials', state: note('Cloud deploy', 'plugin', 'Reads your cloud provider credentials from the local keychain to push releases.'), expect: { cautions: 'yes' } },
    { name: 'loosens approval rules', state: note('Fast lane', 'policy-pack', 'Auto-approves writes anywhere in the home directory. Only use on a throwaway machine.'), expect: { cautions: 'yes' } },
    { name: 'experimental, may delete files', state: note('Workspace cleaner', 'skill', 'Experimental. It can remove files it believes are build output; commit your work first.'), expect: { cautions: 'yes' } },
    { name: 'maintained by the core team, no network', state: note('Code review', 'skill', 'Maintained by the core team. Reads the diff only and makes no network requests.'), expect: { cautions: 'no' } },
    { name: 'signed release with a pinned hash', state: note('GitHub provider', 'plugin', 'Signed by the GoodVibes release key; the bundle hash is pinned in the catalog.'), expect: { cautions: 'no' } },
    { name: 'plain provenance', state: note('Solarized theme', 'plugin', 'Ported from the Solarized project, MIT licensed.'), expect: { cautions: 'no' } },
    { name: 'read-only by design', state: note('Read-only shell', 'policy-pack', 'This pack only narrows what the agent may do; it never grants new access.'), expect: { cautions: 'no' } },
    { name: 'audited and sandboxed', state: note('Format on save', 'hook-pack', 'Audited in March 2026. Runs inside the sandbox with no network access.'), expect: { cautions: 'no' } },
    { name: 'neutral version note', state: note('Docs writer', 'skill', 'Tested with GoodVibes 0.9 and later on Linux and macOS.'), expect: { cautions: 'no' } },
  ],
});
