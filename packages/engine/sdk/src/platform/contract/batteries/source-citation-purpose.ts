import { defineBattery, yesNo, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** Select primary evidence without confusing a read ledger with a claim. */
export const sourceCitationPurpose = defineBattery({
  name: 'contract.source-citation-purpose',
  version: 2,
  description: 'Whether an identified source citation is a returned-read receipt rather than claim evidence.',
  accuracyFloor: 0.95,
  items: {
    receipt_only: yesNo(
      'In the full report context, is the identified citation occurrence used ONLY to account for which source was read, rather than to support a substantive finding, behavioral claim or assessment? Classify this occurrence, not the whole paragraph: a paragraph may contain a read ledger citation and a different claim citation. If this occurrence supports both, retain it. When citation is absent, classify the paragraph as a whole. Do not judge review completeness or correctness. The complete report and all returned-range records remain in the acceptance check.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
      { true: 'This occurrence is only returned-read accounting. Other occurrences may separately support findings.',
        false: 'This occurrence supports a finding, behavioral claim or assessment, or its own use mixes that support with read accounting.' },
    ),
  },
  fixtures: [
    { name: 'read ledger', state: { report: 'Actual read receipts follow.', paragraph: '- src/parser.ts:1-900 — returned 1-300, 301-600, 601-900; endpoints present.' }, expect: { receipt_only: 'yes' } },
    { name: 'finding', state: { report: 'The review found an unchecked decode.', paragraph: 'src/parser.ts:47-53 calls decodeURIComponent before the handler, so a malformed percent escape throws outside the recovery boundary.' }, expect: { receipt_only: 'no' } },
    { name: 'mixed receipt and finding', state: { report: 'Review details.', paragraph: 'Read src/parser.ts:1-900 completely; at lines 47-53 an unchecked decode can throw before recovery.' }, expect: { receipt_only: 'no' } },
  ],
});

/** Fixed semantic question per identified occurrence, batched in one request. */
export function sourceCitationBatch(count: number) {
  return defineBattery({ name: 'contract.source-citation-purpose', version: sourceCitationPurpose.version,
    description: sourceCitationPurpose.description, accuracyFloor: sourceCitationPurpose.accuracyFloor,
    items: Object.fromEntries(Array.from({ length: count }, (_, index) => [`citation_${index}`, yesNo(
      `Evaluate ONLY citations[${index}] in the state, identified by its path, start, end and offset. Other citation occurrences in the same paragraph may have different purposes. ${String(sourceCitationPurpose.items.receipt_only.question.instructions ?? '')}`,
      sourceCitationPurpose.items.receipt_only.band,
      sourceCitationPurpose.items.receipt_only.question.criteria ?? undefined,
    )])), fixtures: sourceCitationPurpose.fixtures.map(fixture => {
      const state = fixture.state as { report: string; paragraph: string; citation?: Record<string, string | number> };
      return { name: fixture.name, state: { ...state, citations: Array.from({ length: count }, () => state.citation ?? { context: state.paragraph }) },
        expect: Object.fromEntries(Array.from({ length: count }, (_, index) => [`citation_${index}`, fixture.expect.receipt_only ?? 'no'])) };
    }),
  });
}
