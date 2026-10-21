import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { compactJsonReference } from '../../sdk/src/platform/contract/json-reference.js';
import type { SourceReadEvidence } from '../../sdk/src/platform/contract/evidence.js';

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
