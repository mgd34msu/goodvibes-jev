import { defineBattery, yesNo, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** Select primary evidence without confusing a read ledger with a claim. */
export const sourceCitationPurpose = defineBattery({
  name: 'contract.source-citation-purpose',
  version: 1,
  description: 'Whether a paragraph uses source citations only as returned-read receipts.',
  accuracyFloor: 0.95,
  items: {
    receipt_only: yesNo(
      'In the full report context, does paragraph use its file/line references ONLY to account for which source was read, rather than to support a substantive finding, behavioral claim or assessment? A mixed paragraph is not receipt-only. Do not judge whether the review is complete or correct. This selects source excerpts; the complete report and all actual returned-range records remain in the acceptance check.',
      { yes: STAKES_BANDS.medium.confidence, no: STAKES_BANDS.high.confidence },
      { true: 'Only a returned-read ledger, scope receipt, or endpoint accounting; no substantive source assertion depends on these citations.',
        false: 'A finding, behavioral claim or assessment uses the citations as primary support, or the paragraph mixes such claims with receipts.' },
    ),
  },
  fixtures: [
    { name: 'read ledger', state: { report: 'Actual read receipts follow.', paragraph: '- src/parser.ts:1-900 — returned 1-300, 301-600, 601-900; endpoints present.' }, expect: { receipt_only: 'yes' } },
    { name: 'finding', state: { report: 'The review found an unchecked decode.', paragraph: 'src/parser.ts:47-53 calls decodeURIComponent before the handler, so a malformed percent escape throws outside the recovery boundary.' }, expect: { receipt_only: 'no' } },
    { name: 'mixed receipt and finding', state: { report: 'Review details.', paragraph: 'Read src/parser.ts:1-900 completely; at lines 47-53 an unchecked decode can throw before recovery.' }, expect: { receipt_only: 'no' } },
  ],
});
