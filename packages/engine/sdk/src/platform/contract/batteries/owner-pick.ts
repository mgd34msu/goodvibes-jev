/**
 * `contract.owner-pick` (docs/design/contract-runner.md sections 6.2 and 6.3):
 * which attempt an owner's reply to an `attempts-undecided` escalation asks to
 * take. The reply was already read as asking for something other than the
 * proposal (`contract.owner-reply` amend); this reads which candidate it
 * names, by id, by position ("the second one") or by what it did.
 *
 * The selector pattern: one choice over the candidate ids plus none, and one
 * yes/no per candidate on whether the reply asks for it. `context` is
 * `{ reply, question }`; each candidate's content is `{ position, answer }`,
 * its place in the question's list and the head of the attempt's answer.
 *
 * Band: taking an attempt merges its work, so the pick is read at high
 * stakes; anything below act asks the owner again.
 */
import { defineSelector, NONE, STAKES_BANDS } from '@goodvibes-jev/judgment';

const QUESTION = [
  'Contract ctr-1a2b3c4d needs your decision on unit "Date parser".',
  'The attempts could not be chosen between with confidence.',
  'Candidates:',
  '- u2#a0 (proposed): Parses the three formats with one regular expression per format.',
  '- u2#a1: Parses the three formats with the Intl date API and a lookup table.',
  'Reply to approve taking u2#a0, to name another attempt, or to stop the contract.',
].join('\n');

const CANDIDATES = [
  { id: 'u2#a0', content: { position: 1, answer: 'Parses the three formats with one regular expression per format.' } },
  { id: 'u2#a1', content: { position: 2, answer: 'Parses the three formats with the Intl date API and a lookup table.' } },
];

const THREE_QUESTION = [
  'Contract ctr-5e6f7a8b needs your decision on unit "Resize images".',
  'The attempts could not be chosen between with confidence.',
  'Candidates:',
  '- u1#a0: Resizes with sharp, streaming each file.',
  '- u1#a1: Resizes with jimp in memory.',
  '- u1#a2: Shells out to ImageMagick convert.',
  'Reply naming the attempt to take, or to stop the contract.',
].join('\n');

const THREE = [
  { id: 'u1#a0', content: { position: 1, answer: 'Resizes with sharp, streaming each file.' } },
  { id: 'u1#a1', content: { position: 2, answer: 'Resizes with jimp in memory.' } },
  { id: 'u1#a2', content: { position: 3, answer: 'Shells out to ImageMagick convert.' } },
];

export const ownerPick = defineSelector({
  name: 'contract.owner-pick',
  version: 1,
  description: "Which attempt an owner's reply asks to take, by id, by position or by what the attempt did; or none.",
  accuracyFloor: 0.9,
  instructions: 'Which of `candidates` does the owner\'s `reply` in `context` ask to take? `position` is the candidate\'s place in the list the owner was shown in `question`.',
  fitInstructions: "Does the owner's `reply` in `context` ask to take this candidate?",
  band: STAKES_BANDS.high.confidence,
  fitBand: STAKES_BANDS.high.yesNo,
  fixtures: [
    { name: 'named by id', context: { reply: 'Take u2#a1 instead.', question: QUESTION }, candidates: CANDIDATES, expect: 'u2#a1' },
    { name: 'named by position', context: { reply: 'Go with the second one.', question: QUESTION }, candidates: CANDIDATES, expect: 'u2#a1' },
    { name: 'named by what it did', context: { reply: 'Use the regex one, not the Intl one.', question: QUESTION }, candidates: CANDIDATES, expect: 'u2#a0' },
    { name: 'the last of three by position', context: { reply: "I'd rather have the last one, the ImageMagick version.", question: THREE_QUESTION }, candidates: THREE, expect: 'u1#a2' },
    { name: 'one of three by what it did', context: { reply: 'Pick the streaming one.', question: THREE_QUESTION }, candidates: THREE, expect: 'u1#a0' },
    { name: 'asks for something none of them is', context: { reply: 'None of these; I want a version with no image library at all.', question: THREE_QUESTION }, candidates: THREE, expect: NONE },
  ],
});
