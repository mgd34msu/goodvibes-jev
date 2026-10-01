/**
 * unified-diff.test.ts, the parser + steer-context builder over the git unified
 * diff that checkpoints.diff returns. Covers the shapes the daemon actually emits:
 * a modified file with one hunk, an added file (/dev/null → path), a deleted file,
 * a multi-file diff, a multi-hunk file, a binary block, hunk line-range math, the
 * excerpt cap, and the structured steer block.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseUnifiedDiff,
  hunkOldRange,
  hunkNewRange,
  formatRange,
  hunkExcerpt,
  hunkToPatch,
  buildHunkCommentSteer,
} from './unified-diff';

const MODIFIED = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -40,6 +40,7 @@ export function foo() {
 const a = 1;
 const b = 2;
-  return a + b;
+  const c = 3;
+  return a + b + c;
 }
 // tail
`;

describe('parseUnifiedDiff: a modified file', () => {
  const files = parseUnifiedDiff(MODIFIED);

  test('yields one file with the display path from the b/ side', () => {
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].status).toBe('modified');
    expect(files[0].binary).toBe(false);
  });

  test('parses the single hunk with correct counts and a stable id', () => {
    const [file] = files;
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0];
    expect(hunk.id).toBe('0:0');
    expect(hunk.oldStart).toBe(40);
    expect(hunk.oldCount).toBe(6);
    expect(hunk.newStart).toBe(40);
    expect(hunk.newCount).toBe(7);
    expect(hunk.addCount).toBe(2);
    expect(hunk.delCount).toBe(1);
  });

  test('assigns old/new line numbers per line side', () => {
    const hunk = files[0].hunks[0];
    const add = hunk.lines.find((l) => l.type === 'add' && l.text.includes('const c = 3'));
    expect(add?.newLine).toBe(42);
    expect(add?.oldLine).toBeNull();
    const del = hunk.lines.find((l) => l.type === 'del');
    expect(del?.oldLine).toBe(42);
    expect(del?.newLine).toBeNull();
  });
});

describe('parseUnifiedDiff: added and deleted files', () => {
  test('an added file (/dev/null old side) is status added, path from b/', () => {
    const diff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file.status).toBe('added');
    expect(file.path).toBe('new.txt');
    expect(file.hunks[0].addCount).toBe(2);
    expect(file.hunks[0].oldCount).toBe(0);
  });

  test('a deleted file uses the a/ path for display', () => {
    const diff = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3333333..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file.status).toBe('deleted');
    expect(file.path).toBe('gone.txt');
    expect(file.hunks[0].delCount).toBe(2);
  });
});

describe('parseUnifiedDiff: multiple files and hunks', () => {
  test('splits two files and keeps per-file hunk ids', () => {
    const diff = MODIFIED + `diff --git a/src/bar.ts b/src/bar.ts
index aaa..bbb 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
 x
+y
 z
@@ -10,2 +11,2 @@
-old
+new
 keep
`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[1].path).toBe('src/bar.ts');
    expect(files[1].hunks).toHaveLength(2);
    expect(files[1].hunks[0].id).toBe('1:0');
    expect(files[1].hunks[1].id).toBe('1:1');
    expect(files[1].hunks[1].oldStart).toBe(10);
  });

  test('a single-line hunk header (no count) defaults the count to 1', () => {
    const diff = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -5 +5 @@
-a
+b
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file.hunks[0].oldCount).toBe(1);
    expect(file.hunks[0].newCount).toBe(1);
    expect(file.hunks[0].oldStart).toBe(5);
  });
});

describe('parseUnifiedDiff: edge cases', () => {
  test('an empty or whitespace diff yields no files', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n  ')).toEqual([]);
  });

  test('a binary block is surfaced as binary with no hunks', () => {
    const diff = `diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file.binary).toBe(true);
    expect(file.hunks).toHaveLength(0);
  });
});

describe('range + excerpt helpers', () => {
  const hunk = parseUnifiedDiff(MODIFIED)[0].hunks[0];

  test('hunkOldRange/hunkNewRange compute inclusive spans', () => {
    expect(hunkOldRange(hunk)).toEqual({ from: 40, to: 45 });
    expect(hunkNewRange(hunk)).toEqual({ from: 40, to: 46 });
  });

  test('formatRange collapses a single-line span', () => {
    expect(formatRange({ from: 42, to: 42 })).toBe('42');
    expect(formatRange({ from: 40, to: 46 })).toBe('40–46');
  });

  test('hunkExcerpt reconstructs markers and caps long hunks', () => {
    const excerpt = hunkExcerpt(hunk);
    expect(excerpt).toContain('@@ -40,6 +40,7 @@');
    expect(excerpt).toContain('+  const c = 3;');
    expect(excerpt).toContain('-  return a + b;');

    const capped = hunkExcerpt(hunk, 2);
    expect(capped.split('\n').length).toBeLessThan(excerpt.split('\n').length);
    expect(capped).not.toContain('-  return a + b;');
  });

  test('hunkToPatch reconstructs the complete, uncapped, marker-exact hunk (no truncation marker)', () => {
    const patch = hunkToPatch(hunk);
    const lines = patch.split('\n');
    // header first, then every body line verbatim with its +/-/space marker
    expect(lines[0]).toBe('@@ -40,6 +40,7 @@ export function foo() {');
    expect(patch).toContain('+  const c = 3;');
    expect(patch).toContain('-  return a + b;');
    // never capped: the daemon must reverse-apply the whole hunk exactly
    expect(lines.slice(1).filter((l) => l.length > 0)).toHaveLength(hunk.lines.length);
    // every non-header line carries a leading +/-/space marker
    for (const line of lines.slice(1).filter((l) => l.length > 0)) {
      expect(['+', '-', ' ', '\\']).toContain(line[0]);
    }
  });
});

describe('buildHunkCommentSteer', () => {
  test('embeds file, both line ranges, the captured-at label, a fenced excerpt, and the comment', () => {
    const hunk = parseUnifiedDiff(MODIFIED)[0].hunks[0];
    const block = buildHunkCommentSteer({
      filePath: 'src/foo.ts',
      hunk,
      capturedLabel: 'checkpoint "turn abc" · 3 minutes ago',
      comment: '  use a named constant here  ',
    });
    expect(block).toContain('src/foo.ts');
    expect(block).toContain(formatRange(hunkNewRange(hunk)));
    expect(block).toContain(formatRange(hunkOldRange(hunk)));
    expect(block).toContain('checkpoint "turn abc" · 3 minutes ago');
    expect(block).toContain('+  return a + b + c;');
    // comment is trimmed and placed last
    expect(block.trimEnd().endsWith('use a named constant here')).toBe(true);
  });
});
