import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashState } from '@goodvibes-jev/judgment';
import { currentFileObservations } from '../../sdk/src/platform/contract/evidence.js';
import { finalAnswerEvidence } from '../../sdk/src/platform/contract/final-answer-evidence.js';
import { makeContract, makeUnit } from './fixtures.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const contract = makeContract({ units: [makeUnit({ status: 'passed', answer: 'A historical draft with superseded progress.',
    checks: [{ id: 'u1.k1', at: 1, trigger: 'completion', result: 'pass', quality: {}, decisionIds: ['native-unit-check'],
      goal: { verdict: 'met', probabilityUnmet: 0.1, outcome: 'act' }, evidenceDigest: 'checked-evidence' }],
    readEvidence: [{ path: 'review.md', returnedRanges: ['1-1'], returnedLines: 1,
      contentKind: 'declared-reference', returnedContent: '1 | Ready.' }],
  })] });
  const current = { operation: 'read-current-file', success: true, path: 'review.md', bytes: 7, binary: false, sha256: digest('Ready.\n') };
  const evidence = { orchestration: { currentFiles: [current], continuationEvidence: 'Initial work was unfinished.',
    units: [{ id: 'u1', status: 'passed', acceptedAnswer: contract.units[0]!.answer!, acceptedAnswerDigest: 'answer-digest',
      latestCheck: contract.units[0]!.checks[0]!, criteria: [{ text: 'The review is complete', verdict: 'met' }], readObservations: [] }] },
    diff: '-Initial limited draft\n+Ready.', hostOperations: [current],
    commands: [{ command: 'verify-archive', success: true, head: 'Integrity passed.' }], gates: [] };
  // JSON projection mirrors the real native host records, without widening their types.
  return { contract, evidence: JSON.parse(JSON.stringify(evidence)), current };
}

test('content review receives only byte-matched current primary artifact text and actual native receipts', () => {
  const f = fixture(); const before = JSON.stringify(f.contract);
  const checks = [{ criterion: 'c1', servedBy: ['u1.c1'] }];
  const view = finalAnswerEvidence(f.contract, f.evidence, { reports: 'Superseded draft', checks })!;
  expect(view.artifacts).toMatchObject([{ path: 'review.md', sha256: digest('Ready.\n'), content: '1 | Ready.',
    sourceUnitId: 'u1', sourceCheckId: 'u1.k1', decisionIds: ['native-unit-check'] }]);
  expect(view.evidence).toMatchObject({ originalRequest: f.contract.ask, criteria: checks,
    commands: f.evidence.commands, gates: f.evidence.gates,
    orchestration: { units: [{ latestCheck: { id: 'u1.k1', result: 'pass', decisionIds: ['native-unit-check'] } }] } });
  expect(JSON.stringify(view)).not.toContain('A historical draft with superseded progress.');
  expect(JSON.stringify(view)).not.toContain('Initial work was unfinished.');
  expect(JSON.stringify(f.contract)).toBe(before);
  expect(f.evidence.diff).toContain('Initial limited draft');
  expect(view.evidence['fullSourceEvidence']).toMatchObject({ digest: hashState(f.evidence), bytes: Buffer.byteLength(JSON.stringify(f.evidence)) });
});

test('root projection retains actual scope calculations and repair-plan admissions rather than replacing them with acceptance labels', () => {
  const f = fixture();
  const sourceJsonReferenceComparisons = [{ source: 'native-host-interval-comparison', referencePath: 'input.json',
    referenceSha256: 'bound-reference', groups: [{ referencedLines: 12, coveredReferencedLines: 11, missingReferencedLines: 1,
      missing: [{ path: 'source.ts', ranges: [[7, 7]] }] }] }];
  const repairPlanAdmissions = [{ id: 'repair-plan', decisionIds: ['native-repair-validation'] }];
  const native = { ...f.evidence, orchestration: { ...f.evidence.orchestration, sourceJsonReferenceComparisons, repairPlanAdmissions } };
  const result = finalAnswerEvidence(f.contract, native, {})!;
  expect(result.evidence['orchestration']).toMatchObject({ sourceJsonReferenceComparisons, repairPlanAdmissions });
  expect(JSON.stringify(result.evidence)).toContain('"missingReferencedLines":1');
  expect(result.evidence).not.toHaveProperty('passed');
});

