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
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { retainStrictJudgmentJson, prepareJudgmentResult } from '../../gate/judgment-result.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import type { Existence, Item } from '@goodvibes-jev/judgment';
import { completeJudgmentView } from '../batteries/complete-view.js';

/** Most lines of one block an existence check reads (a Choice over this many ids fits well inside the request limits). */
export const SCAN_BLOCK_LINES = 60;

const itemId = (index: number): string => `L${index + 1}`;
const lineIndex = (id: string): number => Number(id.slice(1)) - 1;

/** A file's non-blank lines in blocks of at most SCAN_BLOCK_LINES, as items whose id is `L` and the 1-based line number. */
export function scanBlocks(lines: readonly string[]): Item[][] {
  completeJudgmentView({ lines });
  const items = lines.flatMap((line, index) => (line.trim() === '' ? [] : [{ id: itemId(index), text: line }]));
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
  const original = retainStrictJudgmentJson({ query, block });
  completeJudgmentView(original.snapshot);
  assertJudgmentInput(original.snapshot);
  const owner = block.length >= 2 ? captureJudgmentPort(site, { assertCurrent: original.assertCurrent, prepareResultCapture: prepareJudgmentResult }) : undefined;
  let remaining = [...original.snapshot.block];
  const found: string[] = [];
  while (remaining.length >= 2) {
    await assertCapturedToolAccessCurrent();
    const result = await existence.find(owner!.port, original.snapshot.query, remaining, { site, signal: owner!.signal, beforeAttempt: owner!.assertCurrent });
    await assertCapturedToolAccessCurrent(); owner!.assertCurrent();
    if (result.exists.outcome === 'act' && result.exists.verdict === 'no') {
      result.recordAction('no line to read'); owner!.assertCurrent();
      return found.map(lineIndex);
    }
    const line = result.ranked[0]!.id;
    result.recordAction(`read ${line}`); owner!.assertCurrent();
    found.push(line);
    remaining = remaining.filter((item) => item.id !== line);
  }
  await assertCapturedToolAccessCurrent(); original.assertCurrent(); owner?.assertCurrent();
  return [...found, ...remaining.map((item) => item.id)].map(lineIndex);
}
