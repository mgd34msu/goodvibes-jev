# Home Graph answer object scope (THE-21 bounded increment)

> This records the PR151 increment. The subsequent [semantic retrieval follow-on](knowledge-home-graph-search.md) replaces its retained answer-search ranking and excerpt path; the historical proof below remains scoped to PR151.

## Replaced callers

`HomeGraphService.ask` retains the existing extraction-repair and bounded search
stages. `answerHomeGraphQuery` no longer calls the semantic `object-scope.ts`
helper, `canonicalRepairSubjectNodes`, or its own integration-intent regex. The
now-unreferenced 396-line object-scope module is removed. This replaces its
intent stop words, singular/type/model patterns, TV/domain preferences,
source-type/relation point weights, tie band and source/anchor token overlap.
These are the historical object-scope entries in `docs/inventory/engine.md`,
including the Home Graph answer consumer; the pinned inventory is not rewritten.

When a semantic service is configured, the caller passes its existing bounded
retrieval candidates and graph context directly to that service. THE-38's
existing typed alignment/integration readers make the selection once, followed
by the existing source/fact/excerpt and answer-verification readers. Response
results and background enrichment now use the actual semantic-selected results,
including when source display is suppressed. Rejected retrieval candidates do
not become enrichment targets merely because they were considered.

Without a semantic service, `prepareHomeGraphAnswerScope` reuses
`prepareAnswerLinkedObjects` for complete scoped-object preparation and recorded
alignment/integration readings. It then uses the existing evidence-relevance
reader with a separate typed `subjects` context. Battery version 2 explicitly
requires the candidate's own evidence to concern the selected objects/variants;
subject descriptions cannot become evidence about a source. An empty subject
list does not invent an anchor or reject every general-topic question. Every
retained result still needs a settled relevance yes. No, uncertainty, malformed,
unconfigured, unavailable, stale and budget outcomes have no token/weight backup.

The literal renderer remains literal and does not acquire gap generation or
persistence. Its numeric confidence field is zero (unknown), rather than a
clamped retrieval score. Scope selection preserves the existing result order and
retrieval score units. It does not label either points or relevance probability
as answer fidelity.

## Identity, privacy and lifecycle

The scope pass validates record kind/ID, current source/node rows and explicit
space before projection. Source extraction must identify the same source and
concrete space. Search-state construction now enforces that structural binding
before earlier readability or repair reads can transmit foreign extraction text.
The scope guard compares the extraction captured by search with the current
row; a replacement cannot lend fresh provenance to a stale excerpt. It also
checks the captured source/node/edge retrieval context before and after awaits.
Results must belong to that captured serving window; an otherwise current draft,
stale or generated source row cannot be injected as a caller result.

Full selected source fields and original extraction fields are protected before
using the existing bounded excerpt. Complete object meaning is prepared through
the shared protected projection. Request-local result references carry no store
IDs. The subject context preserves title, aliases, summary, kind and selected
structured identity: manufacturer, brand, vendor, model, model number, variant,
entity kind, subject and Home Assistant identity. Arbitrary administrative
metadata is not sent. Cross-space, stale, protected or changed source/object/
graph input holds before answer-dependent page work. Configuration is retained
across both reading stages through the shared answer-port snapshot guard.

Post-answer bookkeeping retains a separate guard against the original selected
device rows. It checks before source quality, at prepared graph write entry and
before passport handoff. A device moved to another installation or replaced
after selection cannot silently become a new baseline. This narrow device guard
survives legitimate source/fact bookkeeping without inheriting the completed
answer budget's aborted signal. It does not promise rollback of earlier valid
source writes or turn page refresh into a whole-ask transaction.

No new transport, retry loop or human-approval path is introduced. The shared
judgment transport owns availability retry; the existing shared answer budget
bounds the literal scope stage and aborts ignored-signal reads. This timeout does
not claim to cover preceding extraction repair or subsequent page refresh.

## Deterministic proof and calibration

Authored fixtures cover outcomes contrary to former object/source-type weights,
connection intent without old keywords, plural objects, settled empty/unscoped
selection, stable ordering and repeat calls, source-hidden enrichment lineage,
unknown confidence, missing/malformed/uncertain/unavailable reads, configuration
changes, stale rows, full-field protected data behind clipped excerpts, foreign
extractions, changed captured extraction lineage, foreign/wrong-ID results,
structured regional variants, and ignored-signal deadline cancellation.

An owned synthetic endpoint implementation exercises the actual shared transport
and decision log through multiple 503 responses before success. It verifies
recorded decisions and retry lineage. It uses no genuine provider or credential.
This is deterministic plumbing evidence, not live accuracy, calibration,
classification or latency qualification. THE-35 remains open for that work.

The final local offline knowledge/Home Graph run passed 1,052 tests with 6,355
assertions across all 82 suites. Independent probes reproduced then verified the
foreign-extraction, stale-excerpt, draft-result and selected-device write-boundary
holds. Compiler, build/API and static gates are verified separately from these
functional tests; exact-head CI remains the integration gate.

The original large-manual test still uses 32 decoy manuals with 128 KiB sections
and retains its successful result, source-title and linked-object assertions.
It passes through the unchanged bounded search path; no character cap was
increased and no input validation was weakened to obtain this result.

## Remaining work and limits

This does **not** complete THE-21 or K3. `home-graph/search.ts` still contains
lexical candidate retrieval/ranking, intent-word/source preferences, excerpt
selection and pruning. Its extraction-repair candidate selection also remains
reachable. Those upstream decisions can still omit a semantic paraphrase before
this scope stage. Repair-subject/repair-fact/gap heuristics elsewhere remain
separate work. No extraction/readability policy from THE-20 is replaced here.

The shared alignment limits (100 object candidates, 24 selected objects,
160,000 projected characters) and evidence-scope limits (100 results, 24 subject
identities, 160,000 characters) remain fail-closed. Configured semantic answers
retain their existing structural retrieval windows and contracts. This is not
unrestricted large-corpus semantic retrieval, a whole-ask transaction, a new
write-authority grant, or the separate broad taint/write-authority audit gate.
