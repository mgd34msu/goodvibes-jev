/** The kinds of block structure recovery tells apart. */
export type BlockType = 'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'callout';

export const BLOCK_TYPES: Readonly<Record<BlockType, string>> = {
  heading: 'A short label or title that names the document or the section that follows it, not a full sentence of content',
  paragraph: 'Running prose: one or more complete sentences of explanatory or narrative text',
  list_item: 'One entry in a list of parallel items; reads as one of several sibling entries',
  quote: 'Words attributed to a person or source: quoted speech, a citation, an excerpt someone else wrote',
  code: 'Computer code, a shell command, terminal output, or a config snippet meant to be read verbatim',
  callout: 'A warning, tip, or important note that interrupts the flow to flag something the reader must not miss',
};
export const HEADING_LEVELS = { title: 'The title of the whole document', section: 'A major section heading', subsection: 'A minor heading under a section' } as const;
export const CALLOUT_KINDS = { note: 'Neutral extra information', tip: 'A helpful suggestion or shortcut', warning: 'A caution about something that can go wrong' } as const;
export type HeadingLevel = keyof typeof HEADING_LEVELS;
export type CalloutKind = keyof typeof CALLOUT_KINDS;

export interface Line {
  readonly text: string;
  /** A blank line came before it. */
  readonly gap: boolean;
}

/** Lines merged into one block, before it is classified. */
export interface Merged {
  readonly text: string;
  readonly lines: readonly number[];
  readonly gap: boolean;
}

export interface Block extends Merged {
  readonly type: BlockType;
  /** Confidence behind the type; 1 when an explicit marker settled it in code. */
  readonly confidence: number;
  readonly headingLevel: HeadingLevel;
  /** Probability that a list item is one step of an ordered procedure. */
  readonly step: number;
  readonly callout: CalloutKind;
}

const MARKERS: readonly (readonly [RegExp, BlockType])[] = [
  [/^#{1,6}\s/, 'heading'],
  [/^([-*•]|\d+[.)])\s/, 'list_item'],
  [/^>\s?/, 'quote'],
];
const ANY_MARKER = /^(#{1,6}\s|[-*•]\s|\d+[.)]\s|>\s?)/;
/** Sentence-ending punctuation, optionally followed by closing quotes or brackets. */
const TERMINAL = /[.!?:;…]["')\]]*$/;

/** The block type an explicit marker states, read in code and never sent to the model. */
export const markerType = (text: string): BlockType | undefined => MARKERS.find(([pattern]) => pattern.test(text))?.[1];
export const stripMarker = (text: string): string => text.replace(ANY_MARKER, '');
export const endsSentence = (text: string): boolean => TERMINAL.test(text);

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let gap = false;
  for (const raw of text.split('\n')) {
    const stripped = raw.replace(/[\t ]+/g, ' ').trim();
    gap ||= stripped.length === 0 && lines.length > 0;
    if (stripped.length === 0) continue;
    lines.push({ text: stripped, gap });
    gap = false;
  }
  return lines;
}

/** Lines that may continue the one before: no blank line between and no explicit marker. */
export const joinableLines = (lines: readonly Line[]): number[] =>
  lines.flatMap((line, index) => (index > 0 && !line.gap && markerType(line.text) === undefined ? [index] : []));

/** The join probability a line needs to merge into the previous block, by how that line ended. */
export interface JoinBars {
  readonly afterDangling: number;
  readonly afterTerminal: number;
}

/** Merges each line into the previous block when its join probability clears the bar set by the previous line's ending. */
export function mergeLines(lines: readonly Line[], joins: Readonly<Record<number, number>>, bars: JoinBars): Merged[] {
  const blocks: { text: string; lines: number[]; gap: boolean }[] = [];
  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    const bar = previous !== undefined && endsSentence(previous.text) ? bars.afterTerminal : bars.afterDangling;
    const last = blocks.at(-1);
    const continues = last !== undefined && (joins[index] ?? 0) >= bar;
    if (continues) {
      last.text += ` ${line.text}`;
      last.lines.push(index);
    } else {
      blocks.push({ text: line.text, lines: [index], gap: line.gap });
    }
  });
  return blocks;
}
