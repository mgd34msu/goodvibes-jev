import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** Every group is read independently; the caller requires exactly one settled yes. */
export const registryCatalogGroupFit = defineRerank({
  name: 'engine.tools.registry-catalog-group',
  version: 1,
  description: 'Reads whether a complete original catalog category contains any action intended by the original lookup, without selecting an action or granting permission.',
  accuracyFloor: 0.95,
  instructions: 'The query is the complete original lookup string, or an object with query and contextJson containing JSON text of the complete original arguments. The candidate.evidenceJson is JSON text whose record is one complete original category, including every original action in record.actions. Read that complete JSON record. Does this category contain any action intended by the lookup? Read the action meanings and all original fields. A category label or shared word alone does not fit. Answer yes when at least one original action fits, even if two actions in this category fit or another category may also fit. Do not resolve ambiguity by guessing a preferred action or category. Every category receives this independent reading. The caller holds uncertain readings, returns none when zero or multiple categories fit, and uses a separate explicit action selection when exactly one category fits. This reading grants no permission and executes no route.',
  criteria: {
    true: 'At least one original action in this complete category provides what the complete lookup asks for. Multiple fitting actions still make this category a yes and remain unresolved for later action selection.',
    false: 'No original action in this complete category provides what the lookup asks for. A matching category label, shared word, or related topic does not make an unrelated action fit.',
  },
  band: STAKES_BANDS.low.yesNo,
  // Native mapLimit rejects before concurrent siblings drain. One reader at a
  // time keeps source custody until every started category read has settled.
  concurrency: 1,
  fixtures: [
    { name: 'a matching category label cannot invent a fitting action', query: 'inspect pending approvals and running work', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'work', label: 'Work and approvals', actions: [
        { id: 'weather-observations', label: 'Weather', detail: 'Read recorded weather observations.' },
      ] } }) } },
    ], expect: { top: 'none' } },
    { name: 'an action fits despite an unrelated category label', query: 'inspect pending approvals and running work', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'opaque-category', label: 'General operations', actions: [
        { id: 'supervised-work', label: 'Supervised work', detail: 'Inspect pending approvals and current running work.' },
      ] } }) } },
    ], expect: { top: '0' } },
    { name: 'the original action identity identifies a fitting category', query: 'inspect the action with id supervised-work', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'second', label: 'Review', actions: [
        { id: 'supervised-work', label: 'Supervised work', detail: 'Inspect pending approvals and current running work.' },
      ] } }) } },
    ], expect: { top: '0' } },
    { name: 'indistinguishable actions within a category still require its affirmative reading', query: 'inspect my saved notes', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'notes', label: 'Notes', actions: [
        { id: 'first-notes', label: 'Saved notes', detail: 'Inspect saved notes.' },
        { id: 'second-notes', label: 'Saved notes', detail: 'Inspect saved notes.' },
      ] } }) } },
    ], expect: { top: '0' } },
    { name: 'a fitting action is affirmative independently of another category', query: 'inspect my saved notes', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'personal', label: 'Personal', actions: [
        { id: 'personal-notes', label: 'Saved notes', detail: 'Inspect saved notes.' },
      ] } }) } },
    ], expect: { top: '0' } },
    { name: 'the other indistinguishable category is also affirmative', query: 'inspect my saved notes', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'workspace', label: 'Workspace', actions: [
        { id: 'workspace-notes', label: 'Saved notes', detail: 'Inspect saved notes.' },
      ] } }) } },
    ], expect: { top: '0' } },
    { name: 'an absent action rejects the category', query: 'book a flight', candidates: [
      { id: '0', content: { evidenceJson: JSON.stringify({ record: { id: 'research', label: 'Research', actions: [
        { id: 'weather', label: 'Weather observations', detail: 'Read recorded weather observations.' },
      ] } }) } },
    ], expect: { top: 'none' } },
  ],
});
