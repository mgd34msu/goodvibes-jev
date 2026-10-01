# Answer-gap admission and question equivalence

This bounded change replaces the pinned `engine.md` decisions at 1826 (generic
query-token removal for broad-space gap admission) and 1847 (keyword buckets,
sorted query tokens, ASCII-normalized or first-linked-subject merge identity).
It covers both live answer callers: no-match observations and matched answers
whose verified evidence is insufficient. Content generation remains the existing
plain-text generation path, separate from these discriminative readings.

## Meaning and exact policy

`engine.knowledge.answer-gap-admission` reads whether an unassociated broad
Home Assistant question identifies a research subject. Explicit object
associations, concrete-space admission and the prohibition on unassociated
default-space no-match gaps remain code. This is an observation that indexed
evidence was missing, never an endorsement of the question's factual premise.

`engine.knowledge.answer-gap-equivalence` reads the complete new question and
each existing in-space answer-gap question, with original Unicode text, title,
summary, recorded reason, subject identity and source provenance. Complete
explicit multi-subject associations remain intact. Different explicit nonempty
subject sets cannot merge; their order does not matter. Exact space/type and
local reference resolution remain code. There is no keyword prefilter, first
subject identity shortcut, normalization to ASCII, topic bucket or guessed
fallback. Every eligible reading must settle; multiple yes results hold rather
than choosing by list order.

One settled equivalent retains its exact node ID, slug, associated issue ID,
existing question and lifecycle fingerprint. A settled none allocates a fresh
UUID identity. This is allocation only, not a semantic comparison. No bulk
migration rewrites old gap identities. An associated issue's fingerprint and
lifecycle token remain its own even when a legacy node lacked a fingerprint.

## Preparation and persistence

The actual answer call snapshots the complete structural gap universe before
retrieval and generation can await. Its guard covers in-scope nodes, sources,
extractions, associated edges, issues, refinement lifecycle state and the newly
allocated absent node/slug/issue targets. The selected sources and subjects are
bound to the exact stored rows. Structural IDs use exact-string sets, never
case-insensitive text deduplication. The answer's original query, earlier object and
evidence read sets, and captured answer-provider configurations remain checked
through the gap readings and at the final commit boundary.

Structural capture reads scope and associations from data descriptors, then owns
the selected records without invoking getters, iterators, array species or JSON
hooks. Hidden selected data fields remain visible to projection and privacy
preflight; unsupported arrays are refused. Foreign records do not enter this
capture. Fresh generated source URI minimization carries the existing opaque
source/extraction provenance proof across snapshots. Copied or reopened records
without that proof retain ordinary URI privacy checks.

Projection/preflight of gap meaning is deferred until a gap read is selected.
A verified sufficient answer and a structurally forbidden default-space
no-match do not need a gap judgment or fail because unused historical gap
meaning exceeds its reading budget. Broad answers may use evidence across
multiple HA installations; the inherited `concreteAnswerGapSpaceId` picks a
concrete context, but a required gap pass holds if the selected sources/subjects
do not all belong to that exact space. It never silently associates records
across installations. Supported same-space multi-subject context is order
independent. Within a selected pass, all same-space
candidate meanings are projected and privacy-checked before candidate/byte
limits or the first gap request. Only locally resolved structural IDs receive
request-local references. Unknown references retain privacy checks and hold;
semantic content is never exempted merely because it resembles an ID.
The local reference map binds the actual current stored record, so a caller's
field named `id`, an unresolved key or a mismatched record copy cannot gain an
exemption. That local identity rule is distinct from generated URI provenance:
only an existing producer proof can omit a protected-shaped URI from meaning.

The plan captures immutable local records and settled readings. It uses the
existing `applyPreparedIngest` all-or-none graph seam with empty source and
extraction writes and a branded observed `research-task` node. All node, edge
and issue preparation settles before a final synchronous read-set check and
SQL SAVEPOINT commit/cache publication. `KnowledgeStore.batch` is not treated
as rollback. No new public store capability, tool, observation authority or
operator-review authority is introduced.

Existing metadata, accepted sources, promoted counts, repair schedules and
provenance are retained; ordinary source associations may be added only for an
active unreviewed gap. Repaired, cancelled, closed, suppressed, inapplicable,
stale/draft or operator-reviewed matches are returned read-only, including
edges and issues. Public answer results exclude terminal work from actionable
`gaps`, so ordinary answer composition cannot automatically reopen it. An
explicitly reopened issue remains distinguishable from its prior task history.
Its trusted review timestamp must strictly follow a matching terminal task's
last update to supersede that task. A later cancellation, an equal timestamp or
missing lifecycle evidence still blocks returned repair work.
An equivalent gap with an active queued, searching, evaluating, extracting or applying
task is also returned without writes, so re-observation cannot invalidate the
gap snapshot owned by an in-flight repair. The existing answer service can
still wait for that repair and read its resulting evidence.

## Bounds and evidence

The selected pass permits at most 50 stored gap candidates, 160,000 projected
characters and 8,000,000 cumulative request bytes, including declarations and
per-request overhead. It uses the original answer deadline (15 seconds by
default, at most 60 seconds). A local deadline/abort race stops readers that
ignore cancellation; each continuation checks again before another request or
write. Malformed, unavailable, uncertain, ambiguous, aborted, stale and
oversized passes authorize no writes.

Deterministic proof is in `knowledge-answer-gap-plan.test.ts` and
`knowledge-answer-gap-integration.test.ts`, alongside the existing answer
quality, object, excerpt and semantic-answer suites. The tests cover actual
matched-insufficient/no-match callers, port-count versus HDR and runtime versus
replacement distinctions, genuine paraphrases, Unicode, exact spaces,
reordered multi-subject context, opaque local IDs, terminal/legacy identity,
full candidate/absent-target races, late protected content, unchanged caches
and reopened SQLite, prior query/extraction/provider changes, and ignored
abort/deadlines. Mixed settled/held candidates, cancellation after graph
preparation and an injected late issue SQL failure prove the all-or-none write
barrier. Actual generated URI ingestion and copied/unknown-origin privacy
cases are covered in `knowledge-source-structural-references.test.ts`.
Fixture answers are authored plumbing outcomes, not a semantic
accuracy evaluator.

Live semantic calibration remains THE35. Combined final-main/product CI remains
THE34. Shared search/quality/enrichment/Home Graph fallback, repair scheduling
and legacy email-session behavior are not changed by this slice.
