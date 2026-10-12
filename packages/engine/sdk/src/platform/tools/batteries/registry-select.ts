import { defineSelector, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const registrySelect = defineSelector({
  name: 'engine.tools.registry-select',
  version: 1,
  description: 'Selects one existing catalog record meant by a free-text lookup, or none when the available records do not settle that lookup.',
  accuracyFloor: 0.95,
  instructions: 'The context contains the complete lookup query and available catalog records. Select the one candidate the query means. Read its complete meaning and evidence, rather than matching shared words. Choose none if no record fits or the query does not distinguish one record. Candidate IDs are local indexes. Selecting a record grants no permission and does not execute any route.',
  fitInstructions: 'Does this existing candidate actually represent the record requested by the complete query, including its purpose, state, and supplied evidence? A shared word or a suggested action is insufficient.',
  band: STAKES_BANDS.low.confidence,
  fitBand: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'mail wording does not select the unrelated server', context: { query: 'the server that searches my mailbox' }, candidates: [
      { id: '0', content: { name: 'mail', description: 'Weather observations only.' } },
      { id: '1', content: { name: 'opaque-server', description: 'Search and inspect messages in a mailbox.' } },
    ], expect: '1' },
    { name: 'an account problem selects its complete posture', context: { query: 'the account whose subscription has expired' }, candidates: [
      { id: '0', content: { name: 'first', description: 'Healthy subscription, no issues.' } },
      { id: '1', content: { name: 'second', description: 'Expired subscription; direct API route is active as fallback.' } },
    ], expect: '1' },
    { name: 'subdirectory guidance selects the relevant context body', context: { query: 'instructions for the package deployment scripts' }, candidates: [
      { id: '0', content: { name: 'root', description: 'Root guidance for formatting application source.' } },
      { id: '1', content: { name: 'nested', description: 'Package deployment instructions, including release script checks.' } },
    ], expect: '1' },
    { name: 'blocked capability is still inspectable', context: { query: 'inspect the unavailable host filesystem operation' }, candidates: [
      { id: '0', content: { name: 'read', description: 'Allowed read-only operator briefing.' } },
      { id: '1', content: { name: 'filesystem', description: 'Blocked arbitrary host filesystem access, available for inspection only.' } },
    ], expect: '1' },
    { name: 'no matching record', context: { query: 'a server that books flights' }, candidates: [
      { id: '0', content: { name: 'weather', description: 'Read weather observations.' } },
      { id: '1', content: { name: 'mail', description: 'Read mailbox messages.' } },
    ], expect: 'none' },
    { name: 'ambiguous accounts have no settled selection', context: { query: 'the healthy account' }, candidates: [
      { id: '0', content: { name: 'first', description: 'Healthy provider account.' } },
      { id: '1', content: { name: 'second', description: 'Healthy provider account.' } },
    ], expect: 'none' },
  ],
});
