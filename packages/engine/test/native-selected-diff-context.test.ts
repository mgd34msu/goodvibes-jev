import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { captureNativeSelectedDiffContext, nativeSelectedDiffRevision, selectNativeDiffHunk, NATIVE_SELECTED_DIFF_MAX_BYTES, NATIVE_SELECTED_DIFF_SOURCE_MAX_BYTES } from '../sdk/src/platform/workflow/work-ledger/native-diff-context.js';
import { canonicalNativeConversationContinuation, captureNativeConversationContinuation } from '../sdk/src/platform/workflow/work-ledger/native-continuation-context.js';
import { nativeConversationIntakeCaptureRequestSchema } from '../sdk/src/platform/workflow/work-ledger/native-intake-wire.js';

const headers = 'diff --git a/source.ts b/source.ts\nindex 1234567..abcdef0 100644\n--- a/source.ts\n+++ b/source.ts\n';
const hunk = '@@ -1,2 +1,2 @@ source\n--- original header-looking body\n+++ replacement header-looking body\n context\n';
const another = '@@ -90 +90 @@ another\n-before\n+after\n';

test('native diff selector hashes exact full bytes and keeps complete raw file headers and full hunk', async () => {
  const diff = headers + hunk + another;
  expect(await nativeSelectedDiffRevision(diff)).toBe(createHash('sha256').update(diff).digest('hex'));
  expect(await nativeSelectedDiffRevision(diff + '\n')).not.toBe(await nativeSelectedDiffRevision(diff));
  expect(selectNativeDiffHunk(diff, 0, 0)).toBe(headers + hunk);
  expect(selectNativeDiffHunk(diff, 0, 1)).toBe(headers + another);
  const many = '@@ -0,0 +1,80 @@\n' + Array.from({ length: 80 }, (_, i) => `+line ${i} 🌻\n`).join('');
  expect(selectNativeDiffHunk(headers + many, 0, 0)).toBe(headers + many);
  const binary = 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
  expect(selectNativeDiffHunk(binary + diff, 1, 1)).toBe(headers + another);
  const noNewline = headers + '@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n';
  expect(selectNativeDiffHunk(noNewline, 0, 0)).toBe(noNewline);
});

test('native diff selection refuses stale-shape, unsupported, missing and oversized input without truncating', () => {
  for (const diff of ['', 'not a diff', headers + '@@@ -1 +1 @@@\n-old\n+new\n', headers + '@@ -1,2 +1 @@\n-old\n+new\n', headers + '@@ -1 +1 @@\n-old\n+new\n+extra\n', headers + 'Binary files a/source.ts and b/source.ts differ\n']) {
    expect(() => selectNativeDiffHunk(diff, 0, 0)).toThrow('unsupported');
  }
  for (const [fileIndex, hunkIndex] of [[1, 0], [0, 2], [-1, 0], [0, 0.5]]) expect(() => selectNativeDiffHunk(headers + hunk, fileIndex!, hunkIndex!)).toThrow('missing');
  expect(() => selectNativeDiffHunk(headers + '@@ -0,0 +1 @@\n+' + 'x'.repeat(NATIVE_SELECTED_DIFF_MAX_BYTES) + '\n', 0, 0)).toThrow('oversize');
  expect(() => selectNativeDiffHunk('x'.repeat(NATIVE_SELECTED_DIFF_SOURCE_MAX_BYTES + 1), 0, 0)).toThrow('oversize');
});

test('selected evidence is deeply frozen, strict, session-bound, and fully revision-bound', async () => {
  const selected = { kind: 'session' as const, revision: await nativeSelectedDiffRevision(headers + hunk), fileIndex: 0, hunkIndex: 0, unifiedDiff: headers + hunk,
    provenance: { kind: 'session' as const, sessionId: 'hosted', baselineCheckpointId: 'EMPTY', latestCheckpointId: 'wcp_latest' } };
  const captured = captureNativeSelectedDiffContext(selected);
  selected.provenance.latestCheckpointId = 'changed';
  expect(captured.provenance).toMatchObject({ latestCheckpointId: 'wcp_latest' });
  expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.provenance)).toBe(true);
  let accessed = false;
  expect(() => captureNativeSelectedDiffContext({ ...selected, get unifiedDiff() { accessed = true; return headers + hunk; } })).toThrow();
  expect(accessed).toBe(false);
  expect(() => captureNativeSelectedDiffContext({ ...selected, fabricatedAuthority: true })).toThrow();
  const revision = createHash('sha256').update(canonicalNativeConversationContinuation('hosted', [], captured)).digest('hex');
  const continuation = captureNativeConversationContinuation({ sessionId: 'hosted', revision, messages: [], selectedDiff: captured });
  expect(continuation.selectedDiff).toEqual(captured);
  expect(() => captureNativeConversationContinuation({ ...continuation, sessionId: 'other' })).toThrow('session mismatch');
  expect(canonicalNativeConversationContinuation('hosted', [], captured)).not.toBe(canonicalNativeConversationContinuation('hosted', [], { ...captured, unifiedDiff: headers + another }));
  const selector = { kind: 'session' as const, revision: selected.revision, fileIndex: 0, hunkIndex: 0 };
  const command = { inputId: 'input', requestId: 'request', text: '  Exact comment 🌻\r\n  ', unsupportedSources: [], continuation: { sessionId: 'hosted', selectedDiff: selector } };
  expect(nativeConversationIntakeCaptureRequestSchema.parse(command)).toEqual(command);
  for (const forged of [{ ...selector, unifiedDiff: headers + hunk }, { ...selector, path: 'source.ts' }, { ...selector, projectId: 'project' }, { ...selector, principalId: 'owner' }, { ...selector, fileIndex: -1 }, { ...selector, kind: 'workspace' }]) expect(nativeConversationIntakeCaptureRequestSchema.safeParse({ ...command, continuation: { ...command.continuation, selectedDiff: forged } }).success).toBe(false);
});
