import { expect, test } from 'bun:test';
import { compareReadReferences } from '../../sdk/src/platform/contract/read-reference-comparison.js';

test('extra dependency context does not change the exact referenced intersection', () => {
  const rows = compareReadReferences([{ field: 'criterion o1', text: 'Read packages/App.tsx:1-119,375-379.' }], [
    { path: 'packages/App.tsx', returnedRanges: ['1-119', '367-387'], returnedLines: 140 },
  ]);
  expect(rows).toMatchObject([{ path: 'packages/App.tsx', referencedRanges: [[1, 119], [375, 379]],
    referencedLines: 124, coveredReferencedLines: 124, missingReferencedRanges: [], missingReferencedLines: 0 }]);
});

test('missing endpoints and a completely unread reference are named precisely', () => {
  const rows = compareReadReferences([{ field: 'brief', text: 'src/a.ts:1-7; src/absent.ts:20-22.' }], [
    { path: 'src/a.ts', returnedRanges: ['2-3', '5-6'], returnedLines: 4 },
  ]);
  expect(rows[0]).toMatchObject({ missingReferencedRanges: [[1, 1], [4, 4], [7, 7]], missingReferencedLines: 3, coveredReferencedLines: 4 });
  expect(rows[1]).toMatchObject({ actualHostReturnedRanges: [], missingReferencedRanges: [[20, 22]], missingReferencedLines: 3 });
});

test('overlapping observations and repeated mentions count each line once', () => {
  const rows = compareReadReferences([{ field: 'brief', text: 'src/a.ts#L2-L5' }, { field: 'criterion', text: 'src/a.ts:2–5' }], [
    { path: 'src/a.ts', returnedRanges: ['1-3', '2-4'], returnedLines: 4 },
    { path: 'src/a.ts', returnedRanges: ['4-6'], returnedLines: 3 },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ mentions: [{ field: 'brief' }, { field: 'criterion' }], referencedLines: 4, coveredReferencedLines: 4, missingReferencedLines: 0 });
});

test('unsafe ranges and an unrelated path never establish returned scope', () => {
  const rows = compareReadReferences([{ field: 'brief', text: 'a.ts:0-2; a.ts:99999999999999999999999; a.ts:4-2; a.ts:1-3' }], [
    { path: 'other/a.ts', returnedRanges: ['1-3'], returnedLines: 3 },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ referencedLines: 3, coveredReferencedLines: 0, missingReferencedLines: 3 });
});
