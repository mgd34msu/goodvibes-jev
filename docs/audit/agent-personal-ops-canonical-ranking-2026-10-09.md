# Agent PersonalOps canonical discovery and protected invocation

Base: `d1dcb55c75e874817e4b8706de0a8b19c6da09d1`. This is a bounded
THE-63 P11 implementation receipt, not whole-product closure, live classification
acceptance, or a claim that unchecked inventory rows lack implementations.

## Owner, callers, and exact scope

The public `gateJudgmentRegistry` supplies the existing
`engine.tools.registry-rank` battery. Agent supplies typed, descriptive operation
catalog data; it does not copy the battery, bands, or a lexical substitute.
`rankHarnessCatalog` uses the installed runtime port and returns its banded
readings, probabilities, and decision ids. Positive, negative, and uncertain
candidate dispositions are recorded. The original proposed PersonalOps-specific
intake/lane battery names are satisfied here by reusing this canonical candidate
reader instead of installing another semantic owner.

- M1638 / D1727–D1731: `agent-harness-personal-ops-intake.ts` ranks the complete
  ten-operation catalog, including the two calendar variants and the two task
  variants. Connector selection uses the operation purpose and the canonical
  rerank after structural effect/capability scoping. Keyword intent, token
  preference weights, fabricated confidence priorities, and the default task
  fallback are removed. Candidate order and confidence derive from readings.
- M1646 / D1786–D1787: `agent-harness-personal-ops.ts` uses canonical query ranking
  for queue and lane lookup. An exact lane id remains deterministic; an empty
  queue query retains the existing readiness ordering.
- M1644 / D1741: `resolveRunRecord` ranks non-exact requests only to return
  suggestions. Even a positive low-stakes reading cannot authorize a provider
  read. It returns `selection_required` / `exact_record_identity_required` so the
  caller can retry with an exact record identity. A missing explicit record id
  never falls back to another record. Uncertain readings return `deferred`.
- M2038: actual `personal_ops` facade forwards Tool.execute options to
  `agent_harness`; the harness awaits the canonical caller and carries its
  signal. The PersonalOps MCP adapter forwards that signal in the existing
  optional third `McpApi.callTool` argument (public facade support in PR227).
  Exact execution retains existing effect, readiness, required-field, and
  confirmation checks. MCP remains the canonical permission/admission owner.
  Source API/session identity is rechecked immediately before dispatch.

`agent.task-route.catalog` was already adopted in `agent-route-planner.ts` and
is credited unchanged. TUI eval/provider-health/memory ownership already has
`docs/audit/tui-canonical-hoist-accounting-2026-10-08.md`; none is reimplemented
or claimed newly delivered by this batch.

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

## Regression evidence

The combined local suite exercises:

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

At the initial combined checkpoint: 161 tests passed, 5,809 assertions, across
`agent-harness-tool`, `protected-research-adoption`, `agent-personal-ops-ranking`,
`agent-personal-ops-tool`, and `agent-personal-ops-workflow-honesty`. The product
workspace contract check reports all four products present. Final source/test
compiler, package build, exact-head CI and actual-main qualification must be
attached to the integrated commit separately.

## Explicit residuals

This does not close M1637/D1722–D1726, M1639/D1732–D1733, M1641/D1734,
M1643/D1735, or the remaining M1644/D1736–D1740 result-field/boolean/redaction
sites. Existing connector lane/capability discovery and placeholder generation
remain separate semantic adoption obligations. Shared settings/harness catalog
search, model-family, preferred settings, daemon work, MCP admission, check-in,
compaction, WebUI parity, compiled/native acceptance, and configured live
classification proofs are outside this bounded change. No Linear checklist
rewrite, deployment, or live account action is included.
