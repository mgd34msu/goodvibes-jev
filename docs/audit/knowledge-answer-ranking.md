# Answer source/fact relevance, THE-21 phase A

## Implemented

Registered `engine.knowledge.answer-source-rank` and `engine.knowledge.answer-fact-rank` rerank candidates against the complete question. Actual title/summary/value/excerpt/evidence is read; extractor type, claimed authority, result position and fact counts no longer form these two ranking ladders. The source reader receives extracted excerpts as well as source-linked facts, rather than judging only a generic title. A third battery, `engine.knowledge.answer-query-intent`, replaces the feature/procedure keyword ladder at these call sites.

Only yes at act selects a source or fact. Settled no returns no selected record. An uncertain set without a settled match holds visibly; unavailable readers propagate their failure without recovering old points. Empty or structurally excluded candidate sets need no model. Original source/fact IDs are retained, duplicate IDs are collapsed and equal probabilities sort by ID. Source references still come only from the caller's existing scope/access filters.

A stage considers at most 50 candidates with four concurrent pair readings. These are explicit request budgets, not guessed quality cutoffs. Source/fact selected data is preflighted as a whole before the first concurrent transmission; arbitrary metadata, database timestamps and model-unneeded IDs are omitted. Choice application is attached to recorded decisions where a recorder is configured.

The answer path awaits these readings before generation. Rejected source records and their source-backed facts are removed from generation inputs. A later lexical claimed-authority helper no longer re-adds them as citations. If the evidence set is empty after a settled rejection, the answer reports no source-backed match without spending on synthesis. Uncertain or unavailable judgment fails before new answer-gap writes. Fact rendering keeps supplied evidence text rather than discarding it through the former keyword blacklist.

## Deterministic evidence

Fake readings test contrary-to-old-extractor/authority/keyword cases, query paraphrases, settled no versus uncertainty, missing ports, exact IDs/ties, scope-associated facts, protected batch preflight, full excerpts and explicit request caps. Real temporary SQLite answer tests verify no synthesis or knowledge mutation on missing/failed/uncertain readings, and that a rejected claimed-official source is not reintroduced into generation or citations. Existing answer/repair assertions remain unchanged; off-intent synthetic facts have explicit negative readings in the plumbing fixtures.

Targeted command:

`bun packages/engine/scripts/test.ts test/knowledge-answer-judgment-holds.test.ts test/knowledge-source-ranking-judgment.test.ts test/knowledge-fact-selection-judgment.test.ts test/knowledge-semantic-answer.test.ts`

## Explicit remaining work

This is not all of THE-21 or K3. `source-quality.ts`, the remaining `sourceAuthorityBoostForAnswer` users, Home Graph page-source policy/weights, initial lexical evidence retrieval/alias and node-kind boosts still require their assigned follow-on conversions. Ordinary answer synthesis/fidelity and broader knowledge write authority belong to K4/K1 gates. The current budgets are per stage; an end-to-end query deadline/shared reading context needs to be established before live latency proof.

The three new decisions have fixtures and a 0.90 calibration floor. No live semantic accuracy claim is made: the cloud workspace has no configured System One endpoint/key. Once securely configured, calibrate `sdk/src/platform/knowledge/semantic/ranking/judgment-registry.ts` with the existing judgment package calibration command. Whole-engine/product aggregate and Buzz integration remain separate pending gates.

## THE-21 phase B: source quality and safe async consumers

`engine.knowledge.page-source-quality` reads source usefulness and supported authority from a minimal source/provenance projection. Its actual usefulness probability supplies the page order and weight; source types, search position, URL words and claimed official labels no longer supply a point ladder. Indexed/pending/generated status remains structural. Both readings must settle at act; an absent/unavailable/uncertain reader holds without a heuristic fallback. The exported quality helpers are async; prefer the new operation-local batch reader/ranker instead of passing an async comparator to Array.sort.

An operation reads at most 50 scoped sources with four concurrent requests. It preflights the complete selected batch, omits arbitrary metadata/timestamps, reuses exact in-operation readings, and refuses inconsistent duplicate source versions. Primary fact preference is claim-specific, same-space and bounded by explicit candidate/decision/request budgets. A single source is provenance bookkeeping only, not a claim-support certification. All primary preferences and supersession plans resolve before an affected enrichment/promotion/page pass writes. Prepared profile plans preserve original order, duplicate-fact support unions and per-source edges. Their write entry independently revalidates frozen source and operator state; passport compensation restores only rows the failed pass actually touched, preserving concurrent edits to untouched records. Exact source, extraction, subject, fact and edge snapshots are checked before mutation. Typed holds propagate instead of starting an enrichment fallback.

Home Graph room scope is applied before the candidate cap. Unknown room IDs cannot broaden to all objects. Room/passport quality reads share an operation-local reader; generated state and source/extraction versions are checked before page persistence. Automatic page work has a cancellable run budget; room materialization receives the same signal. Ask-refresh excludes foreign source/device/fact records and same-ID foreign collisions before transmission, checks rows again after reading, and only links facts whose sources were selected. Store.batch is save batching, not a transaction; this change establishes a pre-write barrier and existing passport compensating cleanup, not distributed atomicity or whole repair-driver rollback.

