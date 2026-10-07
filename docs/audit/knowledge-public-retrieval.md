# Public knowledge retrieval (THE-21 continuation)

## Executable scope

`KnowledgeService.search` / `searchScoped`, the grouped knowledge API, HTTP and
GraphQL search, both terminal commands, and task-packet construction now await
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

## Public API transition

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

## Packet meaning and budgets

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

## Proof and ownership

Fixtures cover semantic paraphrases versus keyword stuffing, stable ID ties,
more than 100 candidates and multi-megabyte corpora, original packet success and
drop-accounting assertions, late exact qualifications, empty excerpts, generic
space/status behavior, protected hidden fields, getter refusal, configuration
and source/extraction/edge/request revocation, cancellation, and actual provider
retry-boundary denial. All readings are authored synthetic fixtures.

THE-21 requires an explicit calibration status: genuine provider accuracy and
calibration remain unverified under THE-35. Live qualification is not an added
implementation gate for this slice. Extraction/readability and repair-candidate
ranking remain under THE-20; the broader authority/taint audit remains under
THE-13. This continuation closes the specifically recorded public search/packet
ranking gap, subject to its own exact-head review and integrated validation.
