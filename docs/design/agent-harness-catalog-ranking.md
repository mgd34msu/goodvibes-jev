# Agent harness catalog ranking (THE-63 P11)

## Bounded adoption

The mode, model-tool, slash-command, and daemon operator-method catalogs delegate
semantic queries to the existing `rankHarnessCatalog` adapter and canonical
`engine.tools.registry-rank`. Their former phrase/word fallback, weighted token
scores, action-verb bonuses, command fuzzy-prefix selection, and operator category
alias vocabulary no longer decide these results. The vocabulary module is
retired into this canonical owner, rather than another product reader.

Actual consumers are `agent_harness`, `host action:"methods|method"`, and
`workspace action:"commands|command|run_command"`. These callers await the result,
retain typed errors, and never produce a lexical answer when screening or judgment
is held, unavailable, malformed, cancelled, or stale. A missing explicit tool,
method, or command identifier stays missing. Exact names, case-insensitive names,
alias equality, closed mode/action dispatch, HTTP-backed method eligibility,
no-query listing, and existing page/detail bounds remain mechanical.

Lists retain yes and uncertain candidates in canonical probability order with
individual judgment receipts. A semantic detail resolves only a single yes;
uncertain or multiple candidates remain ambiguous. Registry ranking is a
low-stakes discovery reading: even a single yes in `run_command` returns
`selection_required` and an exact command name. It executes nothing. A separate,
explicit name/alias invocation retains the command's confirmation and admission
requirements. Every nested dispatch through the adapter-owned `executeCommand`
closure rechecks cancellation and original authority before executing.

## Full original evidence and output privacy

`agent-harness-catalog-ingress.ts` reuses the existing protected-source owner and
invocation projector. It screens the complete original query-bearing invocation,
including fields a facade will not forward, before compaction, registry repair,
ordinary readers, or the harness call. Raw factories and registered tools use the
same boundary. An invocation whose protected projection changes is held; it is
not silently rewritten. Proxy/accessor/non-plain-prototype routing is rejected
without executing source hooks.

The existing ranking adapter structurally captures the full candidate DTO before
its trusted descriptor callback runs. Each migrated caller additionally supplies
the entire semantic candidate as `evidence` to canonical
`snapshotJudgmentInput`, before flattening or local service access:

- Model tools: name, description, side effects, complete JSON schema (including
  descriptions, defaults and enums), and the remaining returned definition data.
- Commands: name, aliases, description, usage, argument hints and other command
  data. The handler function is an executable identity capability. It is captured
  and checked locally, never serialized or sent as evidence.
- Modes: full descriptor, including summaries, next routes, aliases, keywords,
  parameters and effect/confirmation metadata.
- Operator methods: contract id/title/description/category, route, scopes,
  availability/effect/access, output descriptors and complete original input
  schema. The displayed parameter projection remains bounded to 48 properties.

Schema objects receive structural credential/card preflight before flattening.
A plain credential field declaration is still allowed by the canonical owner;
credential-bearing defaults/enums are not laundered into harmless prose.

The full query, full candidate descriptions and full semantic evidence are
protected before any 600-character ranking projection or hosted port lookup.
Each candidate is one JSON-framed protected part. Framing is validated after
screening. The migrated callers require every screened part to remain unchanged;
any redaction holds the whole semantic result before hosted ranking or output.
Thus a private schema field cannot reappear in the returned original after a
redacted description was used for ranking.

The established Personal Ops adapter contract remains separate and unchanged:
opaque return-only receipt metadata is descriptor-safe captured but never used as
semantic evidence, sent to local screening, sent to the hosted reader, or used
as a cache key. Existing Personal Ops callers still project just their declared
semantic fields. They retain their existing redaction behavior and tests. None
of the four newly migrated catalogs excludes a semantic output field this way.
No new privacy owner, credential discovery, source cache, or fallback is added.

