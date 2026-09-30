# Knowledge node serving authority (THE32)

## Decision and retained policy

The inventory's store-config, store-node-history and store default-confidence decisions now use the registered high-stakes yes/no battery `engine.knowledge.node-serving-without-review`. Its question concerns the entire proposed content and exact source evidence. Producer scores, explicit producer `active` status, reviewer names and serialized receipts cannot answer it.

There is no implicit numeric activation threshold. Missing and nonfinite producer confidence is descriptive zero; finite fractions remain on the declared 0-100 scale and are never multiplied by 100. A finite 0-100 `nodeAutoAcceptConfidence` supplied explicitly by the owner remains an additional one-way hold after a settled yes, not an acceptance rule or a probability. Invalid explicit settings fail configuration. The old exported default constant is compatibility-only and is never used by the store.

At least one actual independent extraction or genuine observation capsule is required. A known same-space reference without extraction stays explicitly unverified in the reading; another real extraction can support the entire claim. Unknown, foreign, stale or generated source references still hold. Per-source support-edge verification remains a separate THE23 obligation.

A settled act/yes can serve new synthesized content. No, uncertain, malformed, missing/unusable evidence, missing provider or provider failure cannot. New candidates can be retained as `draft` with pending-review provenance. A composed serving pass asks for `requireAccepted` and holds the entire node pass. Held replacements preserve the previous active record exactly and throw; they do not pretend the old record satisfies the new request. Changing served content while requesting draft/stale also holds rather than disguising replacement as a lifecycle transition. Ordinary stale transitions of unchanged content and lifecycle bookkeeping remain structural.

Legacy active records are not migrated or bulk-downgraded. An exact unchanged replay preserves the existing record. Nodes accepted by the new reader recheck their exact evidence/subject fingerprint before reusing that status; replacement content is read afresh. Full operator reviews still protect their entire content and decisions. Field corrections protect only their declared fields, never granting a whole-node approval or promoting a draft.

## Three distinct write paths

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

## Preparation, privacy and commit

`KnowledgeStore.prepareNodeWrites`, `assertPreparedNodeWrites` and `upsertPreparedNode` implement a whole-pass preparation barrier. The token is backed by a private WeakMap, is scoped to the store's private backing-state identity, and is one-use per slot. Separate stores and copied JSON fail. Legitimate facade objects sharing the same actual store state remain usable.

All selected semantic input is preflighted before the first request. Candidate projection includes all fields consumed by current serving paths, complete markdown and established extraction text paths. No source clipping, arbitrary metadata dump, timestamps or raw database IDs is sent. Exact existing/proposed subject IDs become local labels; unknown-origin hint IDs retain normal protected-input inspection. Original IDs and complete source/extraction/operator snapshots remain in local provenance and read sets. New receipt keys are excluded from legacy content-shape/scope classification and text search.

Limits are 320 nodes, 32 sources per candidate, 2 MB of total request state/questions plus protocol allowance, 8 MB of local read-set snapshots, four concurrent calls, 15 seconds by default and at most 30 seconds for the complete reading pass. Plain snapshots reject accessors, cycles, sparse arrays, excessive depth and oversized trees. Cancellation and total timeout settle even if a fake/custom port ignores its signal. Candidate, request and read-set snapshots are detached and immutable. No probabilities are inflated.

Unique kind/slug identity is checked both during preparation and at the actual write, including insert, replacement and guarded batches. A new explicit ID cannot make SQLite INSERT OR REPLACE delete a reviewed row behind the ID-based authority guard. Generated producers disambiguate only colliding human-readable slugs with their own stable identity; existing records are not migrated or overwritten. Tests verify the protected row, cache, revision history, database bytes and reopened store.

The final write guard checks current nodes, sources, extractions, referenced subjects, the installed port identity/model, cancellation and a 30-second prepared-write freshness bound after all awaits. THE29 node/issue commits and THE31 guarded issue replacement retain synchronous SQL/cache commit sections. There is no awaited model call inside either commit.

Enrichment, supported attachment writes, primary repair-profile writes and supersession consume a prepared pass instead of rereading at each write. Proposed passport facts must settle activation before virtual active facts enter rendering. Answer evidence/ranking/returned facts, generated-page targets, Home Graph search and generated-page rendering exclude drafts. Administrative review views retain draft visibility.

Home Graph import (THE41) preflights all selected candidate/evidence projections, stages normalized source/extraction records, and completes every node judgment before its first visible write. It rechecks source, extraction, node, issue, edge and operator state after the reads, then commits rows and revisions in a synchronous SQLite savepoint and publishes caches only after release. A failed reading or SQL write leaves the selected import unchanged, including after close/reopen. Ordinary source/extraction/edge upserts share the staging normalization.

Import never mints observation/operator authority. Changed staged evidence invalidates retained observations on selected imported nodes, including source-less observations whose hidden dependencies cannot be proven unchanged. An unchanged node title cannot bypass that rereading requirement. Such imports can hold when independent extracted evidence is missing; they do not borrow an old raw observation to preserve apparent success. A settled replacement drops the stale observation receipt, while genuine fresh producer capabilities may bind new evidence and explicit operator decisions remain protected. The internal staged-ingest callback preserves only original branded observation inputs, never copied observation-shaped JSON.

Compensation can reuse only an exact locally committed record backed by an opaque source/subject guard. It cannot reconstruct authority from copied receipt JSON, erase a newer operator decision or overwrite an untouched concurrent edit. This preserves exact prior passport/fact metadata and timestamps on a failed scoped refresh. The repository's broader async batches remain optimistic rather than globally serializable; each affected write rechecks its read set, and this slice does not promise to undo unrelated concurrent work.

## Verification and remaining scope

Synthetic tests cover the numeric edge cases, explicit owner restrictions, supported low-score and unsupported high-score content, contradictions, missing/foreign evidence, provider outages and malformed readings, protected later inputs, frozen requests, source/operator races, forged capabilities, same-model port swaps, duplicate canonical writes, lifecycle transitions, restart/resync, exact compensation and draft-serving exclusions. Existing source-support, answer, operator, terminal lifecycle and Home Graph assertions remain meaningful; unsafe legacy-active fixtures are explicitly pre-gate records rather than fabricated new approvals.

All provider calls in verification use fake ports. No live model, credential access, network calibration, remote push or real user-state migration is part of this proof. Genuine live calibration remains separate. This slice does not convert unrelated initial ranking, repair-coverage, triage heuristics, product code or broader origin-taint propagation.
