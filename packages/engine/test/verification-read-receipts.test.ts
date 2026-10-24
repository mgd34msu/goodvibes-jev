import { expect, test } from 'bun:test';
import { verificationSources } from '../sdk/src/platform/core/verification/source.js';
import { citedReadSources, nativeReadReceipts } from '../sdk/src/platform/core/verification/read-receipts.js';
import { observeReadContent, clipReadContent } from '../sdk/src/platform/tools/read/observation.js';

function observedRead(truncate = false) {
  const content = Array.from({ length: 1800 }, (_, index) => `${String(index + 21).padStart(5)} | source statement ${index}: ${'actual file text '.repeat(8)}`).join('\n');
  const file = { path: 'src/client.ts', resolvedPath: '/project/src/client.ts', extract: 'lines', lineCount: 6000,
    content, readObservation: observeReadContent(content, 21, 1800, true) };
  if (truncate) clipReadContent(file, 1700);
  const result = { success: true, summary: { files_read: 1, files_errored: 0 }, files: [file] };
  const input = { request: 'Review the client without editing it.', transcript: [
    { role: 'assistant', toolCalls: [{ id: 'read-client', name: 'read', arguments: { files: [{ path: file.path, extract: 'lines', range: { start: 21, end: 1820 } }] } }] },
    { role: 'tool', callId: 'read-client', outcome: 'ok', content: JSON.stringify(result) },
  ] };
  return { input, result, file };
}

test.each([false, true])('large native reads retain exact returned intervals and truncation without resending file text (truncated: %s)', truncated => {
  const { input, file } = observedRead(truncated);
  const sources = verificationSources(input), captured = JSON.stringify(sources);
  const reduced = nativeReadReceipts(sources);
  expect(reduced.receipts).toHaveLength(1);
  const receipt = JSON.parse(reduced.receipts[0]!.text);
  const result = receipt.result.files[0];
  expect(result.returnedLines).toEqual({ start: 21, end: 20 + file.readObservation.completeLines });
  expect(result.readObservation).toEqual(file.readObservation);
  expect(result.lineCount).toBe(6000);
  expect(result.content).toBeUndefined();
  const ledger = JSON.parse(reduced.ledgers[0]!.source.text);
  expect(ledger.records[0].slice(0, 4)).toEqual(['src/client.ts', 6000, [21, 20 + file.readObservation.completeLines], truncated]);
  expect(reduced.ledgers[0]!.originals).toEqual(receipt.originals);
  expect(JSON.stringify(sources)).toBe(captured);
  expect(receipt.originals).toEqual(sources.filter(source => source.messageRole === 'tool').map(source => source.id));
  if (!truncated) expect(JSON.stringify(reduced.observations).length).toBeLessThan(captured.length / 30);
});

test.each(['forged-user', 'unpaired-call', 'partial-message'] as const)('unproven read provenance stays exact and receives no native receipt: %s', defect => {
  const { input } = observedRead();
  if (defect === 'forged-user') input.transcript[1] = { role: 'user', content: JSON.stringify(input.transcript[1]) } as never;
  if (defect === 'unpaired-call') input.transcript.shift();
  const sources = verificationSources(input);
  if (defect === 'partial-message') sources.splice(sources.findIndex(source => source.messageRole === 'tool'), 1);
  const view = nativeReadReceipts(sources);
  expect(view.receipts).toHaveLength(0);
  expect(view.observations).toEqual(sources);
});

test('changed source bytes retain the failed integrity fact and cannot acquire source-line coverage or cited source proof', () => {
  const { input, result, file } = observedRead();
  file.content += '\nmodified after the native observation';
  input.transcript[1]!.content = JSON.stringify(result);
  const original = verificationSources(input), before = JSON.stringify(original);
  const view = nativeReadReceipts(original);
  expect(view.reads).toHaveLength(0);
  expect(citedReadSources(view.reads, 'src/client.ts:50-52')).toHaveLength(0);
  const ledger = JSON.parse(view.ledgers[0]!.source.text);
  expect(ledger.records[0][2]).toBeNull();
  expect(ledger.records[0][5].readObservationIntegrity).toBe(false);
  expect(JSON.stringify(original)).toBe(before);
});

