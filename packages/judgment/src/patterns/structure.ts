import { assertDecisionHeader, assertUniqueFixtures, fixtureCheck, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';
import { choice, noul, type JudgmentPort, type Question } from '../port/types.ts';
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
      noul(`Does line ${lineId(index)} pick up mid-sentence, continuing a sentence left unfinished at the end of line ${lineId(index - 1)}?`, {
        true: 'The line starts in the middle of a sentence that began on the previous line; the line break tore the sentence apart',
        false: 'The line begins a new sentence, item, heading, or thought of its own',
      }),
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

interface WireAnswer {
  readonly choice?: string;
  readonly confidence?: number;
  readonly noul?: number;
}
type Answers = Readonly<Record<string, WireAnswer>>;

function toBlock(block: Merged, index: number, answers: Answers): Block {
  const id = blockId(index);
  const marked = markerType(block.text);
  const asked = answers[`type_${id}`];
  return {
    ...block,
    type: marked ?? (asked!.choice as BlockType),
    confidence: marked === undefined ? asked!.confidence! : 1,
    headingLevel: (answers[`hlevel_${id}`]?.choice ?? 'section') as HeadingLevel,
    step: answers[`step_${id}`]!.noul!,
    callout: answers[`callout_${id}`]!.choice as CalloutKind,
  };
}

async function stitch(port: JudgmentPort, spec: StructureSpec, lines: readonly Line[], options: CallOptions): Promise<Record<number, number>> {
  const questions = stitchQuestions(lines);
  if (Object.keys(questions).length === 0) return {};
  const result = await askAs(port, spec, 'structure.stitch', tag(lines, lineId), questions, options);
  const joins = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [Number(id.slice(1)), (answer as WireAnswer).noul!]));
  recordReadings(port, result, { joins });
  return joins;
}

async function classify(port: JudgmentPort, spec: StructureSpec, merged: readonly Merged[], options: CallOptions): Promise<Block[]> {
  const questions = Object.fromEntries(merged.flatMap(blockQuestions));
  const result = await askAs(port, spec, 'structure.classify', tag(merged, blockId), questions, options);
  const blocks = merged.map((block, index) => toBlock(block, index, result.answers as unknown as Answers));
  recordReadings(port, result, { types: blocks.map((block) => block.type) });
  return blocks;
}

function typesCheck(fixture: StructureSpec['fixtures'][number], blocks: readonly Block[]): FixtureCheck {
  const got = blocks.map((block) => block.type).join(',');
  return fixtureCheck(fixture.name, 'types', fixture.expect.join(','), got, Math.min(...blocks.map((block) => block.confidence)), 'act');
}

export function defineStructureRecovery(spec: StructureSpec): StructureRecovery {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  const bars: JoinBars = { afterDangling: spec.joinAfterDangling, afterTerminal: spec.joinAfterTerminal };
  const barsOrdered = 0 < bars.afterDangling && bars.afterDangling <= bars.afterTerminal && bars.afterTerminal <= 1;
  if (!barsOrdered) throw new RangeError(`structure ${spec.name}: needs 0 < joinAfterDangling <= joinAfterTerminal <= 1`);

  const recovery: StructureRecovery = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    async recover(port, text, options = {}) {
      const lines = splitLines(text);
      if (lines.length === 0) return [];
      const joins = await stitch(port, spec, lines, options);
      return classify(port, spec, mergeLines(lines, joins, bars), options);
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) checks.push(typesCheck(fixture, await recovery.recover(port, fixture.text, { ...options, site: 'calibration' })));
      return checks;
    },
  };
  return recovery;
}
