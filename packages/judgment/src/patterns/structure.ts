import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { choice, noul, type JudgmentPort, type Question } from '../port/types.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

export type BlockType = 'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'callout';

const BLOCK_TYPES: Readonly<Record<BlockType, string>> = {
  heading: 'A short label or title that names the document or the section that follows it, not a full sentence of content',
  paragraph: 'Running prose: one or more complete sentences of explanatory or narrative text',
  list_item: 'One entry in a list of parallel items; reads as one of several sibling entries',
  quote: 'Words attributed to a person or source: quoted speech, a citation, an excerpt someone else wrote',
  code: 'Computer code, a shell command, terminal output, or a config snippet meant to be read verbatim',
  callout: 'A warning, tip, or important note that interrupts the flow to flag something the reader must not miss',
};
const HEADING_LEVELS = { title: 'The title of the whole document', section: 'A major section heading', subsection: 'A minor heading under a section' };
const CALLOUT_KINDS = { note: 'Neutral extra information', tip: 'A helpful suggestion or shortcut', warning: 'A caution about something that can go wrong' };

export interface Line {
  readonly text: string;
  /** A blank line came before it. */
  readonly gap: boolean;
}

export interface Block {
  readonly text: string;
  readonly lines: readonly number[];
  readonly gap: boolean;
  readonly type: BlockType;
  /** Confidence behind the type; 1 when an explicit marker settled it in code. */
  readonly confidence: number;
  readonly headingLevel: keyof typeof HEADING_LEVELS;
  /** Probability that a list item is one step of an ordered procedure. */
  readonly step: number;
  readonly callout: keyof typeof CALLOUT_KINDS;
}

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

const MARKERS: readonly [RegExp, BlockType][] = [
  [/^#{1,6}\s/, 'heading'],
  [/^([-*•]|\d+[.)])\s/, 'list_item'],
  [/^>\s?/, 'quote'],
];
const markerType = (text: string): BlockType | undefined => MARKERS.find(([pattern]) => pattern.test(text))?.[1];
const TERMINAL = /[.!?:;…]["')\]]*$/;
const HEADING_MAX_CHARS = 90;
const lineId = (index: number) => `L${String(index).padStart(3, '0')}`;
const blockId = (index: number) => `B${String(index).padStart(3, '0')}`;

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let gap = false;
  for (const raw of text.split('\n')) {
    const stripped = raw.replace(/[\t ]+/g, ' ').trim();
    if (stripped.length === 0) {
      gap = lines.length > 0;
      continue;
    }
    lines.push({ text: stripped, gap });
    gap = false;
  }
  return lines;
}

const tag = (items: readonly { text: string; gap: boolean }[], id: (index: number) => string) =>
  items.map((item, index) => `${item.gap ? '\n' : ''}${id(index)}| ${item.text}`).join('\n');

/** Lines that may continue the one before: no blank line between and no explicit marker. */
const joinable = (lines: readonly Line[]) => lines.flatMap((line, index) => (index > 0 && !line.gap && markerType(line.text) === undefined ? [index] : []));

function stitchQuestions(lines: readonly Line[]): Record<string, Question> {
  return Object.fromEntries(
    joinable(lines).map((index) => [
      lineId(index),
      noul(`Does line ${lineId(index)} pick up mid-sentence, continuing a sentence left unfinished at the end of line ${lineId(index - 1)}?`, {
        true: 'The line starts in the middle of a sentence that began on the previous line; the line break tore the sentence apart',
        false: 'The line begins a new sentence, item, heading, or thought of its own',
      }),
    ]),
  );
}

interface Merged {
  text: string;
  lines: number[];
  gap: boolean;
}

function merge(lines: readonly Line[], joins: Readonly<Record<number, number>>, spec: StructureSpec): Merged[] {
  const blocks: Merged[] = [];
  lines.forEach((line, index) => {
    const bar = index > 0 && TERMINAL.test(lines[index - 1]!.text) ? spec.joinAfterTerminal : spec.joinAfterDangling;
    const last = blocks.at(-1);
    if (last !== undefined && (joins[index] ?? 0) >= bar) {
      last.text += ` ${line.text}`;
      last.lines.push(index);
    } else {
      blocks.push({ text: line.text, lines: [index], gap: line.gap });
    }
  });
  return blocks;
}

