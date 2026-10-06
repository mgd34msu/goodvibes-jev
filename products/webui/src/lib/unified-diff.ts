/**
 * unified-diff.ts, a tolerant parser for the git unified-diff string the daemon
 * returns from `checkpoints.diff` (result.diff.unifiedDiff), plus the helpers that
 * turn one selected hunk into a structured, human-readable steer context block.
 *
 * WHY THIS EXISTS: the only file-diff surface the daemon exposes is workspace
 * checkpoints (checkpoints.list + checkpoints.diff, verified against the installed
 * operator contract: there is NO per-session file-diff verb; checkpoints carry
 * turnId/agentId but no sessionId). CheckpointsView already renders that unifiedDiff
 * as one opaque <pre>. To let a user select a single hunk and comment on it, we first
 * need to break the diff into files → hunks with real line ranges. This parser does
 * only that, no rendering, no network, so it is unit-testable in isolation.
 *
 * Tolerance: the parser prefers the `--- a/…` / `+++ b/…` header lines for paths and
 * falls back to the `diff --git a/… b/…` line; a block with neither still yields its
 * hunks under an 'unknown' path rather than being dropped. Binary/GIT-binary blocks
 * are surfaced as files with `binary: true` and no hunks (never silently hidden).
 */

export type DiffLineType = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  readonly type: DiffLineType;
  /** The line WITHOUT its leading +/-/space marker (meta lines keep their text verbatim). */
  readonly text: string;
  /** 1-based line number in the OLD file (context + del lines); null for add/meta. */
  readonly oldLine: number | null;
  /** 1-based line number in the NEW file (context + add lines); null for del/meta. */
  readonly newLine: number | null;
}

