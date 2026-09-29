/**
 * `terminal-shell.cluster-join-group`: which discovered cluster group a
 * person's typed answer to "which group? (name or id)" refers to, or none.
 * Read by Jev in place of the exact display-name match and the first-match
 * group id prefix test cluster-commands.ts used. Two tests stay code and run
 * first: an id typed in full is that id, and a prefix that starts exactly one
 * group's id is that id's abbreviation (the way a short commit hash is).
 *
 * The selector's per-candidate fit check must agree with its pick, so two
 * groups that share a display name come back as none rather than the first.
 *
 * Band: medium. A wrong pick tries the join against another group; the join
 * key the person types does not open that group, so the join fails and they
 * pick again. Nothing changes on the wrong group.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

const group = (groupId: string, displayName: string, machines: number, version: string, seen: string) => ({
  id: groupId,
  content: { groupId, displayName, machines, version, seen },
});

const HOME = group('g-7f3a91c2e4b0d855', 'home-lab', 3, '2.0.21', '4s ago');
const OFFICE = group('g-19c0e2aa73f14b60', 'office', 2, '2.0.21', '9s ago');
const OFFICE_TWIN = group('g-5d2b08f1c9e7a344', 'office', 1, '2.0.19', '2m ago');
const STUDIO = group('g-a4e6b1d03f8c2977', 'Studio Macs', 4, '2.0.21', '1s ago');

export const clusterJoinGroup = defineSelector({
  name: 'terminal-shell.cluster-join-group',
  version: 1,
  description: 'Which discovered cluster group a person\'s typed answer names, or none.',
  accuracyFloor: 0.85,
  instructions: 'A person was shown the goodvibes cluster groups advertising on their network and asked "which group? (name or id)". `context.answer` is what they typed. Which of `candidates` (each a group with its id, display name, machine count, version and when it was last seen) does the answer name?',
  fitInstructions: 'Does the person\'s typed `context.answer` name this group, and no other group in the list just as well?',
  band: STAKES_BANDS.medium.confidence,
  fitBand: STAKES_BANDS.medium.yesNo,
  fixtures: [
    { name: 'display name typed exactly', context: { answer: 'home-lab' }, candidates: [HOME, OFFICE], expect: HOME.id },
    { name: 'display name typed loosely', context: { answer: 'the studio macs' }, candidates: [HOME, STUDIO], expect: STUDIO.id },
    { name: 'named with a typo', context: { answer: 'hom-lab' }, candidates: [HOME, OFFICE], expect: HOME.id },
    { name: 'described by its size', context: { answer: 'the one with four machines' }, candidates: [HOME, OFFICE, STUDIO], expect: STUDIO.id },
    { name: 'two groups share the name', context: { answer: 'office' }, candidates: [HOME, OFFICE, OFFICE_TWIN], expect: NONE },
    { name: 'names a group that is not there', context: { answer: 'garage' }, candidates: [HOME, OFFICE], expect: NONE },
  ],
});
