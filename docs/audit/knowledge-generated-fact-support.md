# Generated fact support before knowledge writes

THE-23 adds a bounded support barrier for generated fact fields and subject
attachments. It builds on THE-21 primary-source planning and THE-24 node review
authority. These are deterministic implementation and integration checks, not
claims of measured model accuracy.

## Semantic contract

Two registered, versioned batteries read exact field support and exact subject
attachment. Both declare accuracy floor 0.95 and use the high-stakes yes/no bands.
A whole selected persistence pass requires every reading to settle act/yes.
Source authority, relevance, one-source provenance, existing graph links and a
producer's confidence are not substitutes for factual support. Fixtures cover
changed quantities, units, qualifiers, negation, variants, accessories, fabricated
quotes and hostile source instructions.

The reader receives the actual in-space source and extraction snapshot used for
derivation, the exact proposed claim, and exact subject identities. Every claimed
source is verified independently. A source summary/title alone is insufficient;
actual extraction excerpt, sections or established extracted-text paths are
required. Generated projection sources are excluded. Missing extraction leaves
enrichment explicitly skipped, or repair staged while extraction is pending,
without generating or writing summary-derived claims.

`prepareGeneratedFactSupport` is read-only. It returns detached, deeply frozen
plans only after the entire input settles. Unavailable, uncertain, negative,
malformed, missing-evidence, stale, foreign-space, aborted and over-budget paths
hold without partial plans or a permissive fallback.

## Privacy and resource bounds

Plain-data inspection rejects accessors, unusual prototypes, cycles, sparse
persisted-field arrays and non-finite data without invoking producer accessors.
Only explicit claim, identity, source-reference and extraction fields enter model
state. Arbitrary source metadata is omitted from generation and verification.
Every selected payload receives the existing protected-input check before the
first port acquisition/transmission and before clipping. This checker is not a
universal PII or unknown-secret detector, and does not grant a new transmission
permission. Opaque-looking identifiers still receive the conservative scan; a
Luhn-valid numeric run can therefore hold even when it originated in a generated
identifier. There is no blanket ID-field exemption. Synthetic fixture identifiers
are explicit so this conservative behavior cannot randomly change test outcomes.

Hard bounds are 400 claim/source inputs, 4,000 requests, 32,000,000 serialized
bytes, concurrency four and a 120-second pass deadline. Options only tighten
bounds. Exact duplicate requests share one per-operation reading. Contradictory
versions of a source, extraction or subject hold. The deadline/abort race bounds
custom ports that ignore AbortSignal; pending late completions cannot authorize
writes. Generated repair operations use a parent budget and cancellation signal.

## Persistence integration

- Regular enrichment resolves all fact/attachment support and primary-source
  choices before entities, facts, gaps, wiki links or enrichment state change.
  Facts omitted from node persistence but copied into deterministic wiki output
  still receive support readings. Source/extraction/subject state is captured
  before generation and checked again after it returns.
- Prepared repair profile facts capture exact source/extraction/operator state,
  freeze the claim and resolved metadata, and revalidate at write entry. Metadata
  adapters cannot replace verified fields, receipts or namespace after reading.
  The write handle performs no model requests.
- Repair subject linking verifies the full selected pass, including legacy
  metadata-only source references, before changing fact metadata or describes
  edges. Existing source links are not grandfathered into factual approval.
- Supersession verifies the retained claim against every remaining source before
  moving primary provenance. Exact case-sensitive IDs remain distinct.
- All planned ordinary node mutations use THE-24's shared
  `store.assertNodeMutation` normalization/authority seam before the first
  affected mutation. Actual upserts recheck authority. A reviewed fact, entity,
  gap, wiki or superseded row holds the pass rather than allowing earlier writes.
  Typed authority holds cannot trigger semantic fallback promotion.

An optional cooperative `shouldStop` probe propagates through repair support,
prepared writes and enrichment so a lifecycle cancellation during generation or
reading cannot authorize late knowledge writes.

Source, extraction, node, edge and operator snapshots are checked at write entry.
`store.batch` delays saving; it is not a rollback transaction. This implementation
provides a prepared pre-write barrier, not cross-operation transaction atomicity.
A mutation occurring after an earlier write can still cause a later guarded write
to hold. Whole-driver atomicity is not claimed.

## Receipts

Receipts retain battery/version, settled probability/outcome, exact claim/field/
subject hashes, source and extraction identity/version/hash, full projected-state
hash and the extraction evidence reference. Provider decision IDs are optional
and retained only when actually supplied. `receiptId` is explicitly a local
attestation identifier, never a fabricated provider log ID. Rereads replace the
latest receipt per source/field/subject/battery instead of growing without bound.
Separate source receipts remain separate for canonical facts shared by sources.
Stored receipts never authorize a new write without fresh selected support reads.

## Verification and remaining scope

Expanded offline knowledge/Home Graph/node-authority regression: 371 tests,
2,549 assertions across 37 files, including the full reader/write-boundary suite
and mid-profile rollback regression. These include foreign space before generation, private metadata omission,
late unsupported claims preventing all writes, stale extraction, immutable
prepared handles, operator decisions after preparation, and unsupported legacy
source references. Explicit fixtures do not measure live model calibration.

Live fixture calibration requires a configured compatible judgment endpoint and
remains outstanding. Broader K4 answer fidelity/sufficiency/confidence, generated
entity/relation/freeform-wiki fidelity, repair gap coverage, K1 activation policy
and taint, remaining K3 retrieval semantics, K5 Home Graph policy and product parity
remain distinct required work. This change does not label them complete.
