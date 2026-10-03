/**
 * lane-graph/diff-rows.ts, an opened edit's diff as drawn rows.
 *
 * The TUI shares these rows with its Changes modal; the Agent has no Changes
 * modal, so the parse (files, hunks, numbered lines), the row build (code
 * wrapped under its own line-number gutter) and the row draw live here, used
 * only by the work tree's opened edit and write bodies (paint.ts).
 *
 * Changed rows keep their syntax colors; the change shows as a background
 * tint across the row and a separate tint on the line-number gutter (the
 * theme's diff tokens, pushed further from the panel fill when a theme's tint
 * sits too close to it; see diff-tint.ts). Long lines wrap under their own gutter.
 */

import { activeDiffTones, activeTokens } from '../theme.ts';
import { clipText, type SurfaceCanvas } from '../surface-kit.ts';
import type { KitPanel } from '../surface-kit-parts.ts';
import { highlightCodeLines } from '../code-block.ts';
import { diffRowTints } from '../diff-tint.ts';
import type { SemanticDiff } from '../semantic-diff.ts';
import { getDisplayWidth } from '../../utils/terminal-width.ts';

export type ChangeLineKind = 'add' | 'del' | 'ctx' | 'note';

export interface ChangeLine {
  readonly kind: ChangeLineKind;
  /** The line without its leading '+', '-' or ' '. */
  readonly text: string;
  readonly oldNo: number | null;
  readonly newNo: number | null;
}

export interface ChangeHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly ChangeLine[];
}

export interface ChangeFile {
  readonly path: string;
  readonly headerLines: readonly string[];
  readonly hunks: readonly ChangeHunk[];
  readonly added: number;
  readonly removed: number;
  /** A binary file or a mode-only change: header only, nothing to show line by line. */
  readonly headerOnly: boolean;
}

const HUNK_HEADER_RE = /^@@\s+-([0-9]+)(?:,[0-9]+)?\s+\+([0-9]+)(?:,[0-9]+)?\s+@@/;

function pathFromChunk(lines: readonly string[]): string {
  for (const line of lines) {
    const quoted = /^diff --git "a\/(.+)" "b\/(.+)"$/.exec(line);
    if (quoted) return quoted[2]!;
    const plain = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (plain) return plain[1]!;
  }
  for (const line of lines) {
    const plus = /^\+\+\+ (?:b\/)?"?([^"\n]+?)"?\s*$/.exec(line);
    if (plus && plus[1] !== '/dev/null') return plus[1]!;
  }
  for (const line of lines) {
    const minus = /^--- (?:a\/)?"?([^"\n]+?)"?\s*$/.exec(line);
    if (minus && minus[1] !== '/dev/null') return minus[1]!;
  }
  return 'unknown';
}

/** Split a unified diff (one or many files) into files and numbered hunks. */
export function parseChanges(raw: string): ChangeFile[] {
  const chunks = raw.split(/(?=^diff --git |^diff --cc |^diff --combined )/m).filter((chunk) => chunk.trim());
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const first = lines.findIndex((line) => HUNK_HEADER_RE.test(line));
    const headerLines = (first < 0 ? lines : lines.slice(0, first)).filter((line) => line.length > 0);
    const hunks: ChangeHunk[] = [];
    let current: { oldStart: number; newStart: number; lines: ChangeLine[]; oldNo: number; newNo: number } | null = null;
    let added = 0;
    let removed = 0;
    for (const raw of first < 0 ? [] : lines.slice(first)) {
      const m = HUNK_HEADER_RE.exec(raw);
      if (m) {
        if (current) hunks.push({ oldStart: current.oldStart, newStart: current.newStart, lines: current.lines });
        const oldStart = Number(m[1]);
        const newStart = Number(m[2]);
        current = { oldStart, newStart, lines: [], oldNo: oldStart, newNo: newStart };
        continue;
      }
      if (!current || raw === '') continue;
      if (raw.startsWith('+')) { current.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: current.newNo++ }); added++; }
      else if (raw.startsWith('-')) { current.lines.push({ kind: 'del', text: raw.slice(1), oldNo: current.oldNo++, newNo: null }); removed++; }
      else if (raw.startsWith('\\')) current.lines.push({ kind: 'note', text: raw, oldNo: null, newNo: null });
      else current.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: current.oldNo++, newNo: current.newNo++ });
    }
    if (current) hunks.push({ oldStart: current.oldStart, newStart: current.newStart, lines: current.lines });
    return { path: pathFromChunk(headerLines), headerLines, hunks, added, removed, headerOnly: hunks.length === 0 };
  });
}

/** The language fence tag for a path (its extension), for syntax colors. */
export function languageForPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base === 'Dockerfile') return 'dockerfile';
  if (base === 'Makefile') return 'make';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Width of the line-number gutter inside a diff panel. */
export const DIFF_GUTTER = 5;

type Token = { readonly text: string; readonly fg: string; readonly bold?: boolean; readonly italic?: boolean };

/** One drawn row of a diff: a file header, a hunk separator, or a (wrapped) code line. */
export type DiffRow =
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'sep'; readonly hunk: number; readonly text: string }
  | { readonly kind: 'line'; readonly hunk: number; readonly line: ChangeLine; readonly first: boolean; readonly text: string; readonly tokens: readonly Token[] | null };

/** Syntax tokens per hunk, remembered until the theme changes. */
const tokenMemo = new WeakMap<ChangeHunk, { theme: object; lines: Token[][] }>();

