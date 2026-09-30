# Knowledge node review authority (THE-24)

This is the deterministic operator-authority part of K1. It covers the node
persistence boundary, not generated-claim support (THE-23), issue lifecycle or
repair cancellation (THE-25), or the remaining confidence-based activation gate.
Inventory references: `docs/inventory/engine.md` rows for `store.ts`,
`store-node-history.ts`, `service-node-admin.ts`, `review.ts` and Home Graph review.

## Authority boundary

- Ordinary `KnowledgeStore.upsertNode` calls cannot establish, remove or replace
  `metadata.review`, `reviewProvenance`, `reviewedFacts`, or `operatorReview`.
  `generatedFactSupport` remains producer evidence, never operator authority.
- Full-node operator acceptance/rejection protects the complete effective claim,
  identity, status, confidence, source binding and ordinary metadata. A conflicting
  producer write throws `KnowledgeNodeMutationHeldError('operator-reviewed')`
  before changing the row, cache or revision history. It does not replace accepted
  content with a draft or revive a rejected node. Idempotent writes preserve the
  original review exactly.
- Explicit node review, issue correction and Home Graph review mint an in-process
  `createKnowledgeNodeOperatorMutation` capability. A WeakSet authenticates its
  identity; JSON, spreads, serialized copies and review-shaped metadata cannot
  mint one. The second store argument is not read from an input body or metadata.
- A capability freezes the exact current record snapshot and the operator's
  correction values/scope. The write rechecks that snapshot after `init()` and
  before mutation. Stale content, changed operator decisions or deleted targets
  hold. Each review also has a unique revision ID, so reject/accept cycles in
  the same millisecond cannot revive a stale capability. Explicit accept/reject can reverse prior decisions; explicit revision or
  trusted replacement gets a fresh review and preserves prior content in history.
- New and reloaded node records are detached, deeply frozen JSON snapshots.
  Nested caller metadata, returned records and list/get references cannot mutate
  the live cache or an authority receipt outside the write boundary.
- `replaceNodeRecord` is also guarded. Unreviewed compensation retains its exact
  replacement behavior, but cannot erase a concurrent review or forge one.
  An explicit trusted replacement records a revision and uses current timestamps.

## Partial corrections

An issue correction is not necessarily approval of an entire node. Home Graph
battery corrections, for example, must survive a later snapshot's new source ID
without freezing unrelated device refreshes. Trusted `revise` calls may carry
exact field corrections derived from validated operator input. These receipts
name only the reviewed fields and values, and preserve subject/space identity.
Ordinary writes may refresh unrelated data but cannot change reviewed values or
expand the review scope. Later explicit corrections can change those values.
A partial correction cannot weaken an existing full-node review. Its capability
also refuses changes outside the confirmed field set.

The existing Home Graph issue-review durability test remains unchanged. Node
accept/reject still applies to the whole node; rejecting a quality issue with a
correction does not reject the corrected node. Accepting an issue also retains
the current node status (including draft); only the explicit node-accept path
confers full-node acceptance. The old issue-accept confidence=100 effect remains
separately bound in the capability and does not grant review authority over
confidence or over unreviewed fields. An issue update with no applied node fields
gets no blanket review authority.

## Public callers and compatibility

The real Home Graph HTTP import route accepts arbitrary JSON record metadata and
uses ordinary upserts. Tests exercise that route through the real service/store:
review-shaped JSON cannot mint authority, a later import cannot override rejection,
non-admin review is refused, malformed review actions are refused, and explicit
admin accept/reject/correction works. The ordinary in-process graph API exposes
explicit review, but no upsert mutation-context field. The capability factory is
an SDK function for trusted in-process callers, not a daemon/tool/MCP JSON method.
This is an integrity boundary against untrusted producer data, not a sandbox for
arbitrary code already executing inside the SDK process.

Stored legacy review receipts remain conservatively protected without a bulk
migration. Existing manual/user-authored active records without a review remain
active and retain their provenance. Existing numeric confidence behavior is
unchanged, including the NaN-to-default auto-accept expectation in
`knowledge-wiki-honesty.test.ts`. That automatic confidence policy remains a
separate K1 judgment task; it never supplies operator authority here.

## Preflight and verification

`store.assertNodeMutation(input)` is an ordinary, read-only preflight using exactly
the final upsert's candidate normalization, metadata merge, confidence and scope
inference. It does not accept a trusted context. Actual upserts recheck independently.
The private candidate builder is shared, so producer plans need not copy defaults.

`resolveKnowledgeNodeOperatorMutation` is also a synchronous, read-only resolver over
a fully normalized candidate and the current record; ordinary planners pass an
undefined capability. `mergeKnowledgeNodeMetadata` removes untrusted review fields
before constructing that candidate. The resolver may be used to preflight a whole
plan, but final writes independently revalidate. It is not itself a transaction
for a multi-node producer pass.

`knowledge-node-authority.test.ts` uses temporary real SQLite stores and reloads.
It covers forged metadata, JSON capability impersonation, mutable references,
reviewed-content/status changes, rejection regeneration, exact stale snapshots,
replacement/compensation, legacy records, partial-field scope/value binding,
explicit node/issue/Home Graph review and the public HTTP import/review paths.
No live judgment or network calls are used; HTTP error formatting uses a test port.

## Atomic node merge follow-up (THE-40)

`mergeNodes` prepares the loser's complete stale/mergedInto mutation through the
ordinary node gate before touching any edges. Full operator reviews therefore
hold the whole merge; a field-only correction keeps its exact scope and values.
After preparation, the loser, winner and captured edge set are revalidated. A
concurrent review or edge edit causes a stale hold and remains intact. No merge
operation creates an operator capability or transfers the winner's review.

Repointed/deduplicated edges, the merged_into marker, the stale loser and its
revision commit in one synchronous SQL savepoint. A SQL mutation failure rolls
back the entire plan; node, edge and revision caches publish only after release.
Successful merges then use SQLiteStore's ordinary save contract, including
outer batch-save deferral. This does not turn asynchronous batches into global
transactions or promise rollback of filesystem I/O failures after SQL commit.
Repeated completed merges with no new incident edges preserve timestamps and
revision history.

`knowledge-node-merge-atomicity.test.ts` uses real temporary SQLite databases and
reopens them after operator/stale holds, successful merges and SQL abort triggers
at marker, node and revision writes. A second save/reopen proves rejected writes
were also rolled back in SQLite memory. Tests cover cache visibility during SQL
commit, deduplication/self-loops, review provenance, repeated calls and retaining
unrelated successful work in an outer save batch. No live provider calls occur.
