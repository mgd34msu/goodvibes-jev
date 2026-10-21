import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { compactJsonReference } from '../../sdk/src/platform/contract/json-reference.js';
import type { SourceReadEvidence } from '../../sdk/src/platform/contract/evidence.js';
import { compareJsonReadReferences } from '../../sdk/src/platform/contract/read-reference-comparison.js';

function fixture(text: string) {
  const read: SourceReadEvidence = { path: 'input.json', returnedRanges: [`1-${text.split('\n').length}`], returnedLines: text.split('\n').length,
    contentKind: 'declared-reference', returnedContent: text.split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n') };
  const file = { path: read.path, operation: 'read-current-file', source: 'native-host-filesystem', success: true, binary: false,
    bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') };
  return { read, file };
}

test('JSON reference compaction preserves strings, duplicate keys and exact numeric literals', () => {
  const f = fixture('{\n  "literal": "a b\\t\\n",\n  "same": 1,\n  "same": 9007199254740993\n}\n');
  const original = JSON.stringify(f.read);
  const projected = compactJsonReference(f.read, [f.file]);
  expect(projected.returnedContent).toBe('{"literal":"a b\\t\\n","same":1,"same":9007199254740993}');
  expect(JSON.parse(projected.returnedContent!)).toEqual(JSON.parse('{"literal":"a b\\t\\n","same":9007199254740993}'));
  expect(projected).toMatchObject({ referenceProjection: { currentFileSha256: f.file.sha256, currentFileBytes: f.file.bytes } });
  expect(JSON.stringify(f.read)).toBe(original);
});

test('escaped quotes and backslashes keep their original JSON string values', () => {
  const data = { text: 'a b "quoted" \\ path', following: 'still present' };
  const f = fixture(JSON.stringify(data, null, 2));
  expect(JSON.parse(compactJsonReference(f.read, [f.file]).returnedContent!)).toEqual(data);
});

test('a compact view never substitutes stale, partial or invalid reference contents', () => {
  const f = fixture('{\n "data": [1, 2, 3]\n}\n');
  expect(compactJsonReference(f.read, [{ ...f.file, sha256: 'other bytes' }])).toBe(f.read);
  const partial = { ...f.read, returnedContent: f.read.returnedContent!.split('\n').slice(1).join('\n') };
  expect(compactJsonReference(partial, [f.file])).toBe(partial);
  const invalid = fixture('not JSON');
  expect(compactJsonReference(invalid.read, [invalid.file])).toBe(invalid.read);
  const source = { ...f.read, path: 'source.ts' };
  expect(compactJsonReference(source, [{ ...f.file, path: source.path }])).toBe(source);
});

test('large reference data keeps every assignment while removing redundant display whitespace', () => {
  const data = { partitions: Array.from({ length: 12 }, (_, index) => ({ id: `review-${index}`, files:
    Array.from({ length: 80 }, (_, file) => ({ path: `src/file-${index}-${file}.ts`, ranges: [[1, 500], [510, 900]] })) })) };
  const f = fixture(JSON.stringify(data, null, 2) + '\n');
  const projected = compactJsonReference(f.read, [f.file]);
  expect(JSON.parse(projected.returnedContent!)).toEqual(data);
  expect(Buffer.byteLength(projected.returnedContent!)).toBeLessThan(Buffer.byteLength(f.read.returnedContent!) / 2);
  expect(projected.returnedRanges).toEqual(f.read.returnedRanges);
});

test('native JSON reference arithmetic unions attributed observations and exposes exact residuals', () => {
  const f = fixture(JSON.stringify({ partitions: [{ files: [
    { path: 'source.ts', ranges: [[1, 5]] }, { path: 'source.ts', ranges: [[3, 8]] }, { path: 'other.ts', ranges: [[20, 20]] },
  ] }] }, null, 2));
  const before = JSON.stringify(f);
  const result = compareJsonReadReferences([f.read], [f.file], [
    { source: 'qualified owner', reads: [{ path: 'source.ts', returnedRanges: ['1-2', '101-900'] }] },
    { source: 'passed worker', reads: [{ path: 'source.ts', returnedRanges: ['2-4'] }] },
    { source: 'current worker', reads: [{ path: 'source.ts', returnedRanges: ['6-8'] }, { path: 'unrelated.ts', returnedRanges: ['1-999'] }] },
  ]);
  expect(result).toMatchObject([{ source: 'native-host-interval-comparison', referencePath: 'input.json', referenceSha256: f.file.sha256,
    observationSources: [{ source: 'qualified owner' }, { source: 'passed worker' }, { source: 'current worker' }],
    groups: [{ reference: '$["partitions"][0]["files"]', arrayItems: 3, literalRecords: 3, paths: 2,
      referencedLines: 9, coveredReferencedLines: 7, missingReferencedLines: 2,
      missing: [{ path: 'source.ts', ranges: [[5, 5]] }, { path: 'other.ts', ranges: [[20, 20]] }] }] }]);
  expect(JSON.stringify(f)).toBe(before);
});

test('scope arithmetic cannot credit stale, partial or duplicate-key reference data', () => {
  const f = fixture('{"files":[{"path":"source.ts","ranges":[[1,5]]}]}');
  expect(compareJsonReadReferences([f.read], [{ ...f.file, sha256: 'changed' }], [])).toEqual([]);
  expect(compareJsonReadReferences([{ ...f.read, returnedContent: f.read.returnedContent!.slice(0, -2) }], [f.file], [])).toEqual([]);
  const duplicate = fixture('{"files":[{"path":"source.ts","ranges":[[1,5]],"ranges":[]}]}');
  expect(compareJsonReadReferences([duplicate.read], [duplicate.file], [])).toEqual([]);
  const escapedDuplicate = fixture('{"files":[{"path":"source.ts","p\\u0061th":"other.ts","ranges":[[1,5]]}]}');
  expect(compareJsonReadReferences([escapedDuplicate.read], [escapedDuplicate.file], [])).toEqual([]);
});

test('only literal safe integer ranges count, with unrecognized array items explicitly visible', () => {
  const f = fixture(JSON.stringify({ files: [
    { path: 'source.ts', ranges: [[1, 2]] }, { path: 'unsafe.ts', ranges: [[1, 9007199254740992]] },
    { path: 'negative.ts', ranges: [[-2, 4]] }, { path: 'string.ts', ranges: [['1', '9']] },
  ], literal: '{"not": "a duplicate"}', distinct: '{"not": "a duplicate"}' }));
  expect(compareJsonReadReferences([f.read], [f.file], [])).toMatchObject([{ groups: [{ arrayItems: 4, literalRecords: 1,
    paths: 1, referencedLines: 2, missingReferencedLines: 2, missing: [{ path: 'source.ts', ranges: [[1, 2]] }] }] }]);
});