export interface DiffHunk {
  /** Stable within a file: `${fileIndex}:${hunkIndex}`, safe as a React key / selection id. */
  readonly id: string;
  /** The verbatim `@@ -a,b +c,d @@ section` header. */
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly DiffLine[];
  readonly addCount: number;
  readonly delCount: number;
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export interface DiffFile {
  /** The path shown to the user, the new path unless the file was deleted. */
  readonly path: string;
  readonly oldPath: string;
  readonly newPath: string;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  readonly hunks: readonly DiffHunk[];
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(raw: string): string {
  // git prefixes paths with a/ and b/. /dev/null is the added/deleted sentinel.
  if (raw === '/dev/null') return '';
  return raw.replace(/^[ab]\//, '');
}

function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } | null {
  // `diff --git a/foo b/foo`. Paths with spaces are ambiguous here, we treat the
  // `--- `/`+++ ` lines as authoritative when present and only fall back to this.
  const match = /^diff --git (.+) (.+)$/.exec(line);
  if (!match) return null;
  return { oldPath: stripPrefix(match[1]), newPath: stripPrefix(match[2]) };
}

interface MutableFile {
  oldPath: string;
  newPath: string;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
}

/**
 * Parse a git unified-diff string into files and hunks. Returns [] for an
 * empty/whitespace-only diff (the honest "no file differences" case the caller
 * renders as such).
 */
export function parseUnifiedDiff(unifiedDiff: string): DiffFile[] {
  if (!unifiedDiff.trim()) return [];
  const lines = unifiedDiff.split('\n');
  const files: MutableFile[] = [];
  let current: MutableFile | null = null;
  let hunkIndex = 0;

  // Hunk-in-progress state.
  let hunkLines: DiffLine[] = [];
  let hunkMeta: { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number } | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let addCount = 0;
  let delCount = 0;

  function flushHunk(): void {
    if (!current || !hunkMeta) return;
    current.hunks.push({
      id: `${files.length - 1}:${hunkIndex}`,
      header: hunkMeta.header,
      oldStart: hunkMeta.oldStart,
      oldCount: hunkMeta.oldCount,
      newStart: hunkMeta.newStart,
      newCount: hunkMeta.newCount,
      lines: hunkLines,
      addCount,
      delCount,
    });
    hunkIndex += 1;
    hunkLines = [];
    hunkMeta = null;
    addCount = 0;
    delCount = 0;
  }

  // Returns the newly-opened file so the caller assigns `current` where TS can see the
  // non-null assignment (TS does not track reassignments made inside a nested closure,
  // which would otherwise leave `current` typed as its `null` initializer at read sites).
  function startFile(oldPath: string, newPath: string): MutableFile {
    flushHunk();
    const file: MutableFile = { oldPath, newPath, status: 'modified', binary: false, hunks: [] };
    files.push(file);
    hunkIndex = 0;
    return file;
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = parseDiffGitPaths(line);
      current = startFile(paths?.oldPath ?? '', paths?.newPath ?? '');
      continue;
    }

    // A bare `--- `/`+++ ` pair with no preceding `diff --git` (e.g. a plain
    // `diff -u` fragment): open a file lazily on the `--- ` line.
    const hunkComplete = hunkMeta && oldCursor >= hunkMeta.oldStart + hunkMeta.oldCount && newCursor >= hunkMeta.newStart + hunkMeta.newCount;
    if (line.startsWith('--- ') && (!hunkMeta || hunkComplete)) {
      const oldPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
      if (!current || current.hunks.length > 0 || hunkMeta) {
        current = startFile(oldPath, current?.newPath ?? '');
      } else {
        current.oldPath = oldPath;
      }
      continue;
    }
    if (line.startsWith('+++ ') && !hunkMeta) {
      const newPath = stripPrefix(line.slice(4).replace(/\t.*$/, ''));
      if (current) current.newPath = newPath;
      continue;
    }

    if (line.startsWith('new file mode')) {
      if (current) current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (current) current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from') || line.startsWith('rename to') || line.startsWith('copy from') || line.startsWith('copy to')) {
      if (current) current.status = 'renamed';
      continue;
    }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      if (current) current.binary = true;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      flushHunk();
      current ??= startFile('', '');
      // The count groups are optional in the header (`@@ -a +c @@` omits them); an
      // absent group is undefined at runtime and defaults to a count of 1. Truthiness
      // (not `=== undefined`) keeps the check honest to the string-or-undefined runtime
      // shape without eslint flagging the comparison as impossible.
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] ? Number(hunkMatch[2]) : 1;
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] ? Number(hunkMatch[4]) : 1;
      hunkMeta = { header: line, oldStart, oldCount, newStart, newCount };
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (!hunkMeta) continue; // header noise (index …, mode …) between files

    // Inside a hunk body.
    if (line.startsWith('+')) {
      hunkLines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine: newCursor });
      newCursor += 1;
      addCount += 1;
    } else if (line.startsWith('-')) {
      hunkLines.push({ type: 'del', text: line.slice(1), oldLine: oldCursor, newLine: null });
      oldCursor += 1;
      delCount += 1;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file", metadata, belongs to neither side.
      hunkLines.push({ type: 'meta', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith(' ')) {
      hunkLines.push({ type: 'context', text: line.slice(1), oldLine: oldCursor, newLine: newCursor });
      oldCursor += 1;
      newCursor += 1;
    }
  }
  flushHunk();

  return files.map((f) => ({
    path: f.status === 'deleted' ? (f.oldPath || f.newPath || 'unknown') : (f.newPath || f.oldPath || 'unknown'),
    oldPath: f.oldPath,
    newPath: f.newPath,
    status: f.status,
    binary: f.binary,
    hunks: f.hunks,
  }));
}

/** The old-file line span a hunk touches, as an inclusive {from,to} (0/0 when the hunk adds only). */
export function hunkOldRange(hunk: Pick<DiffHunk, 'oldStart' | 'oldCount'>): { from: number; to: number } {
  if (hunk.oldCount <= 0) return { from: hunk.oldStart, to: hunk.oldStart };
  return { from: hunk.oldStart, to: hunk.oldStart + hunk.oldCount - 1 };
}