function classifyQuestions(blocks: readonly Merged[]): Record<string, Question> {
  const questions: Record<string, Question> = {};
  blocks.forEach((block, index) => {
    const id = blockId(index);
    if (markerType(block.text) === undefined) questions[`type_${id}`] = choice(`What kind of content is block ${id}?`, BLOCK_TYPES);
    if (block.text.length <= HEADING_MAX_CHARS) {
      questions[`hlevel_${id}`] = choice(`As a heading, what level would block ${id} occupy in this document's structure?`, HEADING_LEVELS);
    }
    questions[`step_${id}`] = noul(`Is block ${id} an instruction in a sequence where the order of the items matters?`);
    questions[`callout_${id}`] = choice(`What kind of aside is block ${id}?`, CALLOUT_KINDS);
  });
  return questions;
}

type Answers = Record<string, { choice?: string; confidence?: number; noul?: number }>;

function toBlock(block: Merged, index: number, answers: Answers): Block {
  const id = blockId(index);
  const marked = markerType(block.text);
  const type = answers[`type_${id}`];
  return {
    ...block,
    type: marked ?? (type!.choice as BlockType),
    confidence: marked === undefined ? type!.confidence! : 1,
    headingLevel: (answers[`hlevel_${id}`]?.choice ?? 'section') as keyof typeof HEADING_LEVELS,
    step: answers[`step_${id}`]!.noul!,
    callout: answers[`callout_${id}`]!.choice as keyof typeof CALLOUT_KINDS,
  };
}

export function defineStructureRecovery(spec: StructureSpec): StructureRecovery {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  if (!(spec.joinAfterDangling > 0 && spec.joinAfterDangling <= spec.joinAfterTerminal && spec.joinAfterTerminal <= 1)) {
    throw new RangeError(`structure ${spec.name}: needs 0 < joinAfterDangling <= joinAfterTerminal <= 1`);
  }

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
      const stitchAsked = stitchQuestions(lines);
      const joins: Record<number, number> = {};
      if (Object.keys(stitchAsked).length > 0) {
        const stitched = await askAs(port, spec, 'structure.stitch', tag(lines, lineId), stitchAsked, options);
        for (const [id, answer] of Object.entries(stitched.answers)) joins[Number(id.slice(1))] = (answer as { noul: number }).noul;
        recordReadings(port, stitched, { joins });
      }
      const merged = merge(lines, joins, spec);
      const classified = await askAs(port, spec, 'structure.classify', tag(merged, blockId), classifyQuestions(merged), options);
      const blocks = merged.map((block, index) => toBlock(block, index, classified.answers as Answers));
      recordReadings(port, classified, { types: blocks.map((block) => block.type) });
      return blocks;
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const blocks = await recovery.recover(port, fixture.text, { site: 'calibration', ...options });
        const got = blocks.map((block) => block.type).join(',');
        checks.push({
          fixture: fixture.name,
          aspect: 'types',
          expected: fixture.expect.join(','),
          got,
          correct: got === fixture.expect.join(','),
          signal: Math.min(...blocks.map((block) => block.confidence)),
          outcome: 'act',
        });
      }
      return checks;
    },
  };
  return recovery;
}

const HEADING_MARK = { title: '#', section: '##', subsection: '###' } as const;
const CALLOUT_MARK = { note: 'NOTE', tip: 'TIP', warning: 'WARNING' } as const;
const stripMarker = (text: string) => text.replace(/^(#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s?)/, '');

function renderGroup(type: BlockType, items: readonly Block[]): string {
  if (type === 'list_item') {
    const ordered = items.reduce((sum, block) => sum + block.step, 0) / items.length >= 0.5;
    return items.map((block, n) => `${ordered ? `${n + 1}.` : '-'} ${stripMarker(block.text)}`).join('\n');
  }
  if (type === 'code') return ['```', ...items.map((block) => block.text), '```'].join('\n');
  const [block] = items as [Block];
  if (type === 'heading') return `${HEADING_MARK[block.headingLevel]} ${stripMarker(block.text)}`;
  if (type === 'quote') return `> ${stripMarker(block.text)}`;
  if (type === 'callout') return `> [!${CALLOUT_MARK[block.callout]}]\n> ${block.text}`;
  return block.text;
}

/** Renders recovered blocks as Markdown; consecutive list items form one list, numbered when they read as steps. */
export function renderMarkdown(blocks: readonly Block[]): string {
  const groups: [BlockType, Block[]][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last !== undefined && last[0] === block.type && (block.type === 'list_item' || block.type === 'code')) last[1].push(block);
    else groups.push([block.type, [block]]);
  }
  return `${groups.map(([type, items]) => renderGroup(type, items)).join('\n\n')}\n`;
}
