import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOwnerReadEvidenceReader } from '../../sdk/src/platform/runtime/owner-read-evidence.js';
import { makeContract } from './fixtures.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';
import { contractWorkReceipts, workReceiptIdentity } from '../../sdk/src/platform/contract/work-receipts.js';
import { hashState } from '@goodvibes-jev/judgment';
import { observeReadContent } from '../../sdk/src/platform/tools/read/observation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeRepo(); roots.push(root);
  writeFileSync(join(root, 'source.ts'), 'first\nsecond\nthird\n');
  git(root, 'add', 'source.ts'); git(root, 'commit', '-qm', 'Original source');
  const surface = join(root, '.goodvibes/tui');
  mkdirSync(join(surface, 'sessions'), { recursive: true }); mkdirSync(join(surface, 'recovery'), { recursive: true });
  const contract = makeContract({ projectRoot: root, sessionId: 'user-original',
    inputSnapshot: { inputTree: git(root, 'rev-parse', 'HEAD^{tree}').trim() } as Contract['inputSnapshot'] });
  const messages = [
    { type: 'meta', schemaVersion: 2 },
    { role: 'assistant', toolCalls: [{ id: 'original-read', name: 'read', arguments: { files: [{ path: 'source.ts' }] } }] },
    { role: 'tool', callId: 'original-read', content: JSON.stringify({ success: true, files: [{ path: 'source.ts',
      resolvedPath: join(root, 'source.ts'), lineCount: 9999, extract: 'content', content: '1 | first\n2 | WRONG\n9 | invented' }] }) },
  ];
  const saved = join(surface, 'sessions/user-original.jsonl');
  writeFileSync(saved, messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  return { root, surface, contract, messages, saved, read: createOwnerReadEvidenceReader(surface) };
}

test('earlier owner reads retain only actual returned lines matching the immutable contract input', () => {
  const f = fixture(); const evidence = f.read(f.contract, 'source.ts:1-3');
  expect(evidence).toMatchObject({ kind: 'original-owner-read-observations', ownerSessionId: 'user-original',
    inputTree: f.contract.inputSnapshot!.inputTree, callIds: ['original-read'],
    sourceReads: [{ path: 'source.ts', returnedRanges: ['1'], returnedLines: 1, returnedContent: '1 | first' }] });
  expect(JSON.stringify(evidence)).not.toContain('WRONG');
  expect(JSON.stringify(evidence)).not.toContain('invented');
  expect(JSON.stringify(f.read(f.contract, ''))).not.toContain('returnedContent');
  writeFileSync(join(f.root, 'source.ts'), 'changed\n');
  git(f.root, 'commit', '-qam', 'Changed source');
  const changed = { ...f.contract, inputSnapshot: { ...f.contract.inputSnapshot!, inputTree: git(f.root, 'rev-parse', 'HEAD^{tree}').trim() } };
  expect(f.read(changed, 'source.ts:1')).toMatchObject({ sourceReads: [] });
});

test('host-bound plain owner returns still require a match to immutable original source', () => {
  const f = fixture();
  const content = 'second\nWRONG';
  f.messages[2]!.content = JSON.stringify({ success: true, files: [{ path: 'source.ts', extract: 'lines', content,
    readObservation: observeReadContent(content, 2, 2, false) }] });
  writeFileSync(f.saved, f.messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  expect(f.read(f.contract, 'source.ts:2-3')).toMatchObject({ sourceReads: [{ path: 'source.ts', returnedRanges: ['2'],
    returnedLines: 1, returnedContent: '    2 | second' }] });
  expect(JSON.stringify(f.read(f.contract, 'source.ts:2-3'))).not.toContain('WRONG');
});

test('a live recovery snapshot contributes real reads without inventing operations from assertions', () => {
  const f = fixture();
  writeFileSync(join(f.surface, 'recovery/recovery-user-original.jsonl'), [
    { type: 'meta', schemaVersion: 2 }, { role: 'assistant', content: 'I read all 9999 lines.' },
    { role: 'tool', callId: 'unmatched', content: JSON.stringify({ success: true, files: [{ path: 'source.ts', content: '3 | third' }] }) },
    { role: 'assistant', toolCalls: [{ id: 'outline', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'outline', content: JSON.stringify({ success: true, files: [{ path: 'source.ts', extract: 'outline', content: '3 | third' }] }) },
    { role: 'assistant', toolCalls: [{ id: 'recovery-read', name: 'read', arguments: {} }] },
    { role: 'tool', callId: 'recovery-read', content: JSON.stringify({ success: true, files: [{ path: 'source.ts', extract: 'lines', content: '2 | second' }] }) },
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  expect(f.read(f.contract, '')).toMatchObject({ sourceReads: [{ returnedRanges: ['1-2'], returnedLines: 2 }] });
  expect(f.read({ ...f.contract, sessionId: '../other' }, '')).toBeUndefined();
  expect(createOwnerReadEvidenceReader(join(f.root, 'foreign'))(f.contract, '')).toBeUndefined();
});

test('redirected session storage cannot contribute prior-owner observations', () => {
  const f = fixture(); const bytes = readFileSync(f.saved);
  rmSync(join(f.surface, 'sessions'), { recursive: true });
  const other = join(f.root, 'foreign'); mkdirSync(other); writeFileSync(join(other, 'user-original.jsonl'), bytes);
  symlinkSync(other, join(f.surface, 'sessions'));
  expect(f.read(f.contract, '')).toBeUndefined();
});

test('correction proposal identity ignores bookkeeping but changes when actual owner observations change', () => {
  const f = fixture(); const work = { ...contractWorkReceipts(f.contract, { ownerEvidence: f.read(f.contract, '') }),
    privateArchiveChecks: [{ unitId: 'repair', gate: 'preservation', passed: true, output: 'Matched.', durationMs: 1 }] };
  const first = hashState(JSON.stringify(workReceiptIdentity(work)));
  const later = JSON.parse(JSON.stringify(work));
  later.privateArchiveChecks[0].durationMs = 89;
  later.ownerPriorReads.sources[0].sha256 = 'another-session-save-with-the-same-reads';
  expect(hashState(JSON.stringify(workReceiptIdentity(later)))).toBe(first);
  later.ownerPriorReads.sourceReads[0].returnedRanges = ['1-2'];
  expect(hashState(JSON.stringify(workReceiptIdentity(later)))).not.toBe(first);
});

test('decoded stderr keeps observational number withholding while the native receipt stays exact', () => {
  const f = fixture();
  const raw = JSON.stringify({ cmd: 'ls', success: true, exit_code: 0, stdout: 'Directory listing', stderr: 'owner 4111111111111111' });
  f.contract.units[0]!.commandEvidence = [{ command: 'ls', success: true, head: raw, agentId: 'previous-worker', turn: 1, callIndex: 0, callId: 'listing' }];
  const projected = contractWorkReceipts(f.contract, { readObservations: true });
  expect(JSON.stringify(projected)).not.toContain('4111111111111111');
  expect(JSON.stringify(projected)).toContain('[WITHHELD:card-shaped-number]');
  expect(f.contract.units[0]!.commandEvidence[0]!.head).toBe(raw);
});
