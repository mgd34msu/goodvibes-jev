# THE-27: answer fidelity, sufficiency and selection

## Implemented boundary

Provider generation uses `completeText` for content only. It cannot supply answer confidence, accepted citations, repair gaps or quality decisions. The real judgment port remains the typed discriminative `noul`/choice/score API; no free-text Jev operation is invented.

Three versioned registered batteries separately read candidate fidelity plus completeness, evidence sufficiency, and preference among supported, equally complete candidates. Fidelity includes both the text and meaningful claims from the factual records returned alongside it, including exact subject descriptions and target hints. A settled contradicted/unsupported candidate is excluded. Any uncertainty, missing/failing port, malformed response, cancellation, expired budget or stale read set holds instead of authorizing an unchecked fallback. No supported candidate yields an honest unverified answer with no returned facts.

A literal candidate preserves facts and selected extraction excerpts. It does not infer features with topic lists, regexes or domain-specific family counts. Its bounded display announces truncation; the full actual extraction still enters verification. A literal candidate must pass the same fidelity and completeness readings, including when provider generation is not configured. Only a supported candidate with actual evidence and complete query coverage is reported verified.

Public answer confidence is the supported fidelity probability multiplied by 100 and rounded. No retrieval points, fact counts, source authority, self-reported confidence or synthetic minimum contributes. `includeConfidence:false` hides only that display and cannot alter gap/repair decisions. Foreground repair consumes settled insufficiency/no-evidence state; successful repair consumes the verified quality outcome, rather than comparing confidence to 50.

## Evidence, provenance and privacy

Actual in-space stored extraction text, not source summaries or titles, is the truth basis. The projection excludes generated sources and arbitrary metadata. Complete selected evidence and returned-fact claims receive protected-input preflight before generation; all concrete candidates receive preflight before any quality request. No protected suffix is silently clipped away to make a request eligible. Scope filtering precedes transmission.

Each supplied source receives an opaque `evidence-N` reference. Citation markers must exactly bind to these labels, including markers inside returned fact claims. Original source/extraction identities remain local and are returned as citation provenance, not sent to the judgment port. Actual provider decision IDs are retained only when supplied.

Exact original source, extraction, fact, subject and relevant edge snapshots remain local. Derived response aliases/metadata are not mistaken for stored records. Reads of absent answer-gap nodes and issues are watched too. Changes while generation or verification waits invalidate the pre-write pass, preserving operator state. The no-match path also snapshots scoped retrieval records so late indexing cannot authorize a stale absence gap.

One bounded answer operation covers retrieval, generation and verification. Optional signals reach source/fact readers, provider generation and quality requests. Deadline/abort races stop an ignored-signal operation from keeping the public answer pending; continuation checks prevent later judgment requests and repair writes after release. A model/provider operation already in flight cannot be forcibly terminated if it ignores its signal. Service refinement receives the caller's cancellation signal and checks it before further scheduling; its existing repair-driver timing and lifecycle remain distinct from the answer verification budget.

## Gap writes and limits

Only a settled evidence-insufficiency reading stages an evidence gap. A missing extraction or structural no-match may separately stage an observed availability gap. Unsupported generation with sufficient evidence does not invent a missing-evidence gap. Uncertainty and unavailability never imply insufficiency and write no gaps.

The pre-write barrier rechecks exact state and cancellation before gap persistence. `store.batch` batches saves; it is not a rollback transaction. This implementation does not claim cross-operation atomicity or whole-driver rollback. Trusted node/issue terminal-state protections remain authoritative.

Budgets: at most 24 evidence rows, two answer candidates, 160,000 projected characters, 16,000 characters per candidate, default 15-second total answer budget and maximum 60 seconds. The literal display is capped at 14,000 characters with a notice; full evidence is not clipped. Retrieval's existing bounded window, lexical alias/object-scope semantics, and source/fact ranking contracts are not claimed fully converted here.

## Verification

Offline fake readings are explicitly labelled per scenario; they establish plumbing and safety, not model accuracy. The tests cover sparse complete versus numerous irrelevant facts, partial/conflicting evidence, unsupported generation, exact citations, subject metadata, stale source/operator/extraction state, protected late input, missing extraction, missing/failing/uncertain/malformed readers, literal generation absence, immutable read sets, ignored-signal deadlines and confidence-independent repair decisions. Existing source/repair subject and lifecycle assertions are retained with explicit synthetic extraction/readings. Old self-authored gap and regex-cleanup expectations are deliberately replaced with measured outcomes or a genuinely authored concise candidate, never a production compatibility heuristic.

Offline knowledge/Home Graph regression: 511 tests, 3,079 assertions, 55 files passed, including compiled-route cases. The normal commit gates require full build, solution/test/type-test compilation and API-snapshot checks; exact commit-level results are recorded in the completion report. No live requests or calibration were run.

Remaining scope: live fixture calibration, generated entity/relation/freeform-wiki fidelity, broader K1 authority/taint and repair coverage, remaining K3 retrieval semantics, K5 Home Graph policy, and full product parity. THE-27 is not completion of those workstreams.
