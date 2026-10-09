# TUI provider setup presentation owner (THE-62 C3)

## Scope and authority

The former product `providers/provider-classification.ts` is a thin re-export of
an engine-owned asynchronous provider setup reader. The six known labels and
honest Unknown remain available. This result is presentation only. It does not
select, authorize or veto fallback, change catalog tiers, resolve credentials,
claim readiness, establish actual prices or authorize payment. The existing
`ProviderAccessReadings` and `routing.catalog-provider-access` remain unchanged.
Jev settles semantic setup meaning; there is no new human-question workflow.

## Complete class vocabulary

| Battery question | Result | Required meaning |
| --- | --- | --- |
| `api_key` | `api-key` / API key | Direct provider API key or equivalent secret, excluding cloud-account, gateway, local-runtime and subscription setup |
| `cloud_account` | `cloud-account` / Cloud account | Account-scoped resource credentials, profiles or workload identity, even when runtime auth mode is API key or anonymous |
| `local_runtime` | `local` / Local/no-key | Models actually execute locally without a paid provider API key; a local proxy address is insufficient |
| `no_key_free` | `no-key-free` / No-key/free | Explicitly declared free hosted access without a paid key/account/subscription |
| `self_hosted` | `self-hosted` / Self-hosted | Operator-managed gateway or serving endpoint; upstream billing remains independent |
| `subscription` | `subscription` / Subscription | Stored subscription/OAuth session or plan/seat access; service OAuth alone is insufficient |
| none, multiple, uncertain, unavailable, cancelled or stale | `unknown` / Unknown | Facts do not support one settled class |

The owner preserves exact runtime auth enum values and booleans as facts; it
never substitutes vendor-ID membership. Model count, readiness, anonymous auth
and zero listed prices cannot independently establish free access. Existing
provider definitions remain authoritative for their declared runtime behavior.

## Evidence provenance and privacy

The public `ProviderRuntimeMetadata.setup` addition contains an optional declared
description and endpoint origin. Generic OpenAI/Anthropic-compatible adapters
retain their owner/operator setup description independently of whether a key is
configured. Their endpoint evidence is `URL.origin` only; userinfo, path, query
and fragment are discarded before it reaches either public runtime metadata or
Jev. Unknown/invalid endpoint syntax is absent. No API-key values or resolved
secrets are collected by this seam.

- Generic/discovered providers carry the actual configured origin and scanner's
  server-type provenance, without deriving a setup class from that type or ID.
- Existing SGLang/LiteLLM/Copilot Proxy declarations supply their operator-managed
  setup detail even with a configured key.
- The actual Foundry builtin factory forwards its declared Azure cloud-account
  resource setup. Bedrock, Mantle and Vertex already publish credential-chain,
  cloud account and workload-identity details through runtime auth routes/notes.
- OpenAI Codex already declares its subscription session. Local adapters declare
  locality; local and remote Ollama publish different actual auth/locality facts.
- Synthetic is a multi-backend router, not a local inference engine. It now
  declares mixed upstream setup explicitly; no common setup is invented. Its
  routing/dispatch implementation is unchanged.

All supplied setup-relevant fields are captured into one immutable serialized
fact state: identity, setup declaration/origin, exact auth mode/configuration,
auth route state/detail, locality/policy notes, usage cost/notes and runtime
notes. A cache entry is keyed by the complete captured state and battery
version. Only a settled single-class result is cached, not unknown or failed
readings. New facts remove an old entry; newer reads and explicit runtime
invalidation prevent old in-flight results from populating the cache.

## Asynchronous lifetime and callers

`ProviderSetupReadings.read` has an AbortSignal and a bounded default 1500 ms
presentation deadline. Both cancellation and deadline abort the judgment wire
and resolve Unknown, even for a non-cooperative reader. A late answer cannot
cache or deliver a result. A caller can invalidate the runtime-scoped cache
when its config/auth generation is replaced. One-shot CLI reads do not persist
shared state. Models list deduplicates reads per provider within that command.

Actual provider list/inspect, model current/list and support-bundle export await
the public owner over their public runtime snapshots. They retain the original
output fields and disposal behavior. Missing or unavailable setup is Unknown.

Failover preparation joins the existing C2 notice owner's single ordered queue
and total deadline. The synchronous failover hold is acquired before either
reading. A successful error reading survives a setup timeout. The preparation
reads only current from/candidate facts, before registry mutation; actual
optimizer selection, native admission and retry fences remain the existing
ones. Unread/currently different candidates receive Unknown. Provider reload /
credential-refresh events invalidate setup narration. Captured instance identities
are checked after each read, after all preparation finishes, and synchronously at
notice delivery, including a notice queued behind an earlier read. A replaced
instance loses its old label even before its change event arrives. A missing
instance lookup or missing object is Unknown, not a valid identity proof. The
“billing class changed” assertion appears only for two known, different classes;
Unknown on either side retains both labels without claiming a proven change. The notice is handed to retry
rollback once. No independent post-retry async suffix can repaint a newer turn,
session or closed terminal. Runtime setup changes invalidate presentation only;
they are not a newly invented routing admission policy.

## Deterministic proof identities

- `packages/engine/test/providers-setup.test.ts`: all classes, conflicting and
  uncertain readings, absent/free-looking facts, cache fingerprint mutation,
  old-result ownership, cancellation/deadline and credential-free origins;
  actual generic/builtin/discovered/cloud/Ollama/synthetic declaration paths.
- `packages/engine/test/routing/catalog-access.test.ts`: unchanged routing owner.
- `products/tui/src/test/cli/provider-classification.test.ts`: retained public
  vocabulary through the shared owner, no ID-only fallback.