Relevance probabilities are not answer-confidence scores. Linked-evidence union preserves each existing retrieval score exactly, gives newly discovered references no invented points, and orders selected linked sources without comparing probability to old points. The original answer-llm.ts score/5 plus fact-count fallback and self-reported confidence remain an explicit separate K4 fidelity/sufficiency conversion. Other remaining K3 work includes initial lexical retrieval and node-kind/alias boosts. THE23 will verify generated claims and subject attachments against actual extraction evidence; source authority/usefulness alone does not establish support.

Deterministic coverage includes protected whole-batch preflight, opposite-to-keyword source selection, stale and unavailable readers, distinct-claim primary decisions, duplicate fact provenance, supersession, cancellation, actual SQLite/artifact no-write boundaries and source/fact/device scope isolation. Existing Home Graph source-quality/repair assertions are preserved with explicitly labelled fake readings. A timestamp-only repeat of the identical repair-gap record can join an in-progress repair; changed intent, provenance or operator status still holds. The full current source row is guarded through later awaits.

Live calibration remains unconfigured. These offline fixtures test plumbing and safety, not achieved semantic accuracy.

## THE-21 phase C: initial evidence selection

The initial `collectAnswerEvidence` pass now asks
`engine.knowledge.answer-evidence-relevance` about the question as written and
complete selected source/extraction or node/fact meaning. This covers inventory
entries `docs/inventory/engine.md` lines 1827–1831 and 1840 in the pinned inventory:
synonym expansion, source/node token points, subject/alias penalties,
candidate/link/fact-count bonuses, positive-score filtering, top-minus-90 pruning,
and fixed record-kind boosts. Exact access/space membership, indexed source and
active node status, explicit candidate/graph membership, duplicate removal and
bounded source/node windows remain structural constraints.

The read-only foundation uses request-local candidate labels; database keys stay
in a guarded local map. Its actual 0–1 relevance probabilities are labelled as
such in results and are never rescaled to legacy retrieval points or answer
confidence. Candidates settle before a synchronous stable ordering. Any
unsettled, unavailable, stale, malformed, cancelled or over-budget pass holds the
whole selection. Settled rejection is distinct from a failed reading.

Full source/extraction meaning includes the established metadata content fields.
Concrete source/extraction space and identity must agree even when the request
uses a broad space alias. All candidate text and the exact structured claim
fields used by final fidelity are preflighted before the first semantic request.
That includes labels, aliases, fact kinds, target hints and graph-only subject
meaning. The structured guard runs before serializing claim details. Proven
fresh local source URIs use THE-36's record-bound projection; unknown/copied IDs
and external URLs keep ordinary protected-data handling. This is bounded
structural minimization, not universal personal-data detection.

Source, extraction, node, operator state and pertinent graph snapshots are
checked after awaits. Explicit candidate IDs cannot make draft claims serve.
An accepted fact may retain its accepted backing source internally even when the
public result limit is one. A request-local lineage guard prevents subsequent
official-linked-source enrichment from resurrecting an initial rejected source.
No source is added merely because it was labelled official. Whole-pass holds
reach the existing answer hold boundary before generation or repair writes.

Deterministic coverage includes a paraphrase outranking keyword stuffing,
record-kind and explicit-membership rejection, exact probability units,
no/uncertain/unavailable distinctions, protected late input with zero requests,
foreign source/extraction and draft isolation, graph-only protected subjects,
stale records, limit-one backing provenance and repeated linked-source vetoes.
Provider fixtures explicitly supply the new relevance decision; prior answer and
repair assertions remain in place. These fixtures establish plumbing and safety,
not live accuracy. THE-35 retains calibration and latency proof; THE-34 retains
cross-dot integration and full CI.

### Remaining K3 and adjacent inventory

This phase is not all of THE-21 or K3. Query subject extraction
(`GENERIC_ANSWER_INTENT_TOKENS`), integration intent, excerpt fact-line and
sentence selection, inferred object/query scope and any remaining shared search
scoring are still inventoried for subsequent bounded conversions. Repair-profile
category/value/wattage/count/query filters (inventory lines 1947–1954), generated
wiki/entity fidelity and related content generation remain explicit subsequent
work. Content generation still uses the real provider-backed generator; judgment
reads concrete candidates and does not invent a replacement generator API.
Existing phases A/B, THE-23 support, THE-27 answer fidelity, THE-31 page quality and
THE-32 activation remain separate decisions with distinct probability meanings.

The phase C caller tree passed 636 tests / 3,880 assertions across 63 explicit
knowledge/Home Graph suites through the repository's owned test runner, plus
build, forced solution and standalone type tests, API/subpath, line-cap,
credential-scope, no-any and error-contract checks. The initial relevance
foundation additionally has its isolated 16-test / 76-assertion proof. These are
local deterministic checks; publication, cross-dot CI and live proofs remain the
gates named above.