A qualification failure exposed one generated-source defect in the established
Personal Ops flow: saved review filenames used a decimal epoch suffix, and those
filenames become semantic catalog labels. Some epochs satisfy the canonical card
check. The isolated naming fix encodes a UUID suffix using letters `a` through
`p`; it preserves the safe title and `.json`, without changing screening or
scrubbing user text. Artifact selection and reading use metadata and artifact
IDs, so old filenames remain readable. Regression tests pin a card-shaped clock,
old/new inbox/calendar reads, successful canonical discovery, and continued
refusal of genuinely protected title material.

## Currentness and asynchronous boundaries

Facades pass the exact `ToolExecuteOptions` object. Rewritten argument objects
carry a private process-local closure that verifies the original args/options
pair with `assertCurrentToolExecution`; copied arguments do not become a new
admission. Registered projection lifetime checks are bound to the exact final
argument object supplied by the registry, and retire when released.

Checks cover original admission, AbortSignal, source-owner binding, session
identity, relevant client identity, captured registration and current catalog
metadata before/after screening and hosted awaits. Command capture also binds
handler identity, including exact-name resolution's newly asynchronous boundary.
Late answers cannot publish a result or trigger a nested command after authority
loss. The helper also checks current hosted port and canonical reader identity.

## Bounds, concurrency, and cost limits

At the pinned a102927 source the raw operator contract has 542 methods; 470 have
an HTTP method/path and participate in this catalog. They all reach the canonical
reader for a semantic query, even when the output limit is one. No lexical
pre-shortlist is used. A normal operator query therefore entails 470 pair
readings, with the canonical reranker maximum of eight in flight, plus roughly
59 sequential local screening batches and the original invocation screens.
Each screening batch normally calls the proposal and verification services.

Limits remain explicit: fewer than 1,024 candidates, at most 128 protected source
handles, at most eight parts and 40,000 characters per handle, and at most
1,000,000 serialized source characters across the whole reading. Oversized
candidates or source sets hold; they are never clipped before protection. Only
after full screening does hosted ranking apply its 600-character description
bound. Descriptor capture rejects cycles, proxies, accessors and hooks, with
a depth limit of 64, shared 100,000-node and 100,000-array-slot budgets across the complete catalog,
and a shared 1,000,000-character capture budget (including local-only DTO data).

The real large-catalog regression suspends the first eight hosted calls, verifies
backpressure and sequential screening, then cancels and proves queued pairs do
not dispatch. Synthetic localhost timings are not a live latency/cost or
classification-quality measurement. Live provider calibration and operational
cost/latency acceptance remain THE-35/THE-15 obligations. No broader live-quality
or whole-product closure is claimed.

## Verification and remaining scope

`products/agent/src/test/tools/agent-harness-catalog-ranking.test.ts` exercises
actual harness/host/workspace consumers, counter-lexical results, negative and
uncertain controls, full nonforwarded fields, output/schema privacy, exact
identities, original authenticated admission revocation, registration/handler
replacement, cancellation during screening and ranking, context changes,
malformed data/readings, and large-catalog concurrency.
The default `registerAgentTools` bootstrap regression additionally proves that
the real registered model-tool definitions, including the harness schema, fit
full-evidence source bounds and reach the canonical reader before returning the
requested complete parameter schema.

Existing catalog, capability advertisement, harness, facade, native-import,
route-integration and Personal Ops suites retain their metadata and authority
assertions with explicit scripted readings for newly semantic expectations.
Recorded fixtures establish wiring and contract behavior, not live calibration.
Final source/test typecheck and exact-source aggregate/publication evidence are
recorded separately in the delivery receipt.

The shared lexical search module still serves unrelated settings consumers in
`agent/harness-control.ts`; that residual and other catalog modules are not
closed by this bounded migration. Personal Ops canonical intake remains credited.
THE-13, THE-14, THE-63 and final integrated acceptance remain open.
