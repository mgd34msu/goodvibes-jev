# Daemon handler store hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
`src/daemon/handlers/sqlite-store.ts` and
`src/test/daemon/sqlite-store-recovery.test.ts`.

These two inventory rows change from PORT to HOIST because the remote peer
registry needs the same store outside the daemon composition. This is a narrow
dependency adjustment. No other product disposition changes in this slice.
The implementation lives in the engine's platform/state subsystem. The original
recovery assertions are retained in `daemon-handler-sqlite-recovery.test.ts`.

## Behavior preserved

- Existing `.goodvibes/tui/operator/<fileName>` databases open in place
- `init`, `run`, `all`, `get`, `transaction`, `save`, `close` and `dbPath` retain
  their call shapes; the public options type is `HandlerSqliteStoreOptions`
- One database per concern, SQLite parameter binding, atomic temp-and-rename
  save, transaction rollback and explicit missing-row behavior
- Unreadable images are quarantined with a warning; retention is 14 days and
  at most three copies per store, with disclosed reaping
- The SDK's distinct `SQLiteStore` retains its existing migrations, snapshots,
  versioning and batching. Only its internal memoized sql.js loader is shared,
  avoiding re-entrant WASM initialization

## Defects demonstrated and corrected

`daemon-handler-sqlite-lifecycle.test.ts` was run against the imported upstream
implementation first: eight regressions failed, while the basic transaction and
shared-loader checks passed. The port fixes those failures:

- A failed quarantine makes persistence refuse rather than overwrite the only
  recoverable copy. The fresh in-memory store remains available
- `PRAGMA quick_check` validates existing database bytes independently from the
  schema. A caller's invalid schema neither quarantines healthy data nor leaves
  a half-initialized store, and initialization can be retried
- Save snapshots are captured before yielding, serialized per exact store path
  within this process, and independent of subsequent writes or close. Unique
  temp paths alone did not prevent an older rename from winning last
- A failed atomic rename preserves the prior database, cleans its scratch file,
  and leaves the save queue usable for the next attempt
- New quarantine names include a UUID and a quarantine timestamp. A same-clock
  quarantine does not reuse a prior name, and a damaged file's old modification
  time cannot immediately expire its new salvage copy. Historical names retain
  the legacy mtime-based retention convention

The queue is not a multi-process transaction lock or a merge of separate
instances' snapshots. Callers still own logical write coordination and must
await saves before exiting. No user database or live provider was used.

## Decision review

SQLite magic-byte equality and `quick_check` read the database format and the
database engine's verdict. The new quarantine name parser reads only the
program's own filename grammar. Retention compares timestamps and a count to
the existing explicit limits. Save queues and initialization flags track
execution state. None interprets prose meaning; no new judgment battery or
heuristic fallback is introduced.

The focused recovery/lifecycle and existing state-persistence run passes 44
tests across three files.

This is a prerequisite for the remote registry and daemon composition, not
evidence of complete product parity or integrated release readiness.
