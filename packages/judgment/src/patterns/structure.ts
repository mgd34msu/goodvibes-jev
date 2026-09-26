import { checkEachFixture, decisionHeader, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';
import { choice, noul, type ChoiceResponse, type JudgmentPort, type JudgmentResult, type NoulResponse, type Question, type Questions } from '../port/types.ts';
import { orderedInUnit } from '../readings/bands.ts';
import {
  BLOCK_TYPES,
  CALLOUT_KINDS,
  HEADING_LEVELS,
  joinableLines,
  markerType,
  mergeLines,
  splitLines,
  type Block,
  type BlockType,
  type CalloutKind,
  type HeadingLevel,
  type JoinBars,
  type Line,
  type Merged,
} from './structure-blocks.ts';

/**
 * Structure recovery (the structure recovery cookbook): plain text that lost
 * its formatting is rebuilt in two requests. The first asks, for each pair of
 * adjacent lines, whether the line break split a sentence, and code merges
 * the lines into blocks; the second classifies each block (with heading
 * level, step order and callout kind asked alongside and read only when the
 * type makes them relevant). Blank lines and explicit markers are read in
 * code and never sent. Every character of the output comes from the input.
 */
export interface StructureSpec extends PatternHeader {
  /** Join probability needed after a line with no sentence-ending punctuation. */
  readonly joinAfterDangling: number;
  /** Join probability needed after a line ending in terminal punctuation. */
  readonly joinAfterTerminal: number;
  readonly fixtures: readonly { readonly name: string; readonly text: string; readonly expect: readonly BlockType[] }[];
}

export interface StructureRecovery extends NamedDecision {
  recover(port: JudgmentPort, text: string, options?: CallOptions): Promise<readonly Block[]>;
}

/** Blocks longer than this cannot render as a heading, so their heading level is not asked. */
const HEADING_MAX_CHARS = 90;
const ID_DIGITS = 3;
const lineId = (index: number) => `L${String(index).padStart(ID_DIGITS, '0')}`;
const blockId = (index: number) => `B${String(index).padStart(ID_DIGITS, '0')}`;

const tag = (items: readonly Pick<Line, 'text' | 'gap'>[], id: (index: number) => string) =>
  items.map((item, index) => `${item.gap ? '\n' : ''}${id(index)}| ${item.text}`).join('\n');

function stitchQuestions(lines: readonly Line[]): Record<string, Question> {
  return Object.fromEntries(
    joinableLines(lines).map((index) => [
      lineId(index),
      // The two lines are quoted in the question: asked by line id alone, clear continuations read near the join bar.
      noul(
        {
          question: 'Does `next` continue a sentence that `previous` leaves unfinished, so the line break falls inside one sentence?',
          previous: lines[index - 1]!.text,
          next: lines[index]!.text,
        },
        { true: 'The line break falls inside one sentence: `next` continues it', false: '`next` starts a new sentence, item, heading, or thought of its own' },
      ),
    ]),
  );
}

function blockQuestions(block: Merged, index: number): [string, Question][] {
  const id = blockId(index);
  const questions: [string, Question][] = [
    [`step_${id}`, noul(`Is block ${id} an instruction in a sequence where the order of the items matters?`)],
    [`callout_${id}`, choice(`What kind of aside is block ${id}?`, CALLOUT_KINDS)],
  ];
  if (markerType(block.text) === undefined) questions.push([`type_${id}`, choice(`What kind of content is block ${id}?`, BLOCK_TYPES)]);
  if (block.text.length <= HEADING_MAX_CHARS) {
    questions.push([`hlevel_${id}`, choice(`As a heading, what level would block ${id} occupy in this document's structure?`, HEADING_LEVELS)]);
  }
  return questions;
}

type WireAnswers = JudgmentResult<Questions>['answers'];

const choiceAt = (answers: WireAnswers, key: string): ChoiceResponse | undefined => answers[key] as ChoiceResponse | undefined;
const yesAt = (answers: WireAnswers, key: string): number => (answers[key] as NoulResponse).noul;

function toBlock(block: Merged, index: number, answers: WireAnswers): Block {
  const id = blockId(index);
  const marked = markerType(block.text);
  const asked = choiceAt(answers, `type_${id}`);
  return {
    ...block,
    type: marked ?? (asked!.choice as BlockType),
    confidence: marked === undefined ? asked!.confidence : 1,
    headingLevel: (choiceAt(answers, `hlevel_${id}`)?.choice ?? 'section') as HeadingLevel,
    step: yesAt(answers, `step_${id}`),
    callout: choiceAt(answers, `callout_${id}`)!.choice as CalloutKind,
  };
}

async function stitch(port: JudgmentPort, spec: StructureSpec, lines: readonly Line[], options: CallOptions): Promise<Record<number, number>> {
  const questions = stitchQuestions(lines);
  if (Object.keys(questions).length === 0) return {};
  const result = await askAs(port, spec, 'structure.stitch', tag(lines, lineId), questions, options);
  const joins = Object.fromEntries(Object.keys(result.answers).map((id) => [Number(id.slice(1)), yesAt(result.answers, id)]));
  recordReadings(port, result, { joins });
  return joins;
}

async function classify(port: JudgmentPort, spec: StructureSpec, merged: readonly Merged[], options: CallOptions): Promise<Block[]> {
  const questions = Object.fromEntries(merged.flatMap(blockQuestions));
  const result = await askAs(port, spec, 'structure.classify', tag(merged, blockId), questions, options);
  const blocks = merged.map((block, index) => toBlock(block, index, result.answers));
  recordReadings(port, result, { types: blocks.map((block) => block.type) });
  return blocks;
}

function typesCheck(fixture: StructureSpec['fixtures'][number], blocks: readonly Block[]): FixtureCheck {
  const got = blocks.map((block) => block.type).join(',');
  return fixtureCheck(fixture.name, 'types', fixture.expect.join(','), got, Math.min(...blocks.map((block) => block.confidence)), 'act');
}

export function defineStructureRecovery(spec: StructureSpec): StructureRecovery {
  const header = decisionHeader(spec);
  const bars: JoinBars = { afterDangling: spec.joinAfterDangling, afterTerminal: spec.joinAfterTerminal };
  const barsOrdered = bars.afterDangling > 0 && orderedInUnit([bars.afterDangling, bars.afterTerminal]);
  if (!barsOrdered) throw new RangeError(`structure ${spec.name}: needs 0 < joinAfterDangling <= joinAfterTerminal <= 1`);

  const recovery: StructureRecovery = {
    ...header,
    async recover(port, text, options = {}) {
      const lines = splitLines(text);
      if (lines.length === 0) return [];
      const joins = await stitch(port, spec, lines, options);
      return classify(port, spec, mergeLines(lines, joins, bars), options);
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => typesCheck(fixture, await recovery.recover(port, fixture.text, run))),
  };
  return recovery;
}
