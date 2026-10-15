/**
 * footer-targets.ts, which footer rows open a view when clicked.
 *
 * The status line (the row carrying the context bar and cost) opens the
 * Usage modal on a click. The footer builder tags those Line arrays with a symbol-keyed
 * property (invisible to rendering, iteration and golden frames); the shell
 * turns the tags into screen rows each frame and the mouse route reads them.
 */

import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';

/** What a clickable footer row opens. */
export type FooterTarget = 'usage' | 'agents' | 'commands' | 'bottom';
interface Region { start: number; end: number; target: FooterTarget }
const regions = new WeakMap<Line, Region[]>();
const rowRegions = new WeakMap<ReadonlyMap<number, FooterTarget>, Map<number, readonly Region[]>>();
export function tagFooterRegion(line: Line, start: number, end: number, target: FooterTarget): void {
  const entries = regions.get(line) ?? []; entries.push({ start, end, target }); regions.set(line, entries);
}
export function resolveFooterTarget(rows: ReadonlyMap<number, FooterTarget>, row: number, col?: number): FooterTarget | undefined {
  return (col === undefined ? undefined : rowRegions.get(rows)?.get(row)?.findLast(hit => col >= hit.start && col < hit.end)?.target) ?? rows.get(row);
}

const FOOTER_TARGET = Symbol('footer-target');

type TaggedLine = Line & { [FOOTER_TARGET]?: FooterTarget };

/** Mark a footer row as opening `target` when clicked; returns the same line. */
export function tagFooterLine(line: Line, target: FooterTarget): Line {
  (line as TaggedLine)[FOOTER_TARGET] = target;
  return line;
}

/** The target a footer row opens, or undefined. */
function footerTargetOf(line: Line): FooterTarget | undefined {
  return (line as TaggedLine)[FOOTER_TARGET];
}

/** Screen row → target for a footer drawn with its first row at `startRow`. */
export function footerTargetRows(footer: readonly Line[], startRow: number): ReadonlyMap<number, FooterTarget> {
  const rows = new Map<number, FooterTarget>();
  const hits = new Map<number, readonly Region[]>();
  footer.forEach((line, index) => {
    const target = footerTargetOf(line);
    if (target) rows.set(startRow + index, target);
    const entries = regions.get(line);
    if (entries) hits.set(startRow + index, entries);
  });
  rowRegions.set(rows, hits);
  return rows;
}