test('native read tables preserve every original field, range and unit attribution while avoiding repeated column names', () => {
  const f = fixture();
  const reads = Array.from({ length: 200 }, (_, index) => ({ path: `src/file-${index}.ts`, returnedRanges: ['1-4', '8-12'], returnedLines: 9,
    ...(index === 0 ? { contentKind: 'declared-reference', returnedContentDigest: 'actual-retained-digest',
      returnedContentBytes: 85, validatedByCheckId: 'u1.k1', decisionIds: ['native-unit-check'], extra: null } : {}) }));
  f.evidence.orchestration.units[0].readObservations = reads;
  const before = JSON.stringify(f.evidence);
  const view = finalAnswerEvidence(f.contract, f.evidence, {})!;
  const unit = (view.evidence['orchestration'] as { units: { id: string; readObservations: {
    columns: string[]; rows: [string, string[], number, Record<string, unknown>?][];
  } }[] }).units[0]!;
  expect(unit.id).toBe('u1');
  expect(unit.readObservations.columns).toEqual(['path', 'returnedRanges', 'returnedLines', 'additionalFields']);
  const restored = unit.readObservations.rows.map(([path, returnedRanges, returnedLines, additionalFields]) => ({
    path, returnedRanges, returnedLines, ...additionalFields,
  }));
  expect(restored).toEqual(reads);
  expect(JSON.stringify(unit.readObservations).length).toBeLessThan(JSON.stringify(reads).length);
  expect(JSON.stringify(f.evidence)).toBe(before);
  expect(view.evidence['fullSourceEvidence']).toMatchObject({ digest: hashState(f.evidence) });
});

test('root criterion references resolve to complete identical unit criteria and preserve conflicting or extended values inline', () => {
  const f = fixture();
  const criterion = { id: 'u1.c1', text: 'Inspect all required source and return the reviewed artifact.', verdict: 'met' };
  f.evidence.orchestration.units[0].criteria = [criterion];
  const conflicting = { ...criterion, verdict: 'unmet' }, extended = { ...criterion, note: 'Additional evidence must not disappear.' };
  const checks = [{ criterion: 'original-c1', servedBy: [criterion, conflicting, extended] }];
  const view = finalAnswerEvidence(f.contract, f.evidence, { checks })!;
  expect(view.evidence['criteria']).toEqual([{ criterion: 'original-c1', servedBy: [{ criterionRef: 'u1.c1' }, conflicting, extended] }]);
  expect(view.evidence['orchestration']).toMatchObject({ units: [{ criteria: [criterion] }] });
  f.evidence.orchestration.units.push({ ...f.evidence.orchestration.units[0], id: 'duplicate-conflicting-unit', criteria: [conflicting] });
  expect(finalAnswerEvidence(f.contract, f.evidence, { checks })!.evidence['criteria']).toEqual(checks);
});