/** The new-file line span a hunk touches, as an inclusive {from,to} (0/0 when the hunk deletes only). */
export function hunkNewRange(hunk: Pick<DiffHunk, 'newStart' | 'newCount'>): { from: number; to: number } {
  if (hunk.newCount <= 0) return { from: hunk.newStart, to: hunk.newStart };
  return { from: hunk.newStart, to: hunk.newStart + hunk.newCount - 1 };
}

/** A short human range label like "42–48" (or "42" for a single line). */
export function formatRange(range: { from: number; to: number }): string {
  return range.from === range.to ? String(range.from) : `${range.from}–${range.to}`;
}

/** The hunk's body lines with their verbatim +/-/space markers (meta lines kept as-is). */
function hunkBodyLines(hunk: DiffHunk): string[] {
  return hunk.lines.map((line) => {
    if (line.type === 'add') return `+${line.text}`;
    if (line.type === 'del') return `-${line.text}`;
    if (line.type === 'meta') return line.text;
    return ` ${line.text}`;
  });
}

/**
 * Reconstruct the hunk's diff text (the `@@` header plus its +/-/space lines),
 * capped to `maxLines` body lines so a huge hunk does not bloat the steer message.
 * When capped, an honest "… N more lines" marker is appended.
 */
export function hunkExcerpt(hunk: DiffHunk, maxLines = 40): string {
  const body = hunkBodyLines(hunk);
  const shown = body.slice(0, maxLines);
  const remainder = body.length - shown.length;
  const tail = remainder > 0 ? [`… ${remainder} more line${remainder === 1 ? '' : 's'} in this hunk (truncated)`] : [];
  return [hunk.header, ...shown, ...tail].join('\n');
}

/**
 * The COMPLETE, exact unified-diff text of one hunk, its `@@` header followed by
 * every body line with its verbatim +/-/space/meta marker, UNCAPPED. This is the
 * string checkpoints.revertHunkPreview / checkpoints.revertHunk consume: the daemon
 * parses exactly one `@@ … @@` block and reverse-applies it against the live file, so
 * unlike hunkExcerpt this never truncates or appends a "… N more" marker, a capped or
 * annotated patch would fail to apply cleanly (an honest conflict, not the revert).
 */
export function hunkToPatch(hunk: DiffHunk): string {
  return [hunk.header, ...hunkBodyLines(hunk)].join('\n');
}

export interface HunkCommentContextInput {
  readonly filePath: string;
  readonly hunk: DiffHunk;
  /** How the diff was captured, for the trust-in-labels line (e.g. the checkpoint label + when). */
  readonly capturedLabel: string;
  readonly comment: string;
  /** Cap the embedded excerpt (defaults to 40 body lines). */
  readonly maxExcerptLines?: number;
}

/**
 * Build the structured, human-readable context block that PREFIXES the steer message,
 * so the model knows exactly which change the comment is about: the file, the old/new
 * line ranges, when the diff was captured, and the hunk excerpt itself, then the
 * user's comment last. Fenced so the excerpt's leading +/- characters read as a code
 * block rather than markdown list/quote syntax.
 */
export function buildHunkCommentSteer(input: HunkCommentContextInput): string {
  const oldRange = hunkOldRange(input.hunk);
  const newRange = hunkNewRange(input.hunk);
  const comment = input.comment.trim();
  const lines = [
    'Comment on a specific code change:',
    `- File: ${input.filePath}`,
    `- Lines: new ${formatRange(newRange)} · old ${formatRange(oldRange)}`,
    `- Source: ${input.capturedLabel}`,
    '',
    'Change in question:',
    '```diff',
    hunkExcerpt(input.hunk, input.maxExcerptLines),
    '```',
    '',
    `My comment: ${comment}`,
  ];
  return lines.join('\n');
}
