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

/** Block types whose consecutive blocks render together: list items as one list, code lines as one fence. */
const RENDER_GROUP: Readonly<Record<'list_item' | 'code', (items: readonly Block[]) => string>> = {
  list_item: renderList,
  code: (items) => [CODE_FENCE, ...items.map((block) => block.text), CODE_FENCE].join('\n'),
};

const isGrouped = (type: BlockType): type is keyof typeof RENDER_GROUP => type in RENDER_GROUP;

function renderGroup(type: BlockType, items: readonly Block[]): string {
  return isGrouped(type) ? RENDER_GROUP[type](items) : RENDER_ONE[type](items[0]!);
}

/** Renders recovered blocks as Markdown, using only characters from the input plus markup. */
export function renderMarkdown(blocks: readonly Block[]): string {
  const groups: [BlockType, Block[]][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last?.[0] === block.type && isGrouped(block.type)) last[1].push(block);
    else groups.push([block.type, [block]]);
  }
  return `${groups.map(([type, items]) => renderGroup(type, items)).join('\n\n')}\n`;
}
