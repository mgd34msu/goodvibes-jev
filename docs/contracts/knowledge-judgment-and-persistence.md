# Knowledge judgment and persistence

This contract describes semantic reading, privacy, provenance, serving authority and persistence boundaries for the knowledge engine. Runtime code, API shapes and data authority remain owned by their implementations. Historical progress, source pins and verification totals are preserved in [the existing Linear record](https://linear.app/the-artificery/issue/TA-13/complete-remaining-engine-judgments-and-shared-hoists).

A settled semantic reading is distinct from structural eligibility, operator permission, runtime provenance and a completed database commit. Probability values retain their declared units. Work/transport caps bound execution and never substitute for meaning. Complete consumed semantic content must pass protected-input checks before clipping, serialization or transmission. These checks are conservative and are not universal PII/unknown-secret detection or permission to transmit data.

The regression scenarios below are validation requirements and locations for inspection, not a report of a new test run. Synthetic readings prove plumbing and safety only. Genuine provider accuracy, classification, calibration and latency require separately recorded live qualification; no live accuracy is asserted here.

## Reading this contract

- [Extraction](#extraction-readability-and-document-projection), [aliases](#structured-entity-aliases) and [compilation](#atomic-ingestion-and-compilation) define preparation before publication.
- [Operator authority](#operator-node-authority), [serving](#node-serving-and-observation-authority), [provenance](#source-and-extraction-provenance) and [fact support](#generated-fact-support) define write boundaries. [Runtime receipts](#generated-fact-runtime-receipts) keep their distinct schema.
- [Relevance](#answer-relevance-and-source-quality), [objects](#answer-linked-objects-and-integration-intent), [Home Graph](#home-graph-semantic-retrieval), [public retrieval](#public-search-and-prepared-packets) and [answer quality](#answer-fidelity-sufficiency-and-confidence) define selection.
- [Gaps](#answer-gap-admission-equivalence-and-persistence), [repair](#repair-profiles), [triage](#home-graph-triage), [passports](#home-graph-quality-and-passports), [consolidation](#consolidation-into-durable-memory) and [terminal lifecycles](#terminal-tasks-and-issue-lifecycles) define dependent writes.
- Validation sections retain adversarial, race, provenance, failure and compatibility scenarios.

## Extraction readability and document projection

Implementation: [extraction-policy.ts](../../packages/engine/sdk/src/platform/knowledge/extraction-policy.ts), [prepared-extraction.ts](../../packages/engine/sdk/src/platform/knowledge/prepared-extraction.ts), [pdf-extractor.ts](../../packages/engine/sdk/src/platform/knowledge/pdf-extractor.ts), [html-content-selection.ts](../../packages/engine/sdk/src/platform/knowledge/html-content-selection.ts), [extraction/judgment-registry.ts](../../packages/engine/sdk/src/platform/knowledge/extraction/judgment-registry.ts).

Document extraction uses four registered batteries:

- `engine.knowledge.extraction-readability`: readable document text, including non-ASCII text, short labels, tables, URLs and prose about PDF syntax
- `engine.knowledge.pdf-text-decoding`: unmarked single-byte versus UTF-16BE decoding, neither readable, or unknown
- `engine.knowledge.html-main-content`: main document blocks, including tables, with a recorded reading for each structurally parsed block
- `engine.knowledge.html-document-title`: title metadata/headings, including none, with an independent fitness check

The extraction registry lives in `knowledge/extraction/judgment-registry.ts` and participates in registry auto-discovery. Synthetic fixtures establish wiring and hold behavior, not live model accuracy or calibration.

Removed decisions: the four binary character-ratio thresholds, the minimum
sample-length exception, PDF-token rejection, the PDF 55% ASCII fraction, the
hex-string two-byte text floor, and the zero-byte encoding guess. The exported
`looksBinaryLikeText` and `looksLikeRawPdfPayload` compatibility names return
asynchronous readings of the same readability battery; they do not retain the
old heuristics. The old threshold constants are no longer public exports.

Version, blank-field, owned-placeholder, PDF grammar, BOM, odd-hex-length,
resource cleanup, deduplication, and output-size checks remain code. Extractor
generation is 3, so older retained captures can be re-extracted. The 4096
character judgment sample is a transport budget, not a readability threshold.
Full candidate content is preflighted with `assertJudgmentInput` before sampling
or port access. Database ids/timestamps are not part of the readability request.

Uncertain, confirmation-only, missing, failed, malformed, or unrecorded judgments
throw a value-free hold. PDF parser fallback does not swallow these holds.
Home Graph ingestion prepares an extraction before publishing its source, and
its extraction wrapper propagates holds instead of converting them into a
missing extraction and continuing graph writes. Async decisions are awaited in
Home Graph search, repair selection, reindex, service calls, and ingest recompiles.

Regular URL and artifact ingestion reserve a source identity without writing it,
then extract and judge before creating or replacing a pending source. Finalize
accepts a one-shot prepared token tied to that exact source id, artifact id and
content hash. Preparation verifies the retained bytes against their SHA-256;
consumption checks the current artifact fingerprint, rejects unrecognized,
mismatched or already-consumed tokens, and keeps the actual result private to
the preparation module. No result from another source/artifact can be reused.

Both the optional DOM parser and the lightweight parser feed the same named
block-selection and title-selection decisions. Mozilla density/keyword article
selection and first-heading title preference are removed. HTML grammar still
supplies blocks, headings, links and explicit author/site metadata. The existing
page-content pattern packs bounded requests; every block must have an actionable
reading before any content is accepted. Title choices use bounded selection
rounds plus the foundation's separate fitness check.

A definite no-content result produces an owned empty-extraction marker. A
confident no-title result leaves the title absent. Neither result falls back to
page boilerplate or the first heading. Unknown, missing and failed readings
propagate through artifact dispatch and both regular and Home Graph ingestion.
The full raw input and decoded block/title candidates are preflighted before
request clipping. The optional DOM parser can still be absent: the compiled
optional-dependency fixture exercises the lightweight parser with the same
strict judgments, without copying or removing installed dependencies.

DOM loading, grammar, deduplication, resource cleanup and caps remain deterministic code.

Parser dispatch, format grammar, display prefixes, output caps and parser-failure warnings remain deterministic. Input/record presence, connector identifiers, refresh limits/status and HTTP scheme checks remain structural. Ordinary parser/fetch failures retain their failed-record path; judgment holds preserve new-source absence and prior indexed records. Home Graph extraction-quality is the awaited inverse of readability, and its extraction wrapper preserves the no-write hold boundary.

Refresh and search-text preflight project every complete `searchText`, `text`
and `content` candidate from both structure and metadata, plus excerpt, summary
and sections. Unrelated metadata such as `retrievedAt` never enters the privacy
scan or judgment request. Property descriptors are inspected before reading any
consumed field: accessors are refused without execution, and non-enumerable data
candidates (including section entries) are still checked before the first reading.

## Structured entity aliases

Implementation: [entity-aliases.ts](../../packages/engine/sdk/src/platform/knowledge/entity-aliases.ts), [ingest-compile.ts](../../packages/engine/sdk/src/platform/knowledge/ingest-compile.ts), [batteries/entity-alias.ts](../../packages/engine/sdk/src/platform/knowledge/batteries/entity-alias.ts).

`engine.knowledge.entity-alias`, version 1, is a registered yes/no battery with labelled synthetic fixtures. Each candidate requires an actionable yes for the particular entity. Matching words, token frequency, minimum word length, stopwords and popularity do not establish aliases.

Structured entity discovery remains deterministic: exact supported tag prefixes, metadata keys, repository-source title rule, eight-values-per-kind cap, original node kind/title/slug, source relationships and provenance remain intact. Judgment cannot invent identifiers. Domain, topic, folder, section and URL relationships retain their structural rules.

- The only judgment data is the entity kind/title, a lexical candidate, and a
  bounded sample of the existing source title/summary and extraction summary/sections
- All complete prospective text, all participating entity identities, joined
  evidence and every complete request are checked by `assertJudgmentInput` before
  the first request; the original text is checked before any transport clipping
- Unrelated metadata, credential fields, source provenance and artifact bytes are
  neither sampled nor forwarded
- Word boundaries nominate candidates in document order with exact spelling,
  including one-character words and non-Latin names. There is no frequency sort,
  stopword list, semantic token-length floor, or heuristic fallback
- At most 16 candidate words per entity, 128 requests per compile, 4,096 evidence
  characters per request, and four retained aliases per entity. Candidate capacity
  is shared equally across the entity count. Words over 128 characters are outside
  the transport budget, and names over 512 characters explicitly hold rather than
  sending an altered entity identity. A word crossing the evidence boundary is
  never synthesized into a truncated candidate
- These limits bound work and transport. They do not assert which candidate is
  semantically an alias; each retained alias still needs its own actionable reading

### Mutation and holds

Alias preparation finishes before `compileKnowledgeSource` writes any graph
nodes or edges, and before the standalone structured-entity compiler writes any
entities. A missing/unavailable port, malformed response, uncertain result or
confirmation-band result throws a value-free `KnowledgeEntityAliasHoldError`.
There is no partial alias result or old-keyword fallback, and existing graph
records are untouched by a held compile. An empty candidate set needs no reading.

Ordinary artifact/URL ingestion stages source and extraction before alias preparation. Operational fetch/parser failures produce failed source records. This alias contract does not reinterpret other `topKeywords` consumers.

## Atomic ingestion and compilation

Implementation: [ingest-inputs.ts](../../packages/engine/sdk/src/platform/knowledge/ingest-inputs.ts), [ingest-compile.ts](../../packages/engine/sdk/src/platform/knowledge/ingest-compile.ts), [ingest-preparation.ts](../../packages/engine/sdk/src/platform/knowledge/ingest-preparation.ts), [store-import.ts](../../packages/engine/sdk/src/platform/knowledge/store-import.ts).

The source's pending representation is a detached local draft. Extraction
still runs against retained artifact bytes. Finalization prepares the complete
alias batch from the proposed title, extraction summary/sections, exact structured
entity identifiers, and merged metadata before any source or extraction write.
Successful compilation consumes that prepared alias result without judging it a
second time. Structured project/capability nodes can also require activation
readings or reject a change to operator-reviewed content. These dependencies
prepare against the exact proposed source/extraction before any source or graph
write. A shared synchronous SQL savepoint publishes the prepared source,
extraction, graph, and revision records together; in-memory state changes only
after the SQL writes succeed. Alias, activation, and reviewed-node holds escape
the ordinary failure handler without publishing a failed replacement.

### Freshness and cancellation

Preparation binds the retained source and extraction, including the canonical URI
reservation. Changes during extraction or alias reading hold before publication.
Finalization rechecks the artifact fingerprint. Alias readings also bind the
installed port and model; an optional ingest signal can interrupt a provider that
does not itself honor cancellation. No partial aliases or heuristic fallback are
published. Input snapshots prevent caller mutation from changing the proposed
content while its readings are pending.

Operational fetch and parser failures retain the existing failed-source path.
Catalog projections still use their genuine observed-record capabilities. Their
precommit guard checks the original retained state; the committed observation
checks actual live source/extraction records against the staged evidence. Copied
JSON gains no observation authority. The ordinary import and standalone compile
contracts keep their existing judgment policy.

The staged boundary covers `ingestKnowledgeArtifact`, `ingestKnowledgeUrl`, `finalizeKnowledgeIngestedSource`, standalone source compilation, structured-entity compilation and recompilation/refresh.

## Standalone compilation and refresh

Implementation: [ingest-compile.ts](../../packages/engine/sdk/src/platform/knowledge/ingest-compile.ts), [store-import.ts](../../packages/engine/sdk/src/platform/knowledge/store-import.ts).

Standalone source compilation, structured-entity compilation and recompilation collect their complete graph and use `applyPreparedIngest`. Recompilation obtains a genuine one-shot prepared extraction from the retained artifact and stages the exact normalized extraction beside its graph. Alias and serving judgments read proposed extraction evidence while retained source, extraction, graph and revisions stay unchanged. Late SQL failure rolls back the savepoint before cache publication. There is no sequential writer fallback.

Caller source and extraction inputs are detached before the first await. They
must match retained evidence before catalog observation authority is prepared.
Source, extraction, canonical URI, artifact, alias port/model and node authority
checks remain live through the last commit guard. An additive optional
signal-only argument cancels alias, extraction-freshness and extraction-preparation
waits and reaches the staged activation/commit checks. An abandoned extraction
reader may finish, but cannot publish anything. Cancellation is not converted
into an operational failed-source record.

Catalog observations retain their genuine in-process capabilities and live
evidence checks; copied JSON still gains none. Structured nodes retain the
ordinary serving judgment, concrete-space evidence checks, provenance and
operator-review authority. Successful replay preserves node identities and
revisions. Compile completion events fire after successful publication only.
Operational artifact read and parser errors retain their existing rejection
behavior. No fetch/parser selection rules, generic transaction implementation,
or unrelated caller families are changed.

The shared helper's existing contract remains: synchronous SQL and cache
publication are atomic against preparation holds and SQL errors. Its subsequent
filesystem save is a separate durability boundary; this repair does not claim
rollback for a filesystem save failure or cross-store transactions.

## Operator node authority

Implementation: [store-node-authority.ts](../../packages/engine/sdk/src/platform/knowledge/store-node-authority.ts), [store-node-history.ts](../../packages/engine/sdk/src/platform/knowledge/store-node-history.ts), [service-node-admin.ts](../../packages/engine/sdk/src/platform/knowledge/service-node-admin.ts).

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

An issue correction is not necessarily approval of an entire node. Home Graph
battery corrections, for example, must survive a later snapshot's new source ID
without freezing unrelated device refreshes. Trusted `revise` calls may carry
exact field corrections derived from validated operator input. These receipts
name only the reviewed fields and values, and preserve subject/space identity.
Ordinary writes may refresh unrelated data but cannot change reviewed values or
expand the review scope. Later explicit corrections can change those values.
A partial correction cannot weaken an existing full-node review. Its capability
also refuses changes outside the confirmed field set.

Node
accept/reject still applies to the whole node; rejecting a quality issue with a
correction does not reject the corrected node. Accepting an issue also retains
the current node status (including draft); only the explicit node-accept path
confers full-node acceptance. The old issue-accept confidence=100 effect remains
separately bound in the capability and does not grant review authority over
confidence or over unreviewed fields. An issue update with no applied node fields
gets no blanket review authority.

The real Home Graph HTTP import route accepts arbitrary JSON record metadata and
uses ordinary upserts. Tests exercise that route through the real service/store:
review-shaped JSON cannot mint authority, a later import cannot override rejection,
non-admin review is refused, malformed review actions are refused, and explicit
admin accept/reject/correction works. The ordinary in-process graph API exposes
explicit review, but no upsert mutation-context field. The capability factory is
an SDK function for trusted in-process callers, not a daemon/tool/MCP JSON method.
This is an integrity boundary against untrusted producer data, not a sandbox for
arbitrary code already executing inside the SDK process.

Stored legacy review receipts remain conservatively protected without bulk migration. Existing manual/user-authored active records without review retain their provenance. Operator authority is independent of numeric producer confidence; serving-without-review follows the activation contract below.

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

## Node serving and observation authority

Implementation: [store-node-activation.ts](../../packages/engine/sdk/src/platform/knowledge/store-node-activation.ts), [store-node-observation.ts](../../packages/engine/sdk/src/platform/knowledge/store-node-observation.ts), [activation/types.ts](../../packages/engine/sdk/src/platform/knowledge/activation/types.ts), [store-record-representation.ts](../../packages/engine/sdk/src/platform/knowledge/store-record-representation.ts), [store-import.ts](../../packages/engine/sdk/src/platform/knowledge/store-import.ts).

Store configuration, node history and serving decisions use the registered high-stakes yes/no battery `engine.knowledge.node-serving-without-review`. Its question concerns the entire proposed content and exact source evidence. Producer scores, explicit producer `active` status, reviewer names and serialized receipts cannot answer it.

There is no implicit numeric activation threshold. Missing and nonfinite producer confidence is descriptive zero; finite fractions remain on the declared 0-100 scale and are never multiplied by 100. A finite 0-100 `nodeAutoAcceptConfidence` supplied explicitly by the owner remains an additional one-way hold after a settled yes, not an acceptance rule or a probability. Invalid explicit settings fail configuration. The old exported default constant is compatibility-only and is never used by the store.

At least one actual independent extraction or genuine observation capsule is required. A known same-space reference without extraction stays explicitly unverified in the reading; another real extraction can support the entire claim. Unknown, foreign, stale or generated source references still hold. Per-source support-edge verification remains a separate generated-fact support obligation.

A settled act/yes can serve new synthesized content. No, uncertain, malformed, missing/unusable evidence, missing provider or provider failure cannot. New candidates can be retained as `draft` with pending-review provenance. A composed serving pass asks for `requireAccepted` and holds the entire node pass. Held replacements preserve the previous active record exactly and throw; they do not pretend the old record satisfies the new request. Changing served content while requesting draft/stale also holds rather than disguising replacement as a lifecycle transition. Ordinary stale transitions of unchanged content and lifecycle bookkeeping remain structural.

Legacy active records are not migrated or bulk-downgraded. An exact unchanged replay preserves the existing record. Nodes accepted by the new reader recheck their exact evidence/subject fingerprint before reusing that status; replacement content is read afresh. Full operator reviews still protect their entire content and decisions. Field corrections protect only their declared fields, never granting a whole-node approval or promoting a draft.

1. Explicit accept/reject/revise uses the existing in-process operator capability and exact current-node snapshot. Imported/copied review JSON cannot mint it.
2. Raw observations and structural projections use an internal WeakMap capability bound to a frozen producer input, current node and captured source. Permitted producers are enumerated below. They retain external origin and never claim an operator review or semantic endorsement.
3. Ordinary synthesized content requires the registered serving judgment. Its audit receipt is data, not a capability.

Privileged structural producers are deliberately narrow:

- Ingest compiler: URI hostname, bookmark-folder path, literal source tag and extracted section-heading catalog nodes. Semantically inferred entity hints are not privileged
- Memory sync: exact existing memory-record mirror and its literal tag catalog
- Browser history: exact captured browser/profile identity catalog
- Home Assistant snapshot sync: normalized raw home, entity, device, area, automation, script, scene, label and integration observations. Arbitrary graph imports do not use this path
- Generated passport: the structural device-page index (fixed label and bookkeeping) after its fact preparation has settled. Rendered knowledge still uses accepted facts
- Answer/intrinsic/enrichment gaps and gap lifecycle updates: research-task bookkeeping. This does not make a question or its reason factual answer evidence

Each origin has a narrow allowed-kind check in addition to the nonforgeable producer capability. There is no kind-wide, caller-name, metadata-origin or receipt-JSON exemption. The public tool/import paths only reach ordinary storage unless they invoke an established explicit review operation.

Raw-observation evidence capsules are in-process and bound to the actual mapped record/source. A later synthesized field can be judged against that actual observation without pretending an extraction exists. Unknown imported lookalikes cannot supply it. After restart, a changed observation with no independent extraction holds as `observation-revalidation`; a real snapshot resync restores the path. Research-task and generated-page-index records are not independent factual evidence. Origin metadata is retained through explicit field correction but is never reconstructed into a capability.

`KnowledgeStore.prepareNodeWrites`, `assertPreparedNodeWrites` and `upsertPreparedNode` implement a whole-pass preparation barrier. The token is backed by a private WeakMap, is scoped to the store's private backing-state identity, and is one-use per slot. Separate stores and copied JSON fail. Legitimate facade objects sharing the same actual store state remain usable.

All selected semantic input is preflighted before the first request. Candidate projection includes all fields consumed by current serving paths, complete markdown and established extraction text paths. No source clipping, arbitrary metadata dump, timestamps or raw database IDs is sent. Exact existing/proposed subject IDs become local labels; unknown-origin hint IDs retain normal protected-input inspection. Original IDs and complete source/extraction/operator snapshots remain in local provenance and read sets. New receipt keys are excluded from legacy content-shape/scope classification and text search.

Limits are 320 nodes, 32 sources per candidate, 2 MB of total request state/questions plus protocol allowance, 8 MB of local read-set snapshots, four concurrent calls, 15 seconds by default and at most 30 seconds for the complete reading pass. Plain snapshots reject accessors, cycles, sparse arrays, excessive depth and oversized trees. Cancellation and total timeout settle even if a fake/custom port ignores its signal. Candidate, request and read-set snapshots are detached and immutable. No probabilities are inflated.

Unique kind/slug identity is checked both during preparation and at the actual write, including insert, replacement and guarded batches. A new explicit ID cannot make SQLite INSERT OR REPLACE delete a reviewed row behind the ID-based authority guard. Generated producers disambiguate only colliding human-readable slugs with their own stable identity; existing records are not migrated or overwritten. Tests verify the protected row, cache, revision history, database bytes and reopened store.

The final write guard checks current nodes, sources, extractions, referenced subjects, the installed port identity/model, cancellation and a 30-second prepared-write freshness bound after all awaits. Guarded node/issue commits and guarded issue replacement retain synchronous SQL/cache commit sections. There is no awaited model call inside either commit.

Enrichment, supported attachment writes, primary repair-profile writes and supersession consume a prepared pass instead of rereading at each write. Proposed passport facts must settle activation before virtual active facts enter rendering. Answer evidence/ranking/returned facts, generated-page targets, Home Graph search and generated-page rendering exclude drafts. Administrative review views retain draft visibility.

Home Graph import preflights all selected candidate/evidence projections, stages normalized source/extraction records, and completes every node judgment before its first visible write. It rechecks source, extraction, node, issue, edge and operator state after the reads, then commits rows and revisions in a synchronous SQLite savepoint and publishes caches only after release. A failed reading or SQL write leaves the selected import unchanged, including after close/reopen. Ordinary source/extraction/edge upserts share the staging normalization.

Import never mints observation/operator authority. Changed staged evidence invalidates retained observations on selected imported nodes, including source-less observations whose hidden dependencies cannot be proven unchanged. An unchanged node title cannot bypass that rereading requirement. Such imports can hold when independent extracted evidence is missing; they do not borrow an old raw observation to preserve apparent success. A settled replacement drops the stale observation receipt, while genuine fresh producer capabilities may bind new evidence and explicit operator decisions remain protected. The internal staged-ingest callback preserves only original branded observation inputs, never copied observation-shaped JSON.

Compensation can reuse only an exact locally committed record backed by an opaque source/subject guard. It cannot reconstruct authority from copied receipt JSON, erase a newer operator decision or overwrite an untouched concurrent edit. This preserves exact prior passport/fact metadata and timestamps on a failed scoped refresh. The repository's broader async batches remain optimistic rather than globally serializable; each affected write rechecks its read set, and this contract does not promise to undo unrelated concurrent work.

Store-owned timestamps and review/decision stamps retain their owned raw representation and normalized public view. Equality and admission checks must use the store's record-representation boundary; serializing a public record does not recreate owned clocks or provenance. Clock ownership changes neither operator authority nor the requirement for fresh evidence.

## Fresh structural references

Implementation: [semantic/verification/structural-references.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/structural-references.ts), [semantic/primary-source-plan.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/primary-source-plan.ts).

The ordinary protected-input checker is unchanged. A private in-process WeakMap
capability identifies only structural IDs the current engine producer just
computed. The capability is neither a JSON flag nor an ID prefix/shape heuristic,
and is not exported from a public package entry point. Current call sites are:

- Repair-profile fact IDs just computed by semanticFactId
- Enrichment fact IDs just computed by semanticFactId
- Proposed enrichment entity IDs just computed by the engine, when used as
  subject references in those fact plans

Before requesting judgment, the complete selected DTO uses short claim/subject
labels, with matching target-hint cross-references. Exact original IDs, claim and
field hashes, source/extraction snapshots, subject hashes and receipts stay local.
The model sees the unchanged semantic identity descriptions and evidence. IDs are
never rewritten in persistence. Every projected payload still receives complete
protected-input preflight before the first port call; protected evidence, names,
values, source references, unregistered subjects and later inputs hold the whole
pass. A copied/serialized capability does not survive, and identity mutation after
registration holds. Request sharing includes original claim hashes so separate
claims cannot borrow another claim's provenance after opaque mapping.

No `sem-fact-`/`sem-entity-` prefix, generic `id` field or identifier shape proves trusted origin. The freshly generated claim/subject mechanism alone does not remap retained source/extraction or external semantic identifiers. Retained records need their own verified record-bound provenance; absent that proof, conservative privacy checks remain in force.

Primary-source planning constructs the declared `SemanticPrimaryClaim` and subject/hint DTO explicitly rather than serializing a full node record. It reads property descriptors without invoking accessors, omits unrelated metadata/timestamps, retains meaningful fields and preflights complete selected content before serialization or requests. Unknown hint shapes and consumed accessors hold. Protected semantic values and unproven IDs receive no exemption.

## Source and extraction provenance

Implementation: [source-structural-references.ts](../../packages/engine/sdk/src/platform/knowledge/source-structural-references.ts), [home-graph/extraction.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/extraction.ts).

Engine-generated IDs and local canonical URIs can contain a protected-shaped digit run; changing random fixture IDs must not hide this boundary.

The actual Home Graph ingestion and extraction producers retain in-process provenance for the exact source ID, derived extraction ID, and generated local canonical URI. This is an internal WeakMap capability, bound to the actual store, exact current record objects and complete source/extraction fingerprints. No prefix, metadata flag, serialized receipt or arbitrary imported JSON creates it. Unknown persisted-origin records after reload retain normal protected-input behavior; this bounded change does not introduce a migration or infer historical origin.



Generated-fact support uses request-local source/extraction labels. Activation and source-ranking projections omit only fields demonstrably generated as local URI references. External `url` and `sourceUri` values remain evidence and receive full protected-input preflight. Semantic source text, extraction text and candidate fields are never exempted. Exact original source/extraction IDs, canonical URI meaning, hashes and evidence references remain unchanged in local records and receipts.



Full-record freshness is checked when capturing and consuming proof. Wrong-store records, changed source origin, mismatched extraction source IDs, stale records, copied inputs/proofs and conflicting duplicate mappings cannot launder authority. Detached snapshots can be projected only with a genuine proof bound to their complete exact original record. Proofs only minimize structural references; they do not establish source credibility or grant operator/serving authority.



The reusable internal `knowledgeSourceJudgmentUris(source)` projection is for actual source records. Known generated-local references are omitted only while the exact producer record remains current. Copies and unknown records retain their original fields; changed known records hold. This lets other semantic collectors reuse the same boundary instead of guessing from URI prefixes.

## Generated fact support

Implementation: [semantic/verification/generated-fact-support.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/generated-fact-support.ts), [semantic/verification/projection.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/projection.ts), [semantic/verification/batteries.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/batteries.ts), [semantic/fact-support-write-plan.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/fact-support-write-plan.ts).

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
- All planned ordinary node mutations use the operator-authority contract's shared
  `store.assertNodeMutation` normalization/authority seam before the first
  affected mutation. Actual upserts recheck authority. A reviewed fact, entity,
  gap, wiki or superseded row holds the pass rather than allowing earlier writes.
  Typed authority holds cannot trigger semantic fallback promotion.

An optional cooperative `shouldStop` probe propagates through repair support,
prepared writes and enrichment so a lifecycle cancellation during generation or
reading cannot authorize late knowledge writes.

Source, extraction, node, edge and operator snapshots are checked at write entry.
`store.batch` delays saving; it is not a rollback transaction. This boundary
provides a prepared pre-write barrier, not cross-operation transaction atomicity.
A mutation occurring after an earlier write can still cause a later guarded write
to hold. Whole-driver atomicity is not claimed.

## Generated fact runtime receipts

Implementation: [semantic/verification/types.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/types.ts), [semantic/verification/generated-fact-support.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/verification/generated-fact-support.ts), [semantic/fact-support-write-plan.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/fact-support-write-plan.ts).

Receipts retain battery/version, settled probability/outcome, exact claim/field/
subject hashes, source and extraction identity/version/hash, full projected-state
hash and the extraction evidence reference. Provider decision IDs are optional
and retained only when actually supplied. `receiptId` is explicitly a local
attestation identifier, never a fabricated provider log ID. Rereads replace the
latest receipt per source/field/subject/battery instead of growing without bound.
Separate source receipts remain separate for canonical facts shared by sources.
Stored receipts never authorize a new write without fresh selected support reads.

The runtime `GeneratedFactSupportReceipt` fields are:

- Identity and reading: `receiptId`, optional `decisionId`, `battery`, `batteryVersion`, `spaceId`, `verdict: 'yes'`, `outcome: 'act'`, `probability`
- Exact claim and field: `claimId`, `claimHash`, `field`, `fieldHash`, `stateHash`
- Source/extraction: `sourceId`, `sourceHash`, `extractionId`, `extractionHash`, `extractionUpdatedAt`
- Attachment identity where applicable: optional `subjectId` and `subjectHash`
- Evidence: `evidenceReference: { extractionId, evidenceHash }`, identifying the whole exact extraction projection

The constructor computes `receiptId` as `fact-support-${supportHash(body)}`. The body includes the actual optional provider `decisionId`; no provider ID is invented. Receipt merge identity is source/field/subject/battery/version, and the latest read replaces that entry. These runtime records are retained evidence, not permission tokens.

## Answer relevance and source quality

Implementation: [semantic/ranking/judgment-registry.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/ranking/judgment-registry.ts), [semantic/ranking/source-rerank.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/ranking/source-rerank.ts), [semantic/ranking/fact-rerank.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/ranking/fact-rerank.ts), [semantic/ranking/source-quality.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/ranking/source-quality.ts), [semantic/evidence-ranking/batch.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/evidence-ranking/batch.ts), [source-quality.ts](../../packages/engine/sdk/src/platform/knowledge/source-quality.ts).

Registered `engine.knowledge.answer-source-rank` and `engine.knowledge.answer-fact-rank` rerank candidates against the complete question. Actual title/summary/value/excerpt/evidence is read; extractor type, claimed authority, result position and fact counts no longer form these two ranking ladders. The source reader receives extracted excerpts as well as source-linked facts, rather than judging only a generic title. A third battery, `engine.knowledge.answer-query-intent`, replaces the feature/procedure keyword ladder at these call sites.

Only yes at act selects a source or fact. Settled no returns no selected record. An uncertain set without a settled match holds visibly; unavailable readers propagate their failure without recovering old points. Empty or structurally excluded candidate sets need no model. Original source/fact IDs are retained, duplicate IDs are collapsed and equal probabilities sort by ID. Source references still come only from the caller's existing scope/access filters.

A stage considers at most 50 candidates with four concurrent pair readings. These are explicit request budgets, not guessed quality cutoffs. Source/fact selected data is preflighted as a whole before the first concurrent transmission; arbitrary metadata, database timestamps and model-unneeded IDs are omitted. Choice application is attached to recorded decisions where a recorder is configured.

The answer path awaits these readings before generation. Rejected source records and their source-backed facts are removed from generation inputs. A later lexical claimed-authority helper no longer re-adds them as citations. If the evidence set is empty after a settled rejection, the answer reports no source-backed match without spending on synthesis. Uncertain or unavailable judgment fails before new answer-gap writes. Fact rendering keeps supplied evidence text rather than discarding it through the former keyword blacklist.

`engine.knowledge.page-source-quality` reads source usefulness and supported authority from a minimal source/provenance projection. Its actual usefulness probability supplies the page order and weight; source types, search position, URL words and claimed official labels no longer supply a point ladder. Indexed/pending/generated status remains structural. Both readings must settle at act; an absent/unavailable/uncertain reader holds without a heuristic fallback. The exported quality helpers are async; prefer the new operation-local batch reader/ranker instead of passing an async comparator to Array.sort.

An operation reads at most 50 scoped sources with four concurrent requests. It preflights the complete selected batch, omits arbitrary metadata/timestamps, reuses exact in-operation readings, and refuses inconsistent duplicate source versions. Primary fact preference is claim-specific, same-space and bounded by explicit candidate/decision/request budgets. A single source is provenance bookkeeping only, not a claim-support certification. All primary preferences and supersession plans resolve before an affected enrichment/promotion/page pass writes. Prepared profile plans preserve original order, duplicate-fact support unions and per-source edges. Their write entry independently revalidates frozen source and operator state; passport compensation restores only rows the failed pass actually touched, preserving concurrent edits to untouched records. Exact source, extraction, subject, fact and edge snapshots are checked before mutation. Typed holds propagate instead of starting an enrichment fallback.

Home Graph room scope is applied before the candidate cap. Unknown room IDs cannot broaden to all objects. Room/passport quality reads share an operation-local reader; generated state and source/extraction versions are checked before page persistence. Automatic page work has a cancellable run budget; room materialization receives the same signal. Ask-refresh excludes foreign source/device/fact records and same-ID foreign collisions before transmission, checks rows again after reading, and only links facts whose sources were selected. Store.batch is save batching, not a transaction; this boundary establishes a pre-write barrier and existing passport compensating cleanup, not distributed atomicity or whole repair-driver rollback.

Relevance probabilities are not answer-confidence scores. Linked-evidence union preserves existing retrieval scores exactly, gives newly discovered references no invented points and orders selected linked sources without comparing probability to old points. Source authority/usefulness does not establish generated-claim support or answer fidelity.

A timestamp-only repeat of an identical repair-gap record can join an in-progress repair. Changed intent, provenance or operator status holds; the full current source row remains guarded through later awaits.

Initial `collectAnswerEvidence` reads `engine.knowledge.answer-evidence-relevance` against the question as written and complete selected source/extraction or node/fact meaning. Synonym expansion, source/node token points, subject/alias penalties, candidate/link/fact-count bonuses, positive-score filtering, top-minus-90 pruning and fixed record-kind boosts do not determine initial relevance. Exact access/space membership, indexed source/active node status, explicit candidate/graph membership, duplicate removal and bounded source/node windows remain structural.

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
fresh local source URIs use record-bound source projection; unknown/copied IDs
and external URLs keep ordinary protected-data handling. This is bounded
structural minimization, not universal personal-data detection.

Source, extraction, node, operator state and pertinent graph snapshots are
checked after awaits. Explicit candidate IDs cannot make draft claims serve.
An accepted fact may retain its accepted backing source internally even when the
public result limit is one. A request-local lineage guard prevents subsequent
official-linked-source enrichment from resurrecting an initial rejected source.
No source is added merely because it was labelled official. Whole-pass holds
reach the existing answer hold boundary before generation or repair writes.

Content generation uses the provider-backed generator. Judgment reads concrete candidates and does not invent a replacement generation API. Initial relevance, source/fact ranking, source quality, generated support, answer fidelity, page quality and activation are separate decisions with distinct probability meanings.

## Answer linked objects and integration intent

Implementation: [semantic/answer-object-alignment/prepare.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-object-alignment/prepare.ts), [semantic/answer-object-alignment/reader.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-object-alignment/reader.ts), [semantic/answer-object-alignment/types.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-object-alignment/types.ts).

The semantic answer input's `linkedObjects` are current local context candidates.
The Home Graph caller builds them from its search results; there is no explicit
selected-target or operator-authority field. Their exact caller association is
retained, but it cannot force the relevance reader to accept an object. A
supplied local candidate must match the current complete row. Foreign,
inactive, generated and non-object rows do not become eligible through caller
JSON. This reader never changes records, review state or permissions.

`answer-object-alignment/prepare.ts` builds a synchronous prepared read-set before
initial evidence selection can contact a semantic port. It includes the current
scoped object universe, caller context, extension declarations, source/node
records and pertinent graph state. The answer's ordinary and no-evidence paths
await the same prepared selection. A settled empty selection stays empty; neither
caller context nor the former fallback filtering can repopulate it. Existing
query-to-gap policy can still create a subjectless gap; the alignment reading does
not grant gap, serving or operator authority.

The converted answer path no longer calls generic-token removal,
`inferAnswerObjectScope`, `canonicalRepairSubjectNodes`, model-name pattern tests,
fixed object-kind preference or the integration-query regex. Exact core object
kinds and extension-declared `subjectKinds` determine candidate membership. The
Home Assistant namespace uses the exact built-in Home Graph extension declaration
so standalone semantic-service callers retain their existing object vocabulary;
custom declarations remain additive. No Home Graph heuristic consumer is called;
concrete physical/logical identity, integration identity and question alignment
are readings. Fact/wiki/gap/generated projections, inactive rows and foreign
spaces are excluded structurally. Broad Home Assistant requests retain their
existing namespace scope; relations and subject references must still agree on
their actual concrete space.

`engine.knowledge.answer-integration-intent` reads the full question with the
candidate set. `engine.knowledge.answer-object-alignment` reads each candidate
with the entire set so that singular ambiguity, plural questions, variants and
semantic paraphrases are visible. No kind-name substring selects or suppresses
an integration. Selection requires settled concrete-object and alignment yes,
and either settled non-integration identity or settled integration intent yes.
All readings must settle at act; no, uncertain, unavailable/unconfigured,
malformed, stale, cancelled and budget-held outcomes remain distinct. There is no
heuristic fallback. Ordering uses the actual alignment probability, with stable
local order for ties, without converting to legacy points or answer confidence.

Full title, summary, aliases and the selected semantic metadata are protected
before serialization, character budgets or the first answer request. Identity
includes model/manufacturer/variant, subject and target-hint meaning, and the
Home Assistant identity fields used downstream. Complete structured values are
scanned before JSON conversion. The shared answer fact-claim projection also
includes subject aliases and the string model/manufacturer values consumed by
`answer-verification/evidence.ts`, including provenance-only subjects outside the
object candidate set and a strict source-only window. Non-string unused
model/manufacturer metadata remains omitted. This adds shared answer preflight
consumer coverage without changing evidence ranking or eligibility. A protected
later alias or model holds the whole
answer before initial evidence requests. Arbitrary administrative metadata,
database timestamps and bookkeeping node/source/edge IDs are not transmitted.

Request-local object/context references map to exact current store records.
Actual local target records can prove a particular target-hint ID is a structural
reference; unknown IDs remain subject to ordinary protected-input checks. This is
not a prefix exemption, blanket `id` exemption or a caller-supplied capability.
Original IDs, caller membership, source/node evidence references, fact membership
and exact graph edges are retained locally as provenance. No record is rewritten.

The prepared read-set is checked after semantic awaits and before dependent
answer generation or gap preparation, and its guard is carried to the existing
gap write entry. Candidate changes, operator metadata, graph changes, new
potentially ambiguous objects, caller mutation, extension changes and cancellation
invalidate the pass. Generation/fidelity retains initial evidence lineage,
claim support and activation boundaries. This is an optimistic
read-set/write-entry barrier, not a transaction or whole repair-driver rollback.

Budgets are explicit: 100 candidates, 24 selected objects, 400 associations per
candidate and 160,000 projected characters, with four concurrent candidate
readings and a bounded deadline. Overflow holds; it does not silently discard a
plausible target or clip protected content. A no-candidate pass requires no model.

## Home Graph object and answer boundaries

Implementation: [home-graph/answer-scope.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/answer-scope.ts), [home-graph/search-judgments.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/search-judgments.ts).

A configured semantic service receives the bounded retrieval candidates and graph context. The shared typed alignment/integration readers select objects, followed by source/fact/excerpt and answer-verification readers. Returned results and background enrichment use the actual semantic-selected results, even when source display is suppressed; considered-but-rejected candidates are not enrichment targets.

Without a semantic service, the answer scope uses the shared prepared linked-object reader and evidence relevance with separate typed `subjects` context. Evidence-relevance battery version 2 requires each candidate's own evidence to concern selected objects/variants; subject descriptions are not source evidence. An empty subject list invents no anchor and does not reject every general-topic question. Every retained result requires settled relevance yes; uncertainty, malformed/unconfigured/unavailable/stale/budget outcomes have no token or weight fallback.

The literal renderer stays literal and has no gap-generation or persistence authority. Its numeric confidence is zero (unknown); relevance probability is not answer fidelity. The completed semantic retrieval handoff described below prevents duplicate scope readings.

The scope pass validates record kind/ID, current source/node rows and explicit
space before projection. Source extraction must identify the same source and
concrete space. Search-state construction enforces that structural binding
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

The shared alignment limits (100 object candidates, 24 selected objects,
160,000 projected characters) and evidence-scope limits (100 results, 24 subject
identities, 160,000 characters) remain fail-closed. Configured semantic answers
retain their existing structural retrieval windows and contracts. This is not
unrestricted large-corpus semantic retrieval, a whole-ask transaction, a new
write-authority grant, or the separate broad taint/write-authority audit gate.

`answerHomeGraphQuery` does not use the retired semantic object-scope helper, `canonicalRepairSubjectNodes` or its own integration-intent regex. Intent stopwords, singular/type/model patterns, TV/domain preferences, source-type/relation points, a tie band and source/anchor token overlap do not select answer objects. Shared typed alignment and relevance own those decisions.

## Home Graph semantic retrieval

Implementation: [home-graph/search-judgments.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/search-judgments.ts), [semantic/evidence-ranking/batch.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/evidence-ranking/batch.ts), [semantic/answer-excerpts/prepare.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-excerpts/prepare.ts), [home-graph/service.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/service.ts).

`HomeGraphService.ask` calls `readHomeGraphSearchSelection` after its existing
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

Complete candidates/sources retain the existing reader limits. Batch composition must handle a useful manual among many large decoys, candidates past a first 100-candidate batch, late exceptions past old display clips and configured semantic answers with large rejected linked sources without increasing protection/reader caps. A single complete candidate or source that exceeds a reader limit holds; large-document streaming and unrestricted retrieval are not implied.

Each search result remains bound to the captured source, node, extraction,
concrete knowledge space, graph universe and original question. Source and
extraction space/source identity must agree. Full original extraction protection
precedes projection; record IDs remain local. The shared semantic node-serving filter excludes research gaps and requires
in-scope indexed, non-generated support for factual nodes. The same captured
source set bounds reference-header projection, so an active fact cannot expose
stale or foreign source context after its support changes. Excluded rows remain
in the local change guard. Existing generated-page and active-record filters
remain in place. Unindexed documentation-candidate rows without extraction
retain their original deterministic exclusion; relevance cannot override that
serving boundary. Shared reader dispatch checks
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

## Public search and prepared packets

Implementation: [public-retrieval.ts](../../packages/engine/sdk/src/platform/knowledge/public-retrieval.ts), [packet.ts](../../packages/engine/sdk/src/platform/knowledge/packet.ts), [service.ts](../../packages/engine/sdk/src/platform/knowledge/service.ts), [knowledge-api.ts](../../packages/engine/sdk/src/platform/knowledge/knowledge-api.ts).

`KnowledgeService.search` / `searchScoped`, the grouped knowledge API, HTTP and
GraphQL search, both terminal commands, and task-packet construction await
the same complete-candidate relevance reader used by semantic answers. The
former `scoreHaystack` task/write-scope token points and indexed, extraction,
usage, relation, freshness and node-kind boosts are removed from these callers.
Result limits and packet packing run after the semantic reading of all eligible
candidates. A missing, malformed, unavailable, uncertain or stale reading holds;
there is no lexical or cold-cache fallback.

Generic scope remains owned by `knowledgeSourceMatchesScope` and
`knowledgeNodeMatchesScope`. This preserves default-space contamination checks,
explicit scopes, `includeAllSpaces`, and nodes admitted through their structural
relations. Search still excludes stale sources and non-active nodes. Packet
admission retains its existing scope-only policy. This change does not import
Home Graph's generated-source, gap, documentation-suggestion, object alignment,
or factual-node backing policies into the generic API.

`public-retrieval.ts` captures the full local graph one record at a time and
guards membership, scope-affecting relations, source/node versions, absent or
present extractions, original query/write scope, provider configuration and
caller cancellation. Descriptor checks precede serialization; accessors do not
run while capturing or checking the read-set. Every complete consumed candidate
is protected before any request. Bookkeeping, record IDs and arbitrary
administrative metadata remain local; explicit claim/content/identity and the
actual memory/catalog fields retain semantic meaning. Original producer URI
exemptions come only from the current stored source's existing opaque proof.

The existing relevance batches keep their per-reader 100-candidate and
160,000-character limits. Each request contains one candidate and the same
lookup context, so partitioning cannot introduce peer-relative scoring.
Actual/requested models and configuration must agree; probability ties retain
the generic API's local-ID order. One deadline covers relevance and excerpt
selection. No new transport retry, backoff or approval path is added.

An arbitrary first lookup cannot synchronously perform an asynchronous recorded
judgment. The pre-release SDK therefore makes the transition explicit:

- Await `service.search(...)`, `service.searchScoped(...)`, and
  `api.graph.items.search(...)`. Their result object shapes are preserved.
- Continue awaiting `buildPacket`, `buildPromptPacket`, `packets.build` and
  `packets.buildPrompt`.
- `buildPacketSync`, `buildPromptPacketSync`, grouped `buildSync` /
  `buildPromptSync`, and `buildCuratedKnowledgePromptSync` are retired after all
  repository callers migrate. They do not silently return empty output.
- A real synchronous layout consumer first awaits `preparePromptPacket` or
  `packets.preparePrompt`, then calls `readPreparedKnowledgePromptPacket` with
  the opaque handle and the exact task/write scope. Forged, changed or revoked
  handles hold. A genuinely settled empty packet can return `null`.

The orchestrator prepares at its actual asynchronous prompt-build boundaries.
Synchronous layout alternatives share one prepared result, rather than issuing
new readings. It rechecks the handle after `beforeProviderRequest` and through
the provider's actual `beforeAttempt` boundary. Wrapped provider-attempt denials
propagate before semantic error/retry classification. The existing task-only
emergency layout performs no unnecessary retrieval. Consumer type tests pin
the new async contract and opaque preparation instead of hiding the change
behind a promise/array union.

Native planner, unit and corrective task text renders the complete original
goal and ordered criteria, including duplicates, while host source/revision and
criteria identifiers remain in the existing typed local source, admission and
receipt bindings. Those protocol identifiers are not flattened into a raw
knowledge query. Derived unit instructions, repair errors, prior plans and
repository context remain in the task and pass through the ordinary input
guard. Sensitive text in any semantic field still refuses before dispatch,
including text that merely resembles a generated criteria identifier.

Search and packet `score` remain numeric for payload compatibility, with zero
meaning no legacy retrieval points were computed. The reason says this
explicitly. Internal relevance probabilities order accepted rows; they are not
presented as old point units or answer confidence.

### Packet meaning and budgets

Source packet text comes from the shared exact-original-span reader. Empty
selection stays empty; summaries/descriptions and first extraction sections
cannot reappear as fallbacks. Detail changes presentation, not the selected
meaning. Node packets retain full explicit semantic content. Relation labels
are scoped context, not factual evidence or numeric relevance.

Token estimates count the fields actually rendered. Existing item limits,
budget floor, first-whole-item exception and post-reading `limit * 4` packing
window remain explicit. Whole items are omitted rather than clipping selected
qualifications. `totalCandidates` counts semantically accepted rows;
`droppedCount`, `droppedForBudget` and `budgetExhausted` distinguish item/rank
limits from actual budget omissions. Usage counts are descriptive metadata.
Usage/event success effects occur only after all required readings settle and
the captured state remains current.

## Answer fidelity sufficiency and confidence

Implementation: [semantic/answer-quality.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-quality.ts), [semantic/answer-verification/reader.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-verification/reader.ts), [semantic/answer-verification/evidence.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-verification/evidence.ts), [semantic/answer-verification/types.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-verification/types.ts).

Provider generation uses `completeText` for content only. It cannot supply answer confidence, accepted citations, repair gaps or quality decisions. The real judgment port remains the typed discriminative `noul`/choice/score API; no free-text Jev operation is invented.

Three versioned registered batteries separately read candidate fidelity plus completeness, evidence sufficiency, and preference among supported, equally complete candidates. Fidelity includes both the text and meaningful claims from the factual records returned alongside it, including exact subject descriptions and target hints. A settled contradicted/unsupported candidate is excluded. Any uncertainty, missing/failing port, malformed response, cancellation, expired budget or stale read set holds instead of authorizing an unchecked fallback. No supported candidate yields an honest unverified answer with no returned facts.

A literal candidate preserves facts and selected extraction excerpts. It does not infer features with topic lists, regexes or domain-specific family counts. Its bounded display announces truncation; the full actual extraction still enters verification. A literal candidate must pass the same fidelity and completeness readings, including when provider generation is not configured. Only a supported candidate with actual evidence and complete query coverage is reported verified.

Public answer confidence is the supported fidelity probability multiplied by 100 and rounded. No retrieval points, fact counts, source authority, self-reported confidence or synthetic minimum contributes. `includeConfidence:false` hides only that display and cannot alter gap/repair decisions. Foreground repair consumes settled insufficiency/no-evidence state; successful repair consumes the verified quality outcome, rather than comparing confidence to 50.

### Evidence, provenance and privacy

Actual in-space stored extraction text, not source summaries or titles, is the truth basis. The projection excludes generated sources and arbitrary metadata. Complete selected evidence and returned-fact claims receive protected-input preflight before generation; all concrete candidates receive preflight before any quality request. No protected suffix is silently clipped away to make a request eligible. Scope filtering precedes transmission.

Each supplied source receives an opaque `evidence-N` reference. Citation markers must exactly bind to these labels, including markers inside returned fact claims. Original source/extraction identities remain local and are returned as citation provenance, not sent to the judgment port. Actual provider decision IDs are retained only when supplied.

Exact original source, extraction, fact, subject and relevant edge snapshots remain local. Derived response aliases/metadata are not mistaken for stored records. Reads of absent answer-gap nodes and issues are watched too. Changes while generation or verification waits invalidate the pre-write pass, preserving operator state. The no-match path also snapshots scoped retrieval records so late indexing cannot authorize a stale absence gap.

One bounded answer operation covers retrieval, generation and verification. Optional signals reach source/fact readers, provider generation and quality requests. Deadline/abort races stop an ignored-signal operation from keeping the public answer pending; continuation checks prevent later judgment requests and repair writes after release. A model/provider operation already in flight cannot be forcibly terminated if it ignores its signal. Service refinement receives the caller's cancellation signal and checks it before further scheduling; its existing repair-driver timing and lifecycle remain distinct from the answer verification budget.

Only settled evidence insufficiency stages an evidence gap. Missing extraction or structural no-match can separately stage an observed availability gap. Unsupported generation with sufficient evidence does not invent missing evidence; uncertainty/unavailability write no gaps.

The exact-state/cancellation barrier remains required before gap persistence. Answer-gap plans use the atomic prepared-ingest seam described below; ordinary `store.batch` only batches saves. Search, generation, foreground repair and page work remain separate operations, with no whole-driver rollback promise. Trusted node/issue terminal protections remain authoritative.

Budgets are at most 24 evidence rows, two answer candidates, 160,000 projected characters and 16,000 characters per candidate, with a default 15-second total answer deadline and maximum 60 seconds. Literal display is capped at 14,000 characters with a truncation notice; full verification evidence is not clipped.

## Answer-gap admission equivalence and persistence

Implementation: [semantic/answer-gap-plan/prepare.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-gap-plan/prepare.ts), [semantic/answer-gap-plan/write.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-gap-plan/write.ts), [semantic/answer-gap-plan/types.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/answer-gap-plan/types.ts).

Gap observations cover both no-match answers and matched answers with insufficient verified evidence. Plain-text content generation remains separate from discriminative gap readings.

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

### Preparation and persistence

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

### Bounds and evidence

The selected pass permits at most 50 stored gap candidates, 160,000 projected
characters and 8,000,000 cumulative request bytes, including declarations and
per-request overhead. It uses the original answer deadline (15 seconds by
default, at most 60 seconds). A local deadline/abort race stops readers that
ignore cancellation; each continuation checks again before another request or
write. Malformed, unavailable, uncertain, ambiguous, aborted, stale and
oversized passes authorize no writes.

## Repair profiles

Implementation: [semantic/repair-profile.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-profile.ts), [semantic/repair-profile/reader.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-profile/reader.ts), [semantic/repair-profile/types.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-profile/types.ts).

Three registered high-stakes batteries replace whole-source concrete-feature matching, broad and category query regexes, canonical-value term tables, wattage-as-audio inference, minimum match counts, low-value cascades, and scrape-word stripping:

- `engine.knowledge.repair-profile-category`: whether the actual query requests each declared profile category
- `engine.knowledge.repair-profile-value`: whether each concrete original source span belongs to that category and supplies useful subject-specific specification information
- `engine.knowledge.repair-profile-support`: whether every selected exact value is fully supported in the complete original source context

The seven existing category titles, kinds, labels, and aliases remain a fixed output vocabulary. They do not establish relevance or feature support. Paragraph/sentence syntax only enumerates candidate spans with exact original offsets. Single newline table labels stay with values unless a complete sentence boundary occurs. No vocabulary regex selects or rewrites canonical values. 4K/8K, counts, watts, negation, and operating-mode qualifications remain verbatim. Every reading sees the full selected source text, including other models, surrounding exceptions, meaningful URLs, and scrape words. No judgment call generates prose.

A settled negative selection excludes a candidate; an explicit negative feature can itself be a positively selected, supported value. Uncertain selection, unavailable/missing ports, malformed answers, changed provider configuration/model, cancellation, or any unsupported selected value holds the entire pass. Caps reject the complete pass instead of truncating candidates or evidence. A port that ignores cancellation cannot keep the pass alive after its timeout.

### Input and persistence boundaries

All selected semantic input, subject identity, source provenance fields and local references are protected before a port is acquired or a request is serialized. Arbitrary source/extraction metadata is not sent. Only the existing in-process, record-bound producer proof can project exact minted source/extraction references. Prefixes, credential-shaped IDs, cloned records, JSON-shaped proof and caller metadata confer no exemption. Original record IDs remain in local caller maps and the existing support receipts.

`deriveRepairProfileFacts` returns a Promise. The internal batch helper `deriveRepairProfileFactPass` preflights and settles all selected sources together. These are internal modules; no root or declared subpath export changed. The direct callers are:

- `semantic/enrichment.ts`: reads original extractor text before formatting/cleanup, awaits profile decisions and rechecks its existing generation guard before any generated node or semantic-state writes
- `semantic/self-improvement-promotion.ts`: snapshots selected and excluded source/extraction rows, reads the whole pass and rechecks the gap/subject/source guard before preparing writes
- `home-graph/page-profile-facts.ts`: batches selected source readings and rechecks source/extraction/device state before returning a plan

The existing field/attachment support and prepared activation/operator/provenance write guards remain in force. Profile results do not authorize serving or writing. `isKnowledgeSourceQualityFailure` recognizes the leaf profile-held error so indirect repair orchestration cannot convert an unsettled profile into fallback writes. Existing accepted/rejected operator review survives repeated profiles.

Repair callers do not pass exact selected profile spans through the legacy canonical sentence classifier again. Only exact span equality is deduplicated; distinct unselected spans retain their own path. Repeated promotion preserves exact values such as 120 Hz without inventing 100/120 Hz. Concrete source/extraction scope disagreements, including conflicting broad aliases, reject before any reading.

## Repair fact usefulness and source roles

Implementation: [semantic/repair-usefulness/reader.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-usefulness/reader.ts), [semantic/repair-usefulness-plan.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-usefulness-plan.ts), [semantic/self-improvement-promotion.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/self-improvement-promotion.ts), [semantic/repair-fact-selection.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-fact-selection.ts), [semantic/repair-source-authority/reader.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/repair-source-authority/reader.ts).

`engine.knowledge.repair-fact-usefulness` replaces the semantic `isUsableRepairFact` predicate used for repair-subject linking and repair usable-fact counts. It reads the exact fact title, kind, summary, value, evidence, subject, labels and aliases against complete selected source extraction text, source provenance, the actual repair query, and declared subject identity fields. A supported explicit negative specification may be useful. Actual furniture instructions, boilerplate, unrelated subjects and unsupported quantities are negative. Incidental words in the category title and a distant source sentence do not determine usefulness.

Exact active status, fact kind, space, source association and current operator state remain code. All relevant candidate inputs are protected before any port access, serialization, cache lookup or size limit. Arbitrary metadata and database IDs remain local. Source/extraction projection uses the existing record-bound minted-reference mechanism. Whole-pass guards include excluded fact rows, edges, the gap, subjects, source/extraction versions, and missing/existing proposed target rows.

The operation-local reader cache ignores only the request-local opaque reference. Every other semantic input must match exactly; current references are rebound to each returned reading. Configuration and model changes hold the reader. Cached results are never persisted as exemptions or carried to another operation. Input, request, byte, concurrency and wall-time budgets hold instead of clipping or partially returning results.

### Two no-result contexts

- Existing stored candidate: settled `act/no` excludes that fact from the link/count set. Uncertain, malformed, unavailable, unconfigured, aborted or stale decisions hold the complete pass.
- Newly proposed promotion claim: its exact final prepared claim is read after support and activation preparation, before any promotion writes. A settled no holds the complete proposed batch with `not-useful`, distinct from uncertainty. It is never treated as a successful empty or partial promotion.

The prepared promotion writer remains all-or-none. No invented stored-node or operator-review identity is supplied for proposed claims. The existing promoted-count/completion meaning and target-count rule remain unchanged. Prepared linking adds the usefulness guard inside its existing batch without replacing support, activation or operator guards. Task completion/count writes likewise recheck the final prepared count. Earlier independent completed passes are not rolled back by a later pass hold.

Repair source roles use the separate canonical `engine.knowledge.repair-source-authority` reading over complete source/extraction meaning, the query and subject identities. Discovery labels are unverified claims, not proof of ownership. Role is neither write permission nor fact support. Source, extraction, subject, gap, caller configuration and cancellation guards remain live through publication, including delete/reinsert identity changes. This role reader does not replace the qualified baseline's separate repair-subject selection or model-compatibility policy.

## Home Graph triage

Implementation: [home-graph/triage.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/triage.ts), [home-graph/triage/application.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/triage/application.ts), [home-graph/triage/reader.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/triage/reader.ts), [store-node-issue-writes.ts](../../packages/engine/sdk/src/platform/knowledge/store-node-issue-writes.ts).

`home-graph/triage.ts` reads applicability through a registered closed-choice judgment and separately verifies each fixed proposed battery/manual fact. It does not parse self-reported JSON confidence or use the explicit operator-review facade. A content-generation provider is unnecessary. Public service/daemon options remain compatible. `minConfidence` is an owner rejection floor expressed as probability times 100 and cannot lower the registered high-stakes band. `reviewer` and `chunkSize` are compatibility inputs, not authority or unbounded execution controls. Seeking review must itself be settled; uncertainty/unavailability holds rather than caching a recommendation.

- Three registered/versioned batteries: applicability (`reject`/`review`), exact batteryPowered=false and batteryType=none support, and exact manualRequired=false support
- Actual provider probability/model/optional decision IDs are retained; no local confidence estimate or fabricated provider evidence
- Complete selected input preflight before any request, followed by detached deep-frozen input and request states
- Allowlisted subject identity/evidence only. Internal database IDs use local mappings and opaque `issue-N` references; timestamps, unrelated metadata and review receipts are omitted. Caller-controlled Home Assistant identity and semantic text remain subject to the ordinary input boundary
- No clipping before preflight; no whole-record serialization; no claim of universal unknown-secret or PII detection
- At most 100 selected issues, four concurrent readers, a whole-pass default 30-second deadline with a 60-second maximum; cancellation settles even when a port ignores its signal
- Cache keys bind the exact projected issue/subject/rule guidance, effective owner policy, battery versions, provider model and issue lifecycle. Cached recommendations are reused only for a matching configured/actual/requested model. Explicit operator review always takes precedence, even with `force`

### Application and commit point

The entire selected reading pass finishes before application. Any unsupported fact, uncertainty, malformed response, protected input, provider failure or cancellation before application writes no node, issue, cache or revision. Detached issue snapshots are captured before the first awaited reading; node snapshots are already frozen by the store. All are checked again at the commit point.

`KnowledgeStore.applyGuardedNodeIssueWrites` is a bounded ordinary-producer seam for up to 100 distinct existing nodes and issues. It accepts no operator mutation capability. It uses the same node authority and issue lifecycle normalization as ordinary writes. Issues are normalized against an overlay of prepared nodes, preserving sequential reference-space inference. Producer review-shaped metadata still grants no authority.

After awaited initialization and full normalization, one synchronous guard checks current state and cancellation. A SQLite savepoint then writes all node rows, revision rows and issue rows without an await or user callback. A SQL failure rolls back the complete set, and caches/revision arrays change only after release. The ordinary final store save follows. This is a logical SQL/cache commit boundary, not a new guarantee about crash-safe filesystem persistence; disk-save errors propagate rather than masquerading as a held/no-write result. Cancellation arriving after the synchronous commit point reports the fully committed result.

Automatic provenance is labelled `automatic-judgment`; it never supplies `review`, `reviewedFacts`, operator `reviewProvenance` or `suppression`. Whole selected passes preserve later node edits, operator accept/reject/revise, issue resolve/reopen, and same-lifecycle terminal decisions. Trusted explicit review paths remain functional after an automatic decision. Facts for multiple issues on one subject are combined before writing.

## Home Graph quality and passports

Implementation: [home-graph/quality.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/quality.ts), [home-graph/quality/fingerprint.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/quality/fingerprint.ts), [home-graph/quality/reader.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/quality/reader.ts), [home-graph/page-quality.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/page-quality.ts), [home-graph/sync.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/sync.ts), [store-issue-replacement.ts](../../packages/engine/sdk/src/platform/knowledge/store-issue-replacement.ts).

Quality and passport completeness use five independently registered high-stakes yes/no batteries: battery applicability, manual applicability, and linked-fact manufacturer/model/battery-type existence. Name/domain/device-class fallbacks and intermediate product-class shortcuts cannot substitute for applicability. Software/infrastructure exclusions require actual applicability readings.

The exact declared boolean spellings remain code: true/yes/1 and false/no/0/none/not_applicable/not applicable (case/whitespace normalized). Unknown declarations hold. Direct manufacturer/model string presence, nonempty batteryType presence, linked-source counts, HA kind/scope, ID/relation joins and source-type tags remain structural. A zero-fact set has structurally absent fact fields, rather than a guessed textual match. Fully structural passes need no model or unrelated semantic projection.

Only selected title/summary/aliases, recorded manufacturer/model/entry type, allowlisted HA semantic identity and entity attributes, and fact title/summary/value/evidence/labels are projected. Finite numeric and boolean fact scalars are retained. Internal database IDs, unrelated metadata, timestamps and operator review material are excluded. Per-pass references are opaque and mapped locally. HA identity fields remain untrusted and protected-input checked.

Every selected quality device is preflighted before the first request. The reader preflights its entire input before budgets, deep-clones/freezes input and serialized request state, validates finite provider probabilities and actual model metadata, and requires an act-band yes/no result for every selected question. Unsettled, unavailable, malformed, unconfigured, protected, stale, aborted or budget-exhausted readings do not return a partial result. Limits are structural: 1,000 devices per quality pass, 1,000 related entities and 500 linked facts per input, four concurrent devices, 30-second default/60-second maximum whole-pass deadline. Ignored-signal providers cannot prevent timeout/cancellation. No cross-pass semantic cache is used.

Applicability and completeness are independent questions. Battery percentage or a battery keyword is not proof of type; missing documentation is not evidence that documentation is unnecessary. Registered fixtures include mains-powered backup batteries, hardwired sensor-domain objects, software namesakes, physical bridges, missing values, accessories and identifiers without field keywords. These are synthetic fixtures, not live accuracy results.

### Lifecycle and persistence

Quality refresh detaches the full current graph state and all in-space issues before any awaited reading. The full state and cancellation are checked after readings and at the store commit point. Semantic subject fingerprints bind the exact selected subject/related-entity evidence, plus recorded subject identity/manufacturer/model and relevant structural declarations; opaque indexes, entity iteration order and timestamps do not affect them. A resolved version-2 issue remains suppressed until genuinely changed evidence creates a new lifecycle. Declared boolean spellings are normalized in that fingerprint. Unversioned terminal/reviewed rows remain unchanged because their old raw hash cannot prove a semantic change versus a representation or hash-version change. Each issue records only its own question's real provider/battery/probability/optional decision ID; literal-field decisions are labelled `declared-fields` and claim no judgment receipt.

`KnowledgeStore.replaceIssuesGuarded` normalizes all ordinary issue inputs, validates bounded distinct namespace/subject/space identities, and commits new/update/delete rows in one synchronous SQLite savepoint after the final guard. There are no awaits or callbacks between the guard and SQL commit. SQL failure rolls back rows before caches change. Resolved and operator-reviewed open issues survive omission from the regenerated set. Ordinary metadata cannot mint review/suppression authority. Save errors after the logical commit propagate; this does not claim filesystem crash atomicity.

Quality issues set their intended quality namespace after `buildHomeGraphMetadata`, avoiding replacement by the plain space namespace. Reconciliation is restricted to exact legacy generator IDs, known quality codes, exact subject IDs, space, namespace and generated/homeGraph markers, with the captured record compared to current state. Unrelated plain-space issues and malformed legacy lookalikes are untouched, as are resolved and reviewed-open legacy rows.

Snapshot sync preserves its authorized structural import when derived quality is held and reports additive `quality: { status: 'held', reason }`; successful quality reports `status: 'refreshed'`. Retained unversioned reviewed/terminal rows report `status: 'partial'`, `reason: 'legacy-reviewed-state-retained'` and an exact `retainedLegacyIssues` count. Those rows require an explicit operator action/new known-version lifecycle before automatic reconciliation can establish changed semantics. It does not imply that no snapshot was imported or falsely report held issues as newly created.

`missingDevicePassportFields` is asynchronous. Its caller awaits the entire reading set before rendering or writing the passport, profile facts, sources, edges or artifacts. The existing full-state/source/extraction/operator guard remains the final write boundary. Held refreshes leave prior passport fields and artifacts unchanged.

Snapshot sync publishes its authorized raw snapshot phase before semantic auto-linking and derived quality/page work. A later semantic hold preserves that already-captured prefix but cannot publish an unvalidated link or generated page. This differs from the separate atomic graph-import seam.

## Consolidation into durable memory

Implementation: [consolidation.ts](../../packages/engine/sdk/src/platform/knowledge/consolidation.ts), [review.ts](../../packages/engine/sdk/src/platform/knowledge/review.ts), [batteries/consolidation.ts](../../packages/engine/sdk/src/platform/knowledge/batteries/consolidation.ts).

The bounded 30-day usage scan selects subjects by observed recency and stops at the caller limit (24 by default, hard ceiling 64 requests per run). This is a work budget, not a worth score. Complete stored summaries, not a 220-character display prefix, enter the reading and candidate. Oversize/protected input holds before transmission. `engine.knowledge.consolidation` reads durable-memory worth and content class: fact, architecture, ownership or runbook. Usage counts, distinct sessions/kinds and graph relations are evidence, not weighted points. Display scores use returned worth probability. ISO timestamp representation avoids accidental protected-shaped epoch material.

Source-refresh and stale-memory-review candidate types remain structural status/cadence decisions. There is no usage-weight ladder or 45/72 candidate/promotion threshold.

- A yes in the confirm band may stage an explicit open review candidate. Staging is not durable-memory promotion
- Automatic promotion requires both worth and memory-class readings at act, an open memory-promotion candidate and an unchanged exact subject snapshot
- Uncertain/no readings do not supersede earlier operator decisions or old open review candidates. Missing/failed ports fail visibly; the automatic write phase does not begin if any subject reading fails
- Explicit operator acceptance may resolve a review candidate and choose a class/scope. Source changes after its reading require refreshing before acceptance
- A terminal operator decision is preserved in full across refresh, including a decision made while a reading was in flight
- Same-store refresh/decision operations serialize per subject and candidate type. Concurrent accepts and retries cannot append duplicate memories in that process
- Durable memories retain candidate, subject and available session provenance. If memory persistence succeeds before candidate persistence fails, replay recovers the existing memory by the candidate provenance link

The two stores are not one transactional database. Provenance-based replay recovery and process-local serialization do not claim distributed multi-writer atomicity. No existing user state is migrated by this boundary.

## Terminal tasks and issue lifecycles

Implementation: [store-refinement.ts](../../packages/engine/sdk/src/platform/knowledge/store-refinement.ts), [store-lifecycle-authority.ts](../../packages/engine/sdk/src/platform/knowledge/store-lifecycle-authority.ts), [semantic/self-improvement-tasks.ts](../../packages/engine/sdk/src/platform/knowledge/semantic/self-improvement-tasks.ts), [home-graph/review.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/review.ts), [home-graph/types.ts](../../packages/engine/sdk/src/platform/knowledge/home-graph/types.ts).

- `cancelled`, `closed`, and `suppressed` refinement tasks retain their complete terminal record, including trace, attempts, timestamps, and metadata. Deterministic gap rediscovery and `force` cannot reopen the same task identity. Retryable `blocked`/`failed` tasks and distinct task IDs remain writable.
- A repair pass captures meaningful gap identity/content and issue decisions before it yields. Cancellation, resolution, explicit issue reopen, deleted records, changed gap intent, and new operator review receipts stop the old pass. Routine timestamp-only refreshes still allow overlapping foreground/background repair.
- The stop probe is checked around search and assessment, source linking, and promotion. The support contract threads the same probe into asynchronous fact-support and enrichment write plans, so a late judgment cannot write facts after cancellation.
- An ordinary issue upsert cannot reopen a resolved issue for the same content fingerprint or forge review/suppression metadata. A fresh content fingerprint starts a new lifecycle without inheriting the old review. Retired resolved fingerprints and captured lifecycle IDs prevent stale producers/compensation from restoring earlier decisions. Unversioned legacy payloads cannot resolve an operator-reopened issue: a same-lifecycle automatic completion must carry the current issue token, while a fresh content fingerprint remains a new lifecycle.
- Explicit issue review is an in-process, snapshot-bound capability. Both generic knowledge review and Home Graph review use it. Generic `reopen`/`edit` and Home Graph `edit` open the issue and clear suppression; serialized lookalikes cannot acquire authority. Source-write awaits are followed by issue revalidation before node corrections.
- Low-level issue replacement still restores ordinary metadata exactly. It cannot erase or replace a newer decision's protected metadata.
- Automatic consolidation writes memory with `reviewState: fresh` and no `reviewedAt`/`reviewedBy`; its candidate records `decisionAuthority: automatic`. Explicit operator acceptance retains `reviewed` trust and reviewer provenance. The existing injection trust mapping is unchanged.

### Intentional limits

No migration or live-state rewrite is performed. Existing stored review records are preserved, rather than retrospectively guessing whether historical review stamps were automatic.

There is currently no public repair-task reopen operation. `force` means bypass retry policy, not revoke cancellation. New task/gap identities remain supported; adding an explicit same-task reopen contract is separate work. Generic issue reopen already has an explicit public review path and remains supported. Home Graph supports `edit`; its runtime allowlist includes `reopen` even though the typed public action union does not. That pre-existing contract inconsistency is left for separate cleanup, rather than adding a new action here.

Already completed source discovery/ingest work is not rolled back. Cancellation stops subsequent refinement work and never misreports a terminal task as evaluating, applying, failed, or closed.

## Validation: extraction and alias preparation

The focused tests cover named fixture attribution, multilingual text and tables,
PDF syntax in readable prose, rejection, unknown/unavailable holds, capped wire
samples, protected material after the sample limit, both decoding candidates,
BOM and unmarked UTF-16BE, a one-byte label, parser/inflate/escape behavior,
empty/image-only PDFs, and artifact-preserving older-generation regeneration.
Temporary SQLite tests exercise actual Home Graph ingestion and re-ingestion,
recompile, and reindex under uncertain, missing and failed ports; no knowledge
writes occur and prior source/extraction records and retained artifacts survive.

Existing Home Graph regression suites use an explicit offline plumbing fixture:
the documents supplied by those tests are labelled readable, with exact rejected
samples listed for their garbled-document test. This fixture is not a classifier.

Temporary SQLite regressions cover new-source and existing-source holds for both
routes, protected input before port access, preserved retained files, source and
artifact mismatches, a changed fingerprint, one-shot consumption and corrupted
retained bytes. URL tests stub only artifact acquisition; store and extraction
execution are real and all judgment responses are deterministic fake-port data.

Offline tests cover non-ASCII tables, later headings, metadata titles, empty
pages, boilerplate-only pages, title lists larger than one request, raw and
entity-encoded protected text, and new/re-ingested SQLite records under all
three hold modes. These are pipeline tests, not live semantic calibration.

Synthetic regressions cover an ordinary epoch value that happens to match a PAN
shape, both with an actionable fake port and with no port, protected text after
the sample limit in later candidates, and accessor refusals with zero getter
invocations and zero requests. Missing judgments still hold normally; no privacy
threshold, full-text check or request budget is relaxed.

## Validation: entity aliases

`knowledge-entity-alias-judgment.test.ts` exercises the registered fixture labels
with a deterministic port; per-entity aliases; frequent non-alias words; exact
identifier/provenance preservation; multilingual and one-character candidates;
no, confirm, uncertain, missing, unavailable and malformed results; late-batch
holds on both new and existing graphs; protected text beyond request samples;
later protected identities; request and text budgets; and empty/exact cases.
Existing `knowledge-ingest-compile.test.ts` assertions are unchanged.

These are deterministic control-flow and fixture-contract checks, not live
calibration. Live calibration of the battery still requires the configured
System One port and honest recorded results.

## Validation: ingest staging

`knowledge-ingest-alias-holds.test.ts` exercises both public ingestion functions
with real SQLite files and reopened stores. Cases cover first ingest and
replacement of an indexed URI; missing, failed, uncertain and late-batch alias
readings; retained source/extraction, artifact, port and cancellation changes;
unresponsive provider cancellation; late structured-node activation and
operator-review holds; a settled successful replacement; retained observation
freshness and copied-capability rejection; and normal fetch/parser errors. Existing standalone alias, ingest compiler and extraction
hold suites provide adjacent regression coverage. Ports are deterministic test
fixtures; no live provider calibration is claimed.

## Validation: compile atomicity

`knowledge-compile-atomic.test.ts` must compare all sources, extractions, nodes, edges, issues and node revisions in live caches and reopened SQLite across refresh/alias holds, late activation holds and late edge-SQL failures for all three entrypoints. SQL-failure cases must prove node/revision writes (and refresh extraction writes) were attempted, then save the rolled-back in-memory database before reopening.

Additional cases cover source/extraction/port changes and cancellation during both
alias and serving reads, operator-review conflicts, foreign-space evidence,
caller mutation and stale snapshots, changed refresh artifacts, unresponsive
freshness reads, operational read failures, proposed-evidence visibility, genuine
observations and successful idempotent replay. Existing ingest, alias, extraction,
activation, authority and Home Graph import suites provide adjacent coverage.
Judgment ports are deterministic fixtures; no live-provider calibration is claimed.

## Validation: operator and merge authority

`knowledge-node-authority.test.ts` uses temporary real SQLite stores and reloads.
It covers forged metadata, JSON capability impersonation, mutable references,
reviewed-content/status changes, rejection regeneration, exact stale snapshots,
replacement/compensation, legacy records, partial-field scope/value binding,
explicit node/issue/Home Graph review and the public HTTP import/review paths.
No live judgment or network calls are used; HTTP error formatting uses a test port.

`knowledge-node-merge-atomicity.test.ts` uses real temporary SQLite databases and
reopens them after operator/stale holds, successful merges and SQL abort triggers
at marker, node and revision writes. A second save/reopen proves rejected writes
were also rolled back in SQLite memory. Tests cover cache visibility during SQL
commit, deduplication/self-loops, review provenance, repeated calls and retaining
unrelated successful work in an outer save batch. No live provider calls occur.

## Validation: serving authority

Synthetic cases cover numeric edge cases, explicit owner restrictions, supported low-score and unsupported high-score content, contradictions, missing/foreign evidence, unavailable/malformed readings, protected later input, frozen requests, source/operator races, forged capabilities, same-model port swaps, duplicate canonical writes, lifecycle transitions, restart/resync, exact compensation and draft-serving exclusions. Source-support, answer, operator, terminal-lifecycle and Home Graph assertions remain meaningful. Unsafe legacy-active fixtures must be explicit pre-gate records, not fabricated new approvals. Fake-port checks do not qualify a live provider.

## Validation: structural reference projection

A deterministic regression input is semanticFactId with space
`support-test`, kind `specification`, title `HDMI ports`, value `four hdmi ports`
and subject `synthetic-repro-subject-767` creates a 16-hex-character identifier with
a Luhn-valid digit run. The conservative protected-input scanner correctly refuses
that shape when it appears in a raw judgment payload. Random fixture identities
previously made this appear intermittently.

Regression cases include the exact generated-ID reproduction and real prepared repair-profile write, raw-input refusal, opaque-wire/local-provenance separation, consistent cross-references, distinct/duplicate receipts, JSON/prefix forgery, protected late content, unsupported ID paths and identity changes. These are fake-port and temporary-state checks, not calibration.

## Validation: source provenance

Synthetic regressions retain deterministic `homeGraphSourceId` reproduction and real artifact-ingest examples, exact local receipts, external URI semantics, protected-content refusal, wrong-store/copy/stale/mismatch boundaries and whole-pass preflight before the first request. No genuine payment data, credentials or user-state migration are required.

## Validation: generated fact support

Regression cases must cover foreign space before generation, private-metadata omission, late unsupported claims preventing writes, stale extraction, immutable prepared handles, operator decisions after preparation, unsupported legacy source references and mid-profile rollback. Authored fixture outcomes are not live calibration.

## Validation: answer ranking

Fake readings test contrary-to-old-extractor/authority/keyword cases, query paraphrases, settled no versus uncertainty, missing ports, exact IDs/ties, scope-associated facts, protected batch preflight, full excerpts and explicit request caps. Real temporary SQLite answer tests verify no synthesis or knowledge mutation on missing/failed/uncertain readings, and that a rejected claimed-official source is not reintroduced into generation or citations. Existing answer/repair assertions remain unchanged; off-intent synthetic facts have explicit negative readings in the plumbing fixtures.

Targeted command:

`bun packages/engine/scripts/test.ts test/knowledge-answer-judgment-holds.test.ts test/knowledge-source-ranking-judgment.test.ts test/knowledge-fact-selection-judgment.test.ts test/knowledge-semantic-answer.test.ts`

Coverage includes protected whole-batch preflight, contrary-to-keyword source selection, stale/unavailable readers, distinct-claim primary decisions, duplicate fact provenance, supersession, cancellation, SQLite/artifact no-write boundaries and source/fact/device scope isolation. Source-quality and repair assertions use labelled fake readings, not achieved accuracy.

Coverage includes paraphrases outranking keyword stuffing, record-kind/explicit-membership rejection, exact probability units, no/uncertain/unavailable distinctions, protected late input with zero requests, foreign source/extraction and draft isolation, graph-only protected subjects, stale records, limit-one backing provenance and repeated linked-source vetoes. Provider fixtures explicitly supply relevance decisions; existing answer/repair assertions remain in place.

## Validation: answer object alignment

The foundation fixtures cover paraphrases, singular ambiguity and plural targets,
connection meaning without old intent keywords, incidental integration words,
concrete identity without a model pattern, actual probability units, settled no,
uncertainty, unavailable readers, malformed probabilities, protected late content,
configuration changes, aborts and ignored-signal deadlines.

Temporary SQLite fixtures exercise the prepared caller path and exact local
provenance, structural exclusions, extension declarations, protected pre-evidence
input, stale supplied rows, operator/graph/new-object races and late ranking or
verification changes. Both ordinary and no-evidence paths hold before downstream
generation/repair writes. Existing answer expectations are preserved through
specific authored question/title readings; these fake-port fixtures do not
establish live semantic accuracy.

Focused commands use the repository-owned runner:

`bun packages/engine/scripts/test.ts test/knowledge-answer-object-alignment.test.ts test/knowledge-answer-object-plan.test.ts test/knowledge-semantic-answer.test.ts`

## Validation: Home Graph answer scope

Authored fixtures cover contrary-to-former-weight outcomes, connection intent without old keywords, plural objects, settled empty/unscoped selection, stable repeat order, source-hidden enrichment lineage, unknown confidence, all hold modes, configuration changes, stale rows, protected full fields behind clipped excerpts, foreign extractions, changed extraction lineage, foreign/wrong-ID results, structured regional variants and ignored-signal cancellation.

An owned synthetic endpoint tests actual shared transport and decision-log retry lineage through repeated 503 responses and eventual success. This proves deterministic plumbing, not genuine-provider accuracy, calibration, classification or latency.

The large-manual regression uses 32 decoy manuals with 128 KiB sections
and retains its successful result, source-title and linked-object assertions.
It must retain these successful assertions through complete-candidate batching without raising a character cap or weakening input validation.

## Validation: Home Graph retrieval

Deterministic tests exercise semantic paraphrases versus keyword stuffing,
source-type counterexamples, stable repeat ordering, unchanged request state
across partitions, exact spans and late qualifications, empty outcomes, missing
or uncertain readers, model/configuration drift, source changes before later
batches, complete late protected input, original-query mutation during generation,
rejected embedded facts and retained supporting references. Independent probes
reproduced the handoff/support regressions before their fixes.

## Validation: public retrieval

Fixtures cover semantic paraphrases versus keyword stuffing, stable ID ties,
more than 100 candidates and multi-megabyte corpora, original packet success and
drop-accounting assertions, late exact qualifications, empty excerpts, generic
space/status behavior, protected hidden fields, getter refusal, configuration
and source/extraction/edge/request revocation, cancellation, and actual provider
retry-boundary denial. All readings are authored synthetic fixtures.

## Validation: answer quality

Offline fake readings are explicitly labelled per scenario; they establish plumbing and safety, not model accuracy. The tests cover sparse complete versus numerous irrelevant facts, partial/conflicting evidence, unsupported generation, exact citations, subject metadata, stale source/operator/extraction state, protected late input, missing extraction, missing/failing/uncertain/malformed readers, literal generation absence, immutable read sets, ignored-signal deadlines and confidence-independent repair decisions. Existing source/repair subject and lifecycle assertions are retained with explicit synthetic extraction/readings. Old self-authored gap and regex-cleanup expectations are deliberately replaced with measured outcomes or a genuinely authored concise candidate, never a production compatibility heuristic.

## Validation: answer-gap planning

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

## Validation: repair profiles

Focused fixtures cover negated HDMI/Bluetooth, another model, accessory power versus audio, four ports versus four cables, injection, one concrete display value, exact 4K/8K and active/standby distinctions, table rows and multi-sentence exceptions, complete late protected fields, late unsupported selected fields, missing/unavailable/uncertain/malformed readings, provider changes, abort/time budgets, and real-store write/idempotency/operator-state/provenance behavior. Explicit authored fake readings validate plumbing and persistence, not live model semantics.

## Validation: repair usefulness

Direct fixtures cover the Smart TV/tuner case, actual furniture negatives, unsupported quantities, subject attribution, negative specifications, injection, exact semantic caching/reference rebinding, unknown identity keys, malformed/custom ports, model/configuration drift, complete late protected input, budgets and ignored-abort timeout behavior. Real temporary-store tests cover useful/negative mixed sets, operator-rejected facts, rejected excluded candidates changing after preparation, source/operator changes during a read, unavailable/uncertain pre-link holds, repeated-run counts, and first/late proposed-claim holds with no affected fact, edge or task writes.

The regression must retain the exact category title `Smart TV platform and integrations` with supported source text `ATSC tuner support`; their concatenation must not become furniture/platform advice merely because of those words. Preserve the original rich-source usable-fact-count assertion rather than reducing the expected count to accommodate lexical rejection.

## Validation: triage atomicity

Synthetic fake-port and temporary SQLite tests cover:

- Separate fact support, contrary evidence, uncertainty, unavailable/malformed providers, confidence scale/boundaries and stricter owner floors
- Full late protected content, accessor rejection without execution, cancellation and ignored-signal timeout
- Automatic versus operator provenance; no arbitrary facts from custom issue codes; no generation-provider dependency
- Family/space isolation, exact local identity retention and minimal remote projection
- Stale snapshots, mutable retained issue references, explicit reviews/reopens during reading and at write entry
- Whole-pass later holds, SQL failure rollback including persisted rows/revisions, cancellation before and after the commit point
- Cache invalidation by relevant facts, owner guidance/policy and provider, plus bounded selection independent of unselected malformed records
- Ordinary batch reference-space inference and denial of forged review metadata

## Validation: quality lifecycle and passports

The focused fake-port and real temporary-SQLite tests cover independent contrary-to-name readings, exact source/entity/space scope, all declared flag spellings, protected late evidence and accessor rejection, numeric facts, immutable multi-question inputs, deadlines/cancellation, no-write later holds, stale node/entity/edge/source/operator state, absent-set review preservation, semantic fingerprint reruns, legacy namespace isolation, new-issue SQL rollback before reload, honest snapshot-import status and passport artifact preservation. Original Home Graph assertions are retained with explicit authored readings, including precise request-count adjustments for the added independent questions.

## Validation: memory consolidation

Temporary real SQLite knowledge/memory stores with disabled vector indexing and authored fake readings cover contrary-to-old-score decisions, review/act bands, unavailable/failed ports, protected input before transmission, stale snapshots, in-flight operator decisions, idempotency, provenance and partial-persistence recovery. Registry fixtures cover both worth answers and all four memory classes. Fake-port execution is not semantic-accuracy evidence. Genuine calibration requires a compatible configured port and honest recorded results; the existing runner accepts:

`bun run --cwd packages/judgment calibrate --registry ../engine/sdk/src/platform/knowledge/judgment-registry.ts`

## Validation: terminal decisions

All lifecycle tests use temporary SQLite state, deferred promises, and synthetic judgment readings. Coverage includes persisted cancellation across reload/forced rediscovery; late successful and failed search; pending promotion cancellation; issue resolve/reopen races; stale review edits; immutable terminal task payloads; retryable/new tasks; new and stale fingerprints; compensation; capability forgery; legacy persisted unversioned payloads; Home Graph edit-to-open; and automatic/operator trust provenance.

Run the focused suite with:

```sh
bun packages/engine/scripts/test.ts test/knowledge-terminal-decisions.test.ts test/knowledge-consolidation-judgment.test.ts test/knowledge-node-authority.test.ts test/knowledge-generated-fact-write-boundaries.test.ts
```

## Validation gates and live qualification

Use the repository-owned engine test runner for focused and integrated knowledge/Home Graph suites. Normal integration gates include source build, forced solution and standalone type-test compilation, API/subpath compatibility, line-cap, credential-scope, no-any, error-contract and no-skipped-tests checks. Commit hooks are required without bypass. Exact-head aggregate/product integration is separate from focused deterministic coverage; pre-existing diagnostics must be reported, not silently treated as a pass. No historical pass count establishes the current head's qualification.

The source/fact reranking and query-intent batteries declare a 0.90 calibration floor; generated-field and subject-attachment support declare 0.95. These are declared targets, not measured accuracy. The ranking registry can be passed to the existing judgment calibration command after a compatible port is securely configured. Live results require honest recorded provider outcomes.

## Compatibility and transaction limits

The public search Promise transition and retired synchronous helpers are deliberate API requirements; synchronous consumers need opaque prepared packet handles. Generated-fact support, observation, prepared-write and operator-review capabilities are separate. Persisted JSON or runtime attestations never recreate a capability.

A synchronous SQLite savepoint plus post-release cache publication provides the described logical all-or-none boundary. Ordinary asynchronous `store.batch` only defers saves. Filesystem save failure after SQL commit, cross-store memory persistence, source discovery already completed, and independent earlier repair/page passes are outside those rollback guarantees. Cancellation after a synchronous commit must report the committed result honestly.

Extraction-repair candidate policy, repair-subject selection/model compatibility and distinct unselected repair-sentence paths are separate consumers. This contract does not specify replacements for those policies. The canonical repair-source-role reader and semantic Home Graph auto-linking do not establish them. Generated entity/relation/freeform-wiki fidelity and broader origin-taint/write-authority analysis are outside the guarantees stated here; generated-fact and answer support must not be treated as certification of every other producer.
