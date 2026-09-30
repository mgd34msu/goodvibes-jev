# THE-44: atomic knowledge compilation and refresh

## Defect and correction

Standalone source compilation previously prepared aliases, then wrote observed
catalog nodes, structured nodes, edges and revisions sequentially inside
`SQLiteStore.batch`. A later activation hold or SQL failure left earlier writes
retained. The direct structured-entity compiler had the same sequential-write
gap. Recompilation additionally replaced its extraction before alias and
activation dependencies were settled.

All three entrypoints now collect their complete graph and use the existing
`applyPreparedIngest` boundary. Recompilation obtains a genuine one-shot prepared
extraction from the retained artifact, and stages the exact normalized extraction
beside its graph. Alias and serving judgments read the proposed extraction while
the retained source, extraction, graph and revisions stay unchanged. A late SQL
failure rolls back the savepoint before any cache publication. The compiler no
longer has a sequential writer fallback.

## Preserved contracts

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

## Verification

`knowledge-compile-atomic.test.ts` starts with the refresh/alias-hold and
late-activation reproductions. Those cases, and late edge-SQL failures for all
three entrypoints, failed on the committed THE-42 baseline. The fixed tests
compare every source, extraction, node, edge, issue and node revision in live
caches and reopened SQLite. SQL-failure cases verify that node/revision writes
(and extraction writes for refresh) were attempted before failure; they save the
rolled-back in-memory database before reopening it.

Additional cases cover source/extraction/port changes and cancellation during both
alias and serving reads, operator-review conflicts, foreign-space evidence,
caller mutation and stale snapshots, changed refresh artifacts, unresponsive
freshness reads, operational read failures, proposed-evidence visibility, genuine
observations and successful idempotent replay. Existing ingest, alias, extraction,
activation, authority and Home Graph import suites provide adjacent coverage.
Judgment ports are deterministic fixtures; no live-provider calibration is claimed.
