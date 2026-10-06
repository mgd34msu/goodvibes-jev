# Home Graph semantic retrieval (THE-21 follow-on)

## Executable replacement

`HomeGraphService.ask` now calls `readHomeGraphSearchSelection` after its existing
extraction-repair stage. The answer-search branch of `home-graph/search.ts` is
removed: query stop-word/synonym scoring, TV/domain/record-type preferences,
source/link/indexing boosts, anchored-source replacement, token-coverage pruning,
keyword excerpt windows, sentence tie-breaking and clipped-prefix fallback no
longer decide answer retrieval. The remaining functions in that file serve the
separate extraction-repair candidate policy; they are not a backup search path.

The new path protects complete source/extraction and node meaning individually,
then reads settled object/integration context with the existing typed reader.
Every eligible candidate is considered before the requested result limit. The
existing evidence-relevance battery receives complete candidate content and
separate settled subjects, including model/variant identity. It decides both
membership and ordering; no source kind, producer score or shared token grants
admission. Empty, uncertain, malformed, unavailable, protected and stale outcomes
never invoke the deleted path.

Literal answers reuse the exact local completed result array through an opaque
WeakMap handoff, rather than reading scope again or accepting a serialized
"already checked" flag. The old numeric retrieval-points field is zero because
no legacy points were computed; relevance probabilities order rows internally
and are never represented as literal answer confidence.

## Bounded complete-candidate composition

`prepareAnswerEvidenceRelevanceBatches` reuses the shared reader and transport.
It validates all complete candidates before the first dispatch, including late
candidates, then partitions whole candidates into the unchanged 100-candidate /
160,000-character reader limits. It never joins the entire corpus for the
protected-input gate, clips a source, splits a qualification away from its
claim, or silently drops candidates beyond a batch boundary. One shared deadline
bounds the operation and ignored-signal readers. A failing later batch produces
no partial selection.

Global ordering uses the existing battery's independent probability readings:
each actual request contains only the same query, candidate and subject context,
not its batch peers. Original request-local references remain unchanged across
partitions. Actual model, requested model, port identity and configured model
must match across all batches. Ties retain the original candidate order. This
establishes partition-invariant plumbing, not empirical probability calibration.

Admitted result-summary metadata retains the existing shared extraction-
readability reader. Its original sample/protection policy is unchanged, and
its result cannot supply an excerpt fallback. Its shared operation receives the
retrieval cancellation signal; the public one-argument compatibility helper
retains its existing contract. Selected source excerpts use the
existing exact-original-span reader. The shared
`prepareAnswerSourceExcerptBatches` prepares each complete source before any
read, preserves full within-source heading/table/footnote bundles and local span
provenance, and reads only admitted sources. It keeps the original per-reader
limits and validates actual/requested models across sources. It is also used by
the semantic answer collector and linked-source path, so those downstream
stages do not reintroduce a corpus-sized excerpt snapshot. An explicitly empty
selection is `excerpt: ''`; the literal renderer cannot revive an unselected
summary, description or token prefix.

The original fixture of one useful TV manual and 32 decoys with 128 KiB sections
retains all original successful assertions. New functional fixtures also cover
candidate 105, late exceptions beyond old field/display clips, and a configured
semantic answer with 32 rejected large linked sources. No reader/protection cap
was increased. A single complete candidate or source that exceeds its existing
reader limits still holds; large-document streaming and unrestricted retrieval
are not claimed here.

## Provenance and lifecycle

Each search result remains bound to the captured source, node, extraction,
concrete knowledge space, graph universe and original question. Source and
extraction space/source identity must agree. Full original extraction protection
precedes projection; record IDs remain local. The shared semantic node-serving filter excludes research gaps and requires
in-scope indexed, non-generated support for factual nodes. The same captured
source set bounds reference-header projection, so an active fact cannot expose
stale or foreign source context after its support changes. Excluded rows remain
in the local change guard. Existing generated-page and active-record filters
remain in place. Shared reader dispatch checks
run immediately before `port.ask`, including later candidates and spans.

An internal candidate-window handoff carries the completed search decision into
configured semantic answers. Empty windows stay empty; initial or linked-source
expansion cannot revive a rejected source or an embedded rejected fact. Accepted
supporting sources for winning facts or objects survive a smaller display limit,
and accepted facts may support admitted sources without being display winners.
These are structural support associations among independently accepted rows,
not relevance boosts. Direct semantic callers retain their existing windows and
contracts; no public bypass flag is added.

The existing foreground-repair workflow legitimately changes the evidence
corpus. At its existing successful-repair or completed-wait re-answer transition,
a private hook performs a fresh complete typed retrieval. The original question,
selected subject records and reader configuration remain guarded, and the new
pass must retain the original settled subject IDs. A stale or failed read never
retries itself. This preserves the original successful repair fixtures without
silently rebinding an old window to new evidence. The existing transport remains
the sole availability/backoff implementation.

No new write authority is granted. The earlier selected-device guard still owns
post-answer page/passport handoff; browser judgment recording and native session
policy are untouched. Search, semantic answer, foreground repair and page refresh
retain their existing operation boundaries rather than pretending to be one
rollback transaction.

## Proof and remaining gates

Deterministic tests exercise semantic paraphrases versus keyword stuffing,
source-type counterexamples, stable repeat ordering, unchanged request state
across partitions, exact spans and late qualifications, empty outcomes, missing
or uncertain readers, model/configuration drift, source changes before later
batches, complete late protected input, original-query mutation during generation,
rejected embedded facts and retained supporting references. Independent probes
reproduced the handoff/support regressions before their fixes.

The tests use authored synthetic readings and owned synthetic inputs. They do
not qualify a genuine provider's accuracy, classification, calibration or
large-corpus latency; THE-35 remains the live qualification gate. Extraction-
repair candidate ranking remains separately reachable and outside this change's
THE-20 boundary. Broader write-authority/taint review and remaining inventoried
ranking work are separate acceptance gates. THE-21 remains open pending that
full reconciliation, rather than being closed by this bounded PR.
