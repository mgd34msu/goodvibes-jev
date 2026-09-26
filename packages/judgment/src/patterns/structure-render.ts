import { stripMarker, type Block, type BlockType, type CalloutKind, type HeadingLevel } from './structure-blocks.ts';

const HEADING_MARK: Readonly<Record<HeadingLevel, string>> = { title: '#', section: '##', subsection: '###' };
const CALLOUT_MARK: Readonly<Record<CalloutKind, string>> = { note: 'NOTE', tip: 'TIP', warning: 'WARNING' };
/** A run of list items is numbered when their mean step probability reaches this. */
const ORDERED_LIST_AT = 0.5;

/** Characters Markdown reads as markup anywhere in a line ('>' included, which also covers a leading quote marker). */
const INLINE_MARKUP = /[\\`*_[\]<>|~]/g;
/** A heading or bullet marker, read only at a line's start. */
const LEADING_SYMBOL = /^[#+-]/;
/** A numbered-list marker's punctuation, read only after a line's leading number. */
const LEADING_NUMBER = /^(\d+)([.)])/;

/** Recovered text as Markdown that shows exactly that text: every character Markdown would read as markup is escaped. */
const literal = (text: string): string =>
  text.replace(INLINE_MARKUP, '\\$&').replace(LEADING_SYMBOL, '\\$&').replace(LEADING_NUMBER, '$1\\$2');

/** A code fence longer than any run of backticks inside the code, so the code cannot close it early. */
function fenceFor(lines: readonly string[]): string {
  const longestRun = Math.max(0, ...lines.flatMap((line) => line.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

const meanStep = (items: readonly Block[]): number => items.reduce((sum, block) => sum + block.step, 0) / items.length;

function renderList(items: readonly Block[]): string {
  const ordered = meanStep(items) >= ORDERED_LIST_AT;
  return items.map((block, n) => `${ordered ? `${n + 1}.` : '-'} ${literal(stripMarker(block.text))}`).join('\n');
}

const RENDER_ONE: Readonly<Record<Exclude<BlockType, 'list_item' | 'code'>, (block: Block) => string>> = {
  heading: (block) => `${HEADING_MARK[block.headingLevel]} ${literal(stripMarker(block.text))}`,
  quote: (block) => `> ${literal(stripMarker(block.text))}`,
  callout: (block) => `> [!${CALLOUT_MARK[block.callout]}]\n> ${literal(block.text)}`,
  paragraph: (block) => literal(block.text),
};

/** Block types whose consecutive blocks render together: list items as one list, code lines as one fence. */
const RENDER_GROUP: Readonly<Record<'list_item' | 'code', (items: readonly Block[]) => string>> = {
  list_item: renderList,
  code: (items) => {
    const lines = items.map((block) => block.text);
    const fence = fenceFor(lines);
    return [fence, ...lines, fence].join('\n');
  },
};

const isGrouped = (type: BlockType): type is keyof typeof RENDER_GROUP => type in RENDER_GROUP;

function renderGroup(type: BlockType, items: readonly Block[]): string {
  return isGrouped(type) ? RENDER_GROUP[type](items) : RENDER_ONE[type](items[0]!);
}

/** Renders recovered blocks as Markdown: the input's text, escaped so it shows as written, inside the recovered structure's markup. */
export function renderMarkdown(blocks: readonly Block[]): string {
  const groups: [BlockType, Block[]][] = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last?.[0] === block.type && isGrouped(block.type)) last[1].push(block);
    else groups.push([block.type, [block]]);
  }
  return `${groups.map(([type, items]) => renderGroup(type, items)).join('\n\n')}\n`;
}
