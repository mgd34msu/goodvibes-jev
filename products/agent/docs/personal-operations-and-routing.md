# Personal operations and task routing

The public `gateJudgmentRegistry` supplies the existing
`engine.tools.registry-rank` battery. Agent supplies typed, descriptive operation
catalog data; it does not copy the battery, bands, or a lexical substitute.
`rankHarnessCatalog` uses the installed runtime port and returns its banded
readings, probabilities, and decision ids. Positive, negative, and uncertain
candidate dispositions are recorded. Reuse this canonical candidate reader rather than installing another semantic owner.

- `agent-harness-personal-ops-intake.ts` ranks the complete
  ten-operation catalog, including the two calendar variants and the two task
  variants. Connector selection uses the operation purpose and the canonical
  rerank after structural effect/capability scoping. Keyword intent, token
  preference weights, fabricated confidence priorities, and the default task
  fallback are removed. Candidate order and confidence derive from readings.
- `agent-harness-personal-ops.ts` uses canonical query ranking
  for queue and lane lookup. An exact lane id remains deterministic; an empty
  queue query retains the existing readiness ordering.
- `resolveRunRecord` ranks non-exact requests only to return
  suggestions. Even a positive low-stakes reading cannot authorize a provider
  read. It returns `selection_required` / `exact_record_identity_required` so the
  caller can retry with an exact record identity. A missing explicit record id
  never falls back to another record. Uncertain readings return `deferred`.
- The actual `personal_ops` facade forwards Tool.execute options to
  `agent_harness`; the harness awaits the canonical caller and carries its
  signal. The PersonalOps MCP adapter forwards that signal in the existing
  optional third `McpApi.callTool` argument.
  Exact execution retains existing effect, readiness, required-field, and
  confirmation checks. MCP remains the canonical permission/admission owner.
  Source API/session identity is rechecked immediately before dispatch.

## Privacy and current ownership

`agent-harness-catalog-ranking.ts` descriptor-captures complete input before any
600-character display projection. The existing runtime-bound
`ProtectedSourceOwner` locally screens the complete query, identity, and
catalog description. Private DTO metadata is descriptor-safely cloned but is not
sent to screening or ranking; PAN-shaped receipt identities in such unrelated
metadata are not misclassified as outbound payment material. The same bytes in
a transmitted query, id, or description still pass the complete canonical
privacy floor, with no generic identity exemption. Only current projected values
reach registry-rank.
Opaque ordinal candidate ids prevent source identity from bypassing screening
through the decision log. Missing/uncertain local screening holds the operation;
there is no hosted screening fallback, endpoint discovery, or new authorization.

The installed judgment port identity, model, and ask binding; protected source
receipts; caller source/session identity; and cancellation are fenced across
awaits, wire attempts, and log retention. Released source handles cannot publish
late readings. Temporary unavailability remains owned by the canonical transport.
Uncertain intake returns a machine-readable deferred reason, without adding a
human permission/clarification loop. Existing missing-operation fields and
explicit effect confirmations remain unchanged.

`agent-personal-ops-ingress.ts` registers before generic registry readers and
repair. It preserves an invocation only when the full local-screened JSON is
unchanged; protected changes hold rather than rewrite execution intent. Harness
registration composes this with the existing research projector and delegates
unrelated requests to that original owner. PersonalOps status/briefing retain
ordinary behavior without a screening owner. Repair cannot enter a newly
protected mode from an unprotected projection.

## Personal-operation validation

- contradictory keywords, canonical probability ordering and negative/uncertain
  outcomes; complete decision receipts;
- actual `personal_ops` to `agent_harness` calls and both registered
  `ToolRegistry.execute` paths;
- deterministic credential refusal before local or hosted requests, including
  protected material beyond the display cap; complete PII screening; no getter
  execution; missing/unsettled screening with zero catalog requests;
- cancellation during local screening and after judgment starts; authority and
  judgment binding replacement; stale projected invocation refusal;
- exact record identity versus suggestion-only semantic lookup, existing
  confirmation/effect boundaries, cancellation reaching the MCP facade, and
  session replacement during schema discovery preventing another dispatch;
- unmodified research projector behavior, ordinary status/briefing without a
  source owner, and existing full harness scenarios.

Synthetic screening services are explicit loopback fixtures. Their test process
has proxy variables removed so the engine's direct-route containment rule can
be exercised; no production proxy behavior is changed. These are contract and
boundary receipts, not live PII/classification quality proof.

Keep connector lane/capability discovery, placeholder generation, result-field
interpretation and redaction under their actual semantic owners. A catalog-rank
reading does not establish any of these independent meanings or grant effect
permission. Shared `agent.task-route.catalog` remains the route planner's owner.

## Task-route uncertainty

The adapter passes the public `Ranked` readings with their original decision IDs. Engine composition preserves selector, slot, named-target and catalog evidence in `judgment`. An unresolved required reading produces a discriminated `uncertain` plan without `preferred`, ordinary matches or executable recommendations. Ready catalog matches require an actionable yes, and ready alternatives omit non-actionable fits while retaining those readings in diagnostics. Missing catalogs remain optional; a supplied catalog's failure propagates instead of becoming a successful empty result. A live named-ID listing change during a pending pass rejects publication. Cancellation is checked before readings and before publication.

Consume the shared judgment outcome and retry owners without adding product-local outcome types, retry loops or human approval/escalation workflows. Existing route effect boundaries remain unchanged. These route tools plan only; they do not dispatch returned routes.

Validate local scripted answers through actual public patterns and SQLite decision
logging, including 0.5/0.57 catalog uncertainty, uncertain effect slots, weak
selector fallback, a changing live named-channel target and registered Agent
composition. Registered tools preserve catalog/selection decision-log evidence
and perform zero downstream dispatches for uncertain plans. Keep unavailable
provider, supplied-catalog failure, pre-abort, pending-abort and late-result cases.
These tools plan; they do not dispatch returned routes. Synthetic results do not
establish live-provider classification quality.