- `products/tui/src/test/cli/provider-setup-facts.test.ts`: the three original
  red-to-green misclassifications (new gateway, remote Ollama, anonymous+models).
- `products/tui/src/test/cli/provider-setup-callers.test.ts`: actual CLI dispatch,
  public runtime snapshots and support-bundle serialization in an isolated child;
  only runtime service construction/service posture is substituted. It proves
  awaited results, provider read deduplication and disposal, not full runtime or
  compiled-terminal qualification.
- `products/tui/src/test/core/provider-setup-owner-adoption.test.ts`: actual
  failover caller preparation, ordered lifetime, deadline/Unknown, late result
  silence, cancellation/new turn/session/disposal, provider generation/instance
  replacement and preservation of existing dispatch behavior.
- Existing C2 `format-user-error`, `user-error-owner-adoption`, `failover-wiring`,
  turn-notice and retry suites remain the inherited lifecycle contracts.

These are scripted/controlled readings and source tests. They do not establish
live provider calibration, real billing facts or compiled terminal qualification.
THE-35/THE-15 retain their live-provider/final qualification responsibilities.
Exact source hashes, commands and later type/API qualification belong in the
review receipt. C3 alone does not close THE-62.

## Local source/type/API qualification, 2026-10-08

Production source was independently reviewed through `dc2ced5cbca680f9ec82ded5a54ea44906726bfe`.
The subsequent `25b413e2fce4a388b07492070dc705124568671b` changes only the test
expectation map to retain its literal union under strict test typechecking.
The dependency is the complete reviewed C2 tree
`5d8eb02c4365ba5e6fd85c6547bb38435d21802e` (local parent
`fae8fc2ecbfb198b16e7bbbf405f3e104211223f`), not selective copied C2 files.

Passed source suites remain separately scoped:

- 35 engine tests: provider setup, unchanged catalog access, discovered factory
  and provider auth aggregate
- 30 C3 TUI tests: classification vocabulary/facts, actual CLI/bundle caller
  and setup-notice ownership
- 129 inherited C2 TUI tests: error formatter/owner, failover wiring,
  turn-notice ownership, effort notices and error affordance

Passed qualification commands:

- `node node_modules/typescript/bin/tsc --noEmit -p products/tui/tsconfig.json --pretty false`
- `node node_modules/typescript/bin/tsc --noEmit -p products/tui/tsconfig.test.json --pretty false`
- `node node_modules/typescript/bin/tsc -b --force packages/engine/tsconfig.json --emitDeclarationOnly --pretty false`
- `node node_modules/typescript/bin/tsc -p packages/engine/tsconfig.tests.json --pretty false`
- `node node_modules/typescript/bin/tsc -p packages/engine/tsconfig.type-tests.json --pretty false`
- `bun run api:extract`
- `bun run prepare:sdk`, then `bun run api:subpath` and `bun run api:subpath:check`
- `bun run docs:check`
- `git diff --check`

Declarations were emitted freshly and privately from the exact production source;
no generated JavaScript or another checkout's declarations were substituted.
The canonical SDK preparation copies its current authored ambient `sql-js.d.ts`,
contract JSON and handwritten browser-host asset. It was required because tsc
correctly does not emit an authored ambient declaration. The initial missing-
ambient subpath failure and the initial test expectation type failure were
retained, fixed and rechecked. API Extractor passed with its existing compiler-
version advisory and the dependency Gaxios/Bun fetch declaration warning; this
is not a claim of warning-free extraction.

The sole generated tracked artifact change is the SDK subpath API snapshot.
It records nine new setup exports and additive provider metadata/constructor/
synthetic declaration changes, including the provider-health alias. Its WebUI
command-catalog declaration also has a literal-union ordering-only change from
the generator; normalized literal members and declaration length are unchanged.
No generated root/embedded/terminal-shell API report changed.

This establishes the stated source, declaration, consumer-type and API checks.
It does not claim a local JavaScript/package/binary build, a compiled terminal
scenario, hosted exact-head CI, merge, deployment or live provider calibration.

### Refreshed C2 + peer209 union qualification

The qualified successor is source commit
`ae0a622b5bf9937779005611cee25ee46da47552`, tree
`97b8f405b5ebeffbf5868487bd5e6b740117c638`. Its full C2 dependency is
local composition `1e4ad84d6d2e3096dfa45da0bd5cfef82037389a`, tree
`e966c3cc3e1bfefaac3a862ddb56d47ef7c0eddb`, verified identical to remote
C2 head `2c04347d276250b914ccca6d327b21c6b27fc26b`.

Independent preservation review found exactly the intended 24 changed paths;
all 23 nongenerated C3 blobs matched the preceding qualified C3 implementation.
All incoming base paths outside that delta were retained. Parsed API comparison
retained both peer205/209 additions and found exactly the same 15 C3 record
deltas, with no removed records. This is a complete dependency composition,
not a selective source transplant or an overwrite with the older API snapshot.

On 2026-10-08 the serial exact-successor qualification completed at 19:52:18 UTC:
TUI source/test types, fresh private declaration-only emit, engine test and
consumer types, API extraction, canonical SDK preparation, API regeneration and
subpath check, documentation check, the separately scoped 35 + 30 + 129 source
tests, and diff check all passed. Regeneration produced no tracked changes.
API Extractor retained the same declared dependency/compiler warnings described
above. The previously stated limitations still apply: no local full runtime or
binary build, compiled terminal scenario, live-provider calibration, hosted
exact-head CI, merge or deployment is claimed by this receipt.
