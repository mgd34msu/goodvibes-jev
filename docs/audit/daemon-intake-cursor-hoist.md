# Inbound cursor store and provider contract

This bounded intake prerequisite hoists daemon provider-adapter.ts,
cursor-store.ts and the original cursor tests from pinned daemon
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`. No newer upstream source is silently
substituted. Provider polling, preview redaction and triage conversion are later
slices; the original semantic guesses are not copied into this prerequisite.

## Public and persisted contracts

`@goodvibes-jev/engine/sdk/platform/intake` follows the existing host platform
export pattern: Bun source, declaration types, and built ESM import. It is
Node/Bun-only because cursor persistence uses filesystem/sql.js; it is not added
to browser/runtime-neutral entry points. Consumer-vantage type assertions use
the package name and pin the absence of credential-write access on the inbound
adapter context. That context exposes only resolveRef/resolveConfigSecret and a
logger, without importing daemon-product internals or an unrelated subsystem.

Preserved storage behavior includes the historical `.goodvibes/tui/operator/`
path and inbox.sqlite name, schema, stable item IDs, mutable feed fields,
existing route ID when an update omits one, monotonic finite-only provider
watermarks, newest-first keyset ordering with ID tie-breaks, provider/since
filters, 30-day retention, 5,000-item cap, and count-only sweep disclosure.
Watermarks are never reaped. Adapter factory order/replacement/filtering,
30/60/120-second cadences and explicit configured/unavailable/empty states are
unchanged. Registry construction does not resolve credentials or poll providers.

## Reproduced lifecycle defects

The unchanged imported source ran 25 pass and 6 fail across the original tests,
provider contract tests and nine new cursor lifecycle regressions:

1. An older flush cleared a single dirty flag after a newer item was inserted.
   A subsequent flush and close skipped that item, losing it after restart.
2. Close returned while an earlier flush was still running.
3. Close during initialization left a database reopened after shutdown.
4. Repeated close returned early rather than sharing completion.
5. A previously queued retention callback queried a closed database.
6. A second init returned before the first recovery sweep finished persisting.
   A targeted replay confirms this premature-readiness failure on the source.

The port tracks mutation/persisted revisions, so only a captured revision is
marked saved. It owns pending flush/sweep work, shares initialization and close,
stops admission immediately, awaits startup and existing I/O before the final
flush, and closes the actual handle last. Closed operations refuse. Startup
closed midway resolves without arming a timer; a fresh init after close refuses.
Failed initialization can retry while open. Failed persistence remains dirty
and retryable. Observer exceptions cannot cause unhandled timer rejections.

This does not add cross-process transactions. The underlying store serializes
whole-file saves within one process; independently opened process snapshots
remain last-writer-wins. The inherited comment claiming concurrent sweeps were
safe was narrowed to that real limitation. A single store owner is required.

## Verification scope

Original dedup/retention/persistence tests remain. Added tests exercise the
flush race, owned I/O, close/init reentrancy, retry, late timer callback, throwing
observers and keyset pagination under concurrent inserts. All data are synthetic
fixtures in owned temporary directories. No inbox credentials, network provider,
production inbox files or persistent authentication were used.

The final selected inbox/storage set passes 54 tests across five files (140
assertions). Build, API extraction, declared-subpath, architecture, line-cap and
browser/runtime-neutral checks pass. Packed engine and judgment tarballs were
extracted into an isolated consumer tree; both Node 24 and Bun 1.3.14 resolved
the intake subpath to the packed JavaScript, imported its public API and observed
an empty provider registry. External dependencies came from the already
installed tree, not a fresh registry installation. Packing used an isolated
HOME, offline npm mode and disabled lifecycle scripts; no artifact was published.
