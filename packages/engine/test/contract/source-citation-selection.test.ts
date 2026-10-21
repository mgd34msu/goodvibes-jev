import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { selectSourceCitationEvidence } from '../../sdk/src/platform/contract/source-citation-selection.js';
import type { UnitEvidence } from '../../sdk/src/platform/contract/evidence.js';

function largeEvidence(output: string): UnitEvidence {
  return { output, changedPaths: [], diff: '', omitted: [], commands: [], sourceReads: [
    { path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000, contentKind: 'cited-source',
      returnedContent: Array.from({ length: 5000 }, (_, i) => `${i + 1} | const value${i} = decodeURIComponent(input);`).join('\n') },
    { path: 'input.json', returnedRanges: ['1-2'], returnedLines: 2, contentKind: 'declared-reference', returnedContent: '1 | {\n2 | }' },
  ] };
}

test('receipt quotations are removed without losing full scope, input, report, raw evidence or real finding citations', async () => {
  const evidence = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely. Finding: src/parser.ts:42-44 has an unchecked decode.');
  const raw = JSON.stringify(evidence), owner = {};
  const { port, requests } = fakePort((name, _, state) => noulAnswer((state as { citations: { start: number }[] }).citations[Number(name.split('_').at(-1))]!.start === 1 ? 0.99 : 0.01));
  const selected = await selectSourceCitationEvidence(owner, evidence, port);
  expect(selected.evidence.output).toBe(evidence.output);
  expect(selected.evidence.sourceReads![0]).toMatchObject({ returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(selected.evidence.sourceReads![0]!.returnedContent!.split('\n').map(row => row.split(' | ')[0])).toEqual(['42', '43', '44']);
  expect(selected.evidence.sourceReads![1]).toEqual(evidence.sourceReads![1]);
  expect(JSON.stringify(evidence)).toBe(raw);
  expect(selected.usage.calls).toBe(1);
  await selectSourceCitationEvidence(owner, evidence, port);
  expect(requests).toHaveLength(1);
});

test.each([0.5, 0.01])('uncertain or substantive citation contexts retain every source byte (%s)', async probability => {
  const evidence = largeEvidence('src/parser.ts:1-5000 was read and contains an unchecked decode.');
  const { port } = fakePort(() => noulAnswer(probability));
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence).toBe(evidence);
});

test('a receipt-only report keeps all observed ranges while reducing its check payload', async () => {
  const evidence = largeEvidence('Read receipts: src/parser.ts:1-5000 returned completely.');
  const { port } = fakePort(() => noulAnswer(0.99));
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence.sourceReads![0]).toEqual({ path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(JSON.stringify(selected.evidence).length).toBeLessThan(1000);
});

test('small evidence requires no extra judgment', async () => {
  const evidence: UnitEvidence = { output: 'Reviewed the helper.', changedPaths: [], diff: '', omitted: [], commands: [] };
  const { port, requests } = fakePort(() => { throw new Error('no call expected'); });
  expect((await selectSourceCitationEvidence({}, evidence, port)).evidence).toBe(evidence);
  expect(requests).toEqual([]);
});

test('old primary quotations are not retransmitted after the report removes its old citations', async () => {
  const evidence = largeEvidence('The revised read ledger lists paths and intervals in separate fields; no old source citations remain.');
  const { port, requests } = fakePort(() => { throw new Error('no current citations to classify'); });
  const selected = await selectSourceCitationEvidence({}, evidence, port);
  expect(selected.evidence.sourceReads![0]).toEqual({ path: 'src/parser.ts', returnedRanges: ['1-5000'], returnedLines: 5000 });
  expect(selected.evidence.sourceReads![1]).toEqual(evidence.sourceReads![1]);
  expect(requests).toEqual([]);
  expect(evidence.sourceReads![0]!.returnedContent!.length).toBeGreaterThan(100000);
});
