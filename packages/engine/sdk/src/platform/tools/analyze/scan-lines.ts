import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
/**
 * How the security and permissions scans choose the lines their per-line
 * readings look at: each file's non-blank lines are cut into blocks, and an
 * existence check (`engine.tools.secret-line` or `engine.tools.dangerous-line`)
 * finds the line in a block that holds what the scan looks for. A found line
 * leaves the block and the check runs again on the rest, until it reads no,
 * so every such line in a block is found. A blank line holds no text, so it
 * is never offered.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Existence, Item } from '@goodvibes-jev/judgment';
import { MAX_JUDGED_SCAN_LINE_CHARS } from '../batteries/secret-finding.js';

/** Most lines of one block an existence check reads (a Choice over this many ids fits well inside the request limits). */
export const SCAN_BLOCK_LINES = 60;

const clip = (line: string): string =>
  line.length <= MAX_JUDGED_SCAN_LINE_CHARS ? line : `${line.slice(0, MAX_JUDGED_SCAN_LINE_CHARS)}...`;
const itemId = (index: number): string => `L${index + 1}`;
const lineIndex = (id: string): number => Number(id.slice(1)) - 1;

/** A file's non-blank lines in blocks of at most SCAN_BLOCK_LINES, as items whose id is `L` and the 1-based line number. */
export function scanBlocks(lines: readonly string[]): Item[][] {
  const items = lines.flatMap((line, index) => (line.trim() === '' ? [] : [{ id: itemId(index), text: clip(line) }]));
  const blocks: Item[][] = [];
  for (let start = 0; start < items.length; start += SCAN_BLOCK_LINES)
    blocks.push(items.slice(start, start + SCAN_BLOCK_LINES));
  // An existence check needs two lines, so a last block of one line joins the block before it.
  const last = blocks.at(-1);
  if (blocks.length > 1 && last?.length === 1) {
    blocks.pop();
    blocks.at(-1)!.push(...last);
  }
  return blocks;
}

/**
 * The 0-based indexes of the lines in `block` the per-line reading must read:
 * each line the existence check finds, and a single line left that no check
 * ruled out (a one-line file, or the last line of a block whose other lines
 * were all found).
 */
export async function findScanLines(
  existence: Existence,
  site: string,
  query: string,
  block: readonly Item[],
): Promise<number[]> {
  let remaining = [...block];
  const found: string[] = [];
  while (remaining.length >= 2) {
    await assertCapturedToolAccessCurrent();
    const result = await existence.find(judgmentPort(site), query, remaining, { site });
    if (result.exists.verdict === 'no') {
      result.recordAction('no line to read');
      return found.map(lineIndex);
    }
    const line = result.ranked[0]!.id;
    result.recordAction(`read ${line}`);
    found.push(line);
    remaining = remaining.filter((item) => item.id !== line);
  }
  return [...found, ...remaining.map((item) => item.id)].map(lineIndex);
}