function hunkTokens(file: ChangeFile, hunk: ChangeHunk): Token[][] {
  const theme = activeTokens();
  const memo = tokenMemo.get(hunk);
  if (memo && memo.theme === theme) return memo.lines;
  const lines = highlightCodeLines(hunk.lines.map((line) => line.text), languageForPath(file.path));
  tokenMemo.set(hunk, { theme, lines });
  return lines;
}

/** Split syntax tokens into rows of at most `width` cells. */
function wrapTokens(tokens: readonly Token[], width: number): Token[][] {
  const rows: Token[][] = [[]];
  let used = 0;
  for (const token of tokens) {
    let piece = '';
    for (const ch of token.text.replace(/\t/g, '  ')) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (used + w > width) {
        if (piece) rows[rows.length - 1]!.push({ ...token, text: piece });
        rows.push([]);
        piece = '';
        used = 0;
      }
      piece += ch;
      used += w;
    }
    if (piece) rows[rows.length - 1]!.push({ ...token, text: piece });
  }
  return rows;
}

/** The rows a diff draws as, code wrapped to `codeWidth` under its own gutter. */
export function buildDiffRows(diffFiles: readonly ChangeFile[], codeWidth: number, fileHeaders: boolean): { rows: DiffRow[] } {
  const rows: DiffRow[] = [];
  let hunkNo = 0;
  const total = diffFiles.reduce((n, f) => n + f.hunks.length, 0);
  for (const file of diffFiles) {
    if (fileHeaders) rows.push({ kind: 'file', text: `${file.path}  +${file.added} −${file.removed}` });
    if (file.headerOnly) {
      rows.push({ kind: 'file', text: file.headerLines.some((l) => l.startsWith('Binary')) ? 'binary file, no line changes to show' : 'no line changes (mode or rename only)' });
      continue;
    }
    for (const hunk of file.hunks) {
      rows.push({ kind: 'sep', hunk: hunkNo, text: `⋯ line ${hunk.newStart}` + (total > 1 ? `  ·  hunk ${hunkNo + 1} of ${total}` : '') });
      const tokens = hunkTokens(file, hunk);
      hunk.lines.forEach((line, i) => {
        if (line.kind === 'note') {
          rows.push({ kind: 'line', hunk: hunkNo, line, first: true, text: line.text, tokens: null });
          return;
        }
        const wrapped = wrapTokens(tokens[i] ?? [{ text: line.text, fg: activeTokens().text }], codeWidth);
        wrapped.forEach((part, k) => rows.push({ kind: 'line', hunk: hunkNo, line, first: k === 0, text: '', tokens: part }));
      });
      hunkNo++;
    }
  }
  return { rows };
}

/**
 * Draw one diff row inside panel `p`: the change tint across the row, a
 * separate tint on the line-number gutter, the number, the sign and the
 * syntax-colored code. `lineNumbers: false` leaves the numbers out (a diff
 * whose line numbers are not known).
 */
export function drawDiffRow(canvas: SurfaceCanvas, p: KitPanel, y: number, row: DiffRow, options: { readonly lineNumbers?: boolean } = {}): void {
  const t = activeTokens();
  if (row.kind === 'file') {
    canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: t.text, bold: true, bg: p.bg });
    return;
  }
  const tones = activeDiffTones();
  if (row.kind === 'sep') {
    canvas.put(p.l, y, clipText(row.text, p.r - p.l + 1), { fg: tones.hunk, bg: p.bg });
    return;
  }
  const line = row.line;
  const gutterEnd = p.l + DIFF_GUTTER - 1;
  if (line.kind === 'add' || line.kind === 'del') {
    const tints = diffRowTints(p.bg);
    canvas.tint(p.x, y, p.w, line.kind === 'add' ? tints.addedRow : tints.removedRow);
    canvas.tint(p.x, y, gutterEnd - p.x + 2, line.kind === 'add' ? tints.addedGutter : tints.removedGutter);
  }
  if (line.kind === 'note') {
    canvas.put(p.l + DIFF_GUTTER + 3, y, clipText(row.text, p.r - p.l - DIFF_GUTTER - 2), { fg: t.textFaint });
    return;
  }
  if (row.first) {
    const n = line.kind === 'del' ? line.oldNo : line.newNo;
    if (n !== null && options.lineNumbers !== false) canvas.right(gutterEnd, y, String(n).slice(-DIFF_GUTTER), { fg: t.diffLineNumber });
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    canvas.put(gutterEnd + 2, y, sign, { fg: line.kind === 'add' ? tones.add : line.kind === 'del' ? tones.del : t.textFaint });
  }
  let x = gutterEnd + 4;
  for (const token of row.tokens ?? []) x = canvas.put(x, y, token.text, { fg: token.fg, bold: token.bold, italic: token.italic });
}

/** The ◈ summary's chips ("~ fn withRetry", "+ import x"), colored by kind. */
export function semanticChips(diff: SemanticDiff): Array<{ text: string; fg: string }> {
  const t = activeTokens();
  const chips: Array<{ text: string; fg: string }> = [];
  for (const s of diff.symbols) {
    const glyph = s.kind === 'added' ? '+' : s.kind === 'removed' ? '-' : '~';
    chips.push({ text: `${glyph} ${s.symbolKind === 'function' ? 'fn' : s.symbolKind} ${s.name}`, fg: s.kind === 'added' ? t.success : s.kind === 'removed' ? t.error : t.warning });
  }
  for (const i of diff.imports) {
    const glyph = i.kind === 'added' ? '+' : i.kind === 'removed' ? '-' : '~';
    chips.push({ text: `${glyph} import ${i.specifier}`, fg: i.kind === 'added' ? t.success : i.kind === 'removed' ? t.error : t.warning });
  }
  return chips;
}