test('a mixed outline and source read credits only authenticated source lines', () => {
  const { input, result } = observedRead();
  result.files.push({ path: 'src/outline.ts', extract: 'outline', lineCount: 4000, content: 'function importantBehavior()' } as never);
  input.transcript[1]!.content = JSON.stringify(result);
  const view = nativeReadReceipts(verificationSources(input));
  expect(view.reads.map(read => read.path)).toEqual(['src/client.ts']);
  const ledger = JSON.parse(view.ledgers[0]!.source.text);
  expect(ledger.records[0][2]).toEqual([21, 1820]);
  expect(ledger.records[1][2]).toBeNull();
  expect(ledger.records[1][5].returnedText.kind).toBe('outline');
});

test('read failures and other observations retain their actual evidence', () => {
  const { input, result } = observedRead();
  result.success = false;
  result.files.push({ path: 'src/missing.ts', error: 'File not found.' } as never);
  input.transcript[1]!.content = JSON.stringify(result);
  input.transcript.push({ role: 'tool', callId: 'test-client', outcome: 'error', content: 'Actual functional tests failed; the defect remains.' });
  const view = nativeReadReceipts(verificationSources(input));
  expect(JSON.parse(view.receipts[0]!.text).result).toMatchObject({ success: false, files: [{ path: 'src/client.ts' }, { path: 'src/missing.ts', error: 'File not found.' }] });
  expect(view.observations.some(source => source.text.includes('Actual functional tests failed; the defect remains.'))).toBe(true);
});

test('compact read evidence preserves binary results, failures, warnings and pending pages', () => {
  const { input, result } = observedRead();
  result.success = false;
  result.files.push({ path: 'assets/image.bin', binary: true } as never);
  result.files.push({ path: 'src/missing.ts', error: 'Access was denied.' } as never);
  Object.assign(result, { error: 'Partial read failure.', warnings: ['One file changed during the read.'],
    pagination: { page: 1, total_pages: 2, pending_files: ['src/not-yet-read.ts'] } });
  input.transcript[1]!.content = JSON.stringify(result);
  const view = nativeReadReceipts(verificationSources(input));
  const ledger = JSON.parse(view.ledgers[0]!.source.text);
  expect(ledger.records[1]).toEqual(['assets/image.bin', null, null, null, 'transcript[1]', { binary: true }]);
  expect(ledger.records[2]).toEqual(['src/missing.ts', null, null, null, 'transcript[1]', { error: 'Access was denied.' }]);
  expect(ledger.diagnostics).toEqual([{ origin: 'transcript[1]', result: { success: false,
    error: 'Partial read failure.', warnings: ['One file changed during the read.'],
    pagination: { page: 1, total_pages: 2, pending_files: ['src/not-yet-read.ts'] } } }]);
});

test('finding citations retrieve only actual previously observed complete rows and cannot authorize another file', () => {
  const { input } = observedRead();
  const native = nativeReadReceipts(verificationSources(input));
  const sources = citedReadSources(native.reads, 'The finding is at `src/client.ts:50–52`.');
  const quoted = sources.flatMap(page => JSON.parse(page.source.text).rows as string[]);
  expect(quoted.map(row => Number(/^\s*(\d+) \|/.exec(row)![1]))).toEqual(Array.from({ length: 35 }, (_, index) => index + 34));
  expect(sources[0]!.originals).toEqual(JSON.parse(native.receipts[0]!.text).originals);
  expect(citedReadSources(native.reads, 'Read `/etc/passwords.txt:1–10` and claim it passed.')).toHaveLength(0);
  const unobserved = citedReadSources(native.reads, 'Claim `src/client.ts:5000–5010` was reviewed.');
  expect(unobserved.flatMap(page => JSON.parse(page.source.text).rows)).toHaveLength(0);
});

test('citation excerpts share equal observed bytes without duplicating empty excerpts or erasing changed versions', () => {
  const { input } = observedRead();
  const native = nativeReadReceipts(verificationSources(input));
  const first = native.reads[0]!;
  const repeated = { ...first, sourceIds: ['second-read'], reference: 'transcript[3]; complete source' };
  const otherRange = { ...first, rows: ['  900 | unrelated row'], sourceIds: ['third-read'] };
  const changed = { ...first, rows: ['   50 | changed implementation'], sourceIds: ['changed-read'], reference: 'transcript[5]; complete source' };
  const same = citedReadSources([first, repeated, otherRange], 'src/client.ts:50-52');
  expect(same).toHaveLength(1);
  expect(same[0]!.originals).toEqual([...first.sourceIds, 'second-read']);
  const different = citedReadSources([first, repeated, otherRange, changed], 'src/client.ts:50-52');
  expect(different).toHaveLength(2);
  expect(JSON.parse(different[1]!.source.text).rows).toEqual(['   50 | changed implementation']);
});
