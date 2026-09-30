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
