# Model catalog search

`models action:"status"` and `agent_harness mode:"model_routing"` use
`engine.tools.registry-rank` for nonempty free-text queries. Every route and
selectable model is considered before the existing per-kind display limit
(default 100, clamped to 1–500). `models action:"local"` supplies the query
`local` when no query or target is provided. A no-query listing does not rank.

`models action:"route"` and `agent_harness mode:"model_route"` first retain the
existing exact and case-insensitive route IDs, model IDs/registry keys, and
endpoint IDs/URLs. An unresolved lookup ranks the complete route, model, and
local-endpoint catalog. Ranking identities are kind-qualified, so a route and a
model sharing an ID remain distinct candidates.

A settled negative is excluded. Affirmative and uncertain candidates retain
the canonical `judgment`, including the verdict and decision ID when recorded.
A detail resolves only when there is exactly one affirmative and no uncertain
candidate. Any remaining uncertainty or multiple affirmatives is ambiguous;
the existing ambiguity error exposes at most eight ranked candidates. No
remaining candidates retains the missing-lookup response. There is no lexical
fallback or product-specific probability threshold.

The original invocation and complete published model/provider/read-model
sources are screened before descriptive projection or display limits, including
undisplayed and hidden data fields. Redaction holds the reading rather than
returning unscreened original fields. Backend and source identities are checked
across ranking, later cookbook/readiness enrichment, recording, publication,
and final cleanup. Acquired backend guards outlive ranking receipt release;
reused argument objects receive a fresh invocation lifetime.

Registered-tool freshness checks freshly capture the current definition and
compare its canonical SHA-256 identity with the fully screened acquisition
snapshot. They do not repeat privacy classification on identical bytes or cache
authorization. Changed metadata, accessors/proxies, registrations, executors,
projectors, signals, or admission still revoke the read at its existing fences.

Search is advisory and read-only. Ranking does not select or pin a model,
refresh a catalog, edit a provider, start a server, run a benchmark, or perform
a smoke/network probe. Readiness/recipe-fit rubrics and the synchronous
startup cookbook are separate and unchanged.

Known limitation: generated opaque identifiers can incidentally contain a
PAN-shaped digit run. This includes existing background `bg_*` timestamps and
SQLite decision-log UUIDv7 provenance reused by cookbook readiness. The global
privacy floor still refuses these inputs. This slice does not change either
identifier producer or exempt provenance from screening. Tests use deterministic
noncolliding IDs for affirmative fixtures and retain a real-log refusal control
for a generated UUIDv7 collision; that fixture stabilization is not a product fix.
