import { expect, test } from 'bun:test';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { makeHarness, oneUnitPlan, startContract, waitFor } from './runner-support.js';
import { terminal } from './steps-support.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';
const source: NativeContractSource = { sourceId: 'quality-work', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1', goal: 'Deliver the parser', criteria: ['Preserve parser behavior'] };
test('review: unchanged quality uncertainty cannot pass merely from another reading', async () => {
  let qualityReads = 0;
  const h = makeHarness({ recordNative: true, contract: { maxFixRounds: 0, evidenceNudgeLimit: 2 },
    plan: { ...oneUnitPlan(1), goal: source.goal, criteria: [{ id: 'c1', text: source.criteria[0]!, quote: source.criteria[0]! }] },
    scripts: { u1: () => [
      { files: { 'src/csv.ts': 'export const parser = 1;\n' }, text: 'same parser result' },
      { text: 'same parser result' },
    ] },
    port: context => context.name === 'unsupported_claims' ? noulAnswer(++qualityReads === 1 ? 0.2 : 0.03) : undefined,
  });
  try {
    const id = startContract(h, { nativeSource: source }).contract.id;
    await waitFor(() => terminal(h, id), 'native quality result', 15000); await h.runner.join(id);
    const result = h.store.get(id)!;
    console.log('REVIEW_QUALITY_RESULT', JSON.stringify({ status: result.status, qualityReads, checks: result.units[0]!.checks.map(c => ({ result: c.result, digest: c.evidenceDigest, quality: c.quality.unsupported_claims })) }));
    expect(qualityReads).toBe(1);
    expect(result.status).toBe('failed');
  } finally { h.dispose(); }
}, 20000);