test('stale reads and unaccepted observations never replace full original evidence', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles[0].sha256 = digest('Changed.\n');
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
  f.evidence.orchestration.currentFiles[0].sha256 = f.current.sha256;
  f.contract.units[0]!.checks[0] = { ...f.contract.units[0]!.checks[0]!, decisionIds: [] };
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('an unrepresented textual change keeps the full evidence path; binary identity is not semantic approval', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles.push({ ...f.current, path: 'unknown.txt' });
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
  f.evidence.orchestration.currentFiles[1].binary = true;
  expect(finalAnswerEvidence(f.contract, f.evidence, {})?.artifacts).toHaveLength(1);
  f.evidence.orchestration.currentFiles[0].binary = true;
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('an auxiliary file keeps its complete actual native diff without dropping current primary report contents', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles.push({ ...f.current, path: 'SHA256SUMS', sha256: digest('new-checksum') });
  const change = { path: 'SHA256SUMS', diff: '--- SHA256SUMS\n-old-checksum\n+new-checksum' };
  f.evidence.diff += '\n' + change.diff;
  const before = JSON.stringify(f.evidence);
  const primary = finalAnswerEvidence(f.contract, f.evidence, {}, [change])!;
  expect(primary.artifacts).toHaveLength(1);
  expect(primary.evidence['currentTextualChanges']).toEqual([{ ...change, sha256: digest('new-checksum') }]);
  expect(JSON.stringify(f.evidence)).toBe(before);
  expect(finalAnswerEvidence(f.contract, f.evidence, {}, [{ ...change, diff: 'Invented replacement text' }])).toBeUndefined();
});

test('large historical reports stay retained and bound without overflowing the current verification view', () => {
  const f = fixture();
  const history = 'Earlier accepted report. '.repeat(60_000);
  f.contract.units[0]!.answer = history;
  f.evidence.orchestration.units[0].acceptedAnswer = history;
  f.evidence.orchestration.units[0].acceptedAnswerDigest = hashState(history);
  const projected = finalAnswerEvidence(f.contract, f.evidence, { checks: [{ criterion: 'original-c1' }] })!;
  expect(Buffer.byteLength(JSON.stringify(projected.evidence))).toBeLessThan(20_000);
  expect(projected.evidence['fullSourceEvidence']).toMatchObject({ digest: hashState(f.evidence), bytes: Buffer.byteLength(JSON.stringify(f.evidence)) });
  expect(f.contract.units[0]!.answer).toBe(history);
  expect(projected.evidence['orchestration']).toMatchObject({ units: [{ acceptedAnswerDigest: hashState(history),
    latestCheck: { result: 'pass', decisionIds: ['native-unit-check'] } }] });
  const oldBinding = (projected.evidence['fullSourceEvidence'] as { digest: string }).digest;
  f.evidence.orchestration.units[0].acceptedAnswer += 'Changed earlier evidence.';
  expect((finalAnswerEvidence(f.contract, f.evidence, {})!.evidence['fullSourceEvidence'] as { digest: string }).digest).not.toBe(oldBinding);
});

test('final artifact review receives complete actual current text when the diff omits unchanged sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-review-text-'));
  try {
    const text = '# Current review\n\nUnchanged findings and source assessments.\n\nUpdated execution attribution.\n';
    writeFileSync(join(dir, 'review.md'), text);
    const observed = currentFileObservations(dir, ['review.md'], { includeText: true });
    const contract = makeContract({ units: [] });
    const evidence = { orchestration: { currentFiles: observed }, hostOperations: observed,
      diff: '-Old attribution\n+Updated execution attribution.' };
    const view = finalAnswerEvidence(contract, evidence, {})!;
    expect(view.artifacts).toMatchObject([{ path: 'review.md', sha256: digest(text), content: text,
      decisionIds: [], sourceHostOperation: { operation: 'read-current-file', source: 'native-host-filesystem', success: true } }]);
    expect(JSON.stringify(view.evidence).split('Unchanged findings and source assessments.')).toHaveLength(2);
    expect(view.artifacts[0]).not.toHaveProperty('sourceCheckId');
    expect(view.evidence['orchestration']).toMatchObject({ currentFiles: [{ sha256: digest(text) }] });
    expect(view.evidence['fullSourceEvidence']).toMatchObject({ digest: hashState(evidence) });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupted current text observation cannot stand in for actual artifact bytes', () => {
  const f = fixture();
  f.evidence.orchestration.currentFiles[0] = { ...f.current, source: 'native-host-filesystem', text: 'Invented contents' };
  expect(finalAnswerEvidence(f.contract, f.evidence, {})).toBeUndefined();
});

test('binary and non-UTF8 bytes never become lossy text evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'current-review-binary-'));
  try {
    writeFileSync(join(dir, 'archive.zip'), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, 'legacy.txt'), Buffer.from([0xff, 0xfe]));
    for (const observation of currentFileObservations(dir, ['archive.zip', 'legacy.txt'], { includeText: true })) {
      expect(observation).not.toHaveProperty('text');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
