import { stripMarker, type Block, type BlockType, type CalloutKind, type HeadingLevel } from './structure-blocks.ts';

const HEADING_MARK: Readonly<Record<HeadingLevel, string>> = { title: '#', section: '##', subsection: '###' };
const CALLOUT_MARK: Readonly<Record<CalloutKind, string>> = { note: 'NOTE', tip: 'TIP', warning: 'WARNING' };
const CODE_FENCE = '```';
/** A run of list items is numbered when their mean step probability reaches this. */
const ORDERED_LIST_AT = 0.5;

const meanStep = (items: readonly Block[]): number => items.reduce((sum, block) => sum + block.step, 0) / items.length;

function renderList(items: readonly Block[]): string {
  const ordered = meanStep(items) >= ORDERED_LIST_AT;
  return items.map((block, n) => `${ordered ? `${n + 1}.` : '-'} ${stripMarker(block.text)}`).join('\n');
}

const RENDER_ONE: Readonly<Record<Exclude<BlockType, 'list_item' | 'code'>, (block: Block) => string>> = {
  heading: (block) => `${HEADING_MARK[block.headingLevel]} ${stripMarker(block.text)}`,
  quote: (block) => `> ${stripMarker(block.text)}`,
  callout: (block) => `> [!${CALLOUT_MARK[block.callout]}]\n> ${block.text}`,
  paragraph: (block) => block.text,
};

function renderGroup(type: BlockType, items: readonly Block[]): string {
  if (type === 'list_item') return renderList(items);
  if (type === 'code') return [CODE_FENCE, ...items.map((block) => block.text), CODE_FENCE].join('\n');
  return RENDER_ONE[type](items[0]!);
}

/** Consecutive list items form one list and consecutive code lines one fence; every other block stands alone. */
const groupsWith = (type: BlockType): boolean => type === 'list_item' || type === 'code';

/** Renders recovered blocks as Markdown, using only characters from the input plus markup. */
export function renderMarkdown(blocks: readonly Block[]): string {
  const groups: [BlockType, Block[]][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last?.[0] === block.type && groupsWith(block.type)) last[1].push(block);
    else groups.push([block.type, [block]]);
  }
  return `${groups.map(([type, items]) => renderGroup(type, items)).join('\n\n')}\n`;
}
