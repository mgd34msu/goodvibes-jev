# Home Graph triage readings and automatic authority (THE-29)

## Scope

`home-graph/triage.ts` now reads applicability through registered closed-choice judgment, and separately verifies each fixed proposed battery/manual fact. It no longer parses self-reported JSON confidence or calls the explicit operator-review facade. The remaining Home Graph quality-issue generation, passport completeness, linking, and search decisions are separate inventoried work; this slice does not declare K5 complete.

The content-generation provider is not needed for these decisions. The public service/daemon triage options remain compatible. `minConfidence` is an owner rejection floor expressed as a probability times 100; it cannot lower the registered high-stakes band. `reviewer` and `chunkSize` remain compatibility inputs, not authority or unbounded execution controls. An action to seek review must itself be settled; an uncertain/unavailable reading is a hold, not a cached recommendation.

## Reading and privacy boundary

- Three registered/versioned batteries: applicability (`reject`/`review`), exact batteryPowered=false and batteryType=none support, and exact manualRequired=false support
- Actual provider probability/model/optional decision IDs are retained; no local confidence estimate or fabricated provider evidence
- Complete selected input preflight before any request, followed by detached deep-frozen input and request states
- Allowlisted subject identity/evidence only. Internal database IDs use local mappings and opaque `issue-N` references; timestamps, unrelated metadata and review receipts are omitted. Caller-controlled Home Assistant identity and semantic text remain subject to the ordinary input boundary
- No clipping before preflight; no whole-record serialization; no claim of universal unknown-secret or PII detection
- At most 100 selected issues, four concurrent readers, a whole-pass default 30-second deadline with a 60-second maximum; cancellation settles even when a port ignores its signal
- Cache keys bind the exact projected issue/subject/rule guidance, effective owner policy, battery versions, provider model and issue lifecycle. Cached recommendations are reused only for a matching configured/actual/requested model. Explicit operator review always takes precedence, even with `force`

## Application and commit point

The entire selected reading pass finishes before application. Any unsupported fact, uncertainty, malformed response, protected input, provider failure or cancellation before application writes no node, issue, cache or revision. Detached issue snapshots are captured before the first awaited reading; node snapshots are already frozen by the store. All are checked again at the commit point.

`KnowledgeStore.applyGuardedNodeIssueWrites` is a bounded ordinary-producer seam for up to 100 distinct existing nodes and issues. It accepts no operator mutation capability. It uses the same node authority and issue lifecycle normalization as ordinary writes. Issues are normalized against an overlay of prepared nodes, preserving sequential reference-space inference. Producer review-shaped metadata still grants no authority.

After awaited initialization and full normalization, one synchronous guard checks current state and cancellation. A SQLite savepoint then writes all node rows, revision rows and issue rows without an await or user callback. A SQL failure rolls back the complete set, and caches/revision arrays change only after release. The ordinary final store save follows. This is a logical SQL/cache commit boundary, not a new guarantee about crash-safe filesystem persistence; disk-save errors propagate rather than masquerading as a held/no-write result. Cancellation arriving after the synchronous commit point reports the fully committed result.

Automatic provenance is labelled `automatic-judgment`; it never supplies `review`, `reviewedFacts`, operator `reviewProvenance` or `suppression`. Whole selected passes preserve later node edits, operator accept/reject/revise, issue resolve/reopen, and same-lifecycle terminal decisions. Trusted explicit review paths remain functional after an automatic decision. Facts for multiple issues on one subject are combined before writing.

## Deterministic verification

Synthetic fake-port and temporary SQLite tests cover:

- Separate fact support, contrary evidence, uncertainty, unavailable/malformed providers, confidence scale/boundaries and stricter owner floors
- Full late protected content, accessor rejection without execution, cancellation and ignored-signal timeout
- Automatic versus operator provenance; no arbitrary facts from custom issue codes; no generation-provider dependency
- Family/space isolation, exact local identity retention and minimal remote projection
- Stale snapshots, mutable retained issue references, explicit reviews/reopens during reading and at write entry
- Whole-pass later holds, SQL failure rollback including persisted rows/revisions, cancellation before and after the commit point
- Cache invalidation by relevant facts, owner guidance/policy and provider, plus bounded selection independent of unselected malformed records
- Ordinary batch reference-space inference and denial of forged review metadata

Live endpoint calibration and full cross-product parity remain unverified. No remote publication is part of this local change.
