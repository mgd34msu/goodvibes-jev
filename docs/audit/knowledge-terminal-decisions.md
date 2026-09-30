# Terminal knowledge decisions (THE-25)

## Boundaries

- `cancelled`, `closed`, and `suppressed` refinement tasks retain their complete terminal record, including trace, attempts, timestamps, and metadata. Deterministic gap rediscovery and `force` cannot reopen the same task identity. Retryable `blocked`/`failed` tasks and distinct task IDs remain writable.
- A repair pass captures meaningful gap identity/content and issue decisions before it yields. Cancellation, resolution, explicit issue reopen, deleted records, changed gap intent, and new operator review receipts stop the old pass. Routine timestamp-only refreshes still allow overlapping foreground/background repair.
- The stop probe is checked around search and assessment, source linking, and promotion. THE-23 threads the same probe into asynchronous fact-support and enrichment write plans, so a late judgment cannot write facts after cancellation.
- An ordinary issue upsert cannot reopen a resolved issue for the same content fingerprint or forge review/suppression metadata. A fresh content fingerprint starts a new lifecycle without inheriting the old review. Retired resolved fingerprints and captured lifecycle IDs prevent stale producers/compensation from restoring earlier decisions.
- Explicit issue review is an in-process, snapshot-bound capability. Both generic knowledge review and Home Graph review use it. Generic `reopen`/`edit` and Home Graph `edit` open the issue and clear suppression; serialized lookalikes cannot acquire authority. Source-write awaits are followed by issue revalidation before node corrections.
- Low-level issue replacement still restores ordinary metadata exactly. It cannot erase or replace a newer decision's protected metadata.
- Automatic consolidation writes memory with `reviewState: fresh` and no `reviewedAt`/`reviewedBy`; its candidate records `decisionAuthority: automatic`. Explicit operator acceptance retains `reviewed` trust and reviewer provenance. The existing injection trust mapping is unchanged.

## Intentional limits

No migration or live-state rewrite is performed. Existing stored review records are preserved, rather than retrospectively guessing whether historical review stamps were automatic.

There is currently no public repair-task reopen operation. `force` means bypass retry policy, not revoke cancellation. New task/gap identities remain supported; adding an explicit same-task reopen contract is separate work. Generic issue reopen already has an explicit public review path and remains supported. Home Graph supports `edit`; its runtime allowlist includes `reopen` even though the typed public action union does not. That pre-existing contract inconsistency is left for separate cleanup, rather than adding a new action here.

Already completed source discovery/ingest work is not rolled back. Cancellation stops subsequent refinement work and never misreports a terminal task as evaluating, applying, failed, or closed.

## Verification

All lifecycle tests use temporary SQLite state, deferred promises, and synthetic judgment readings. Coverage includes persisted cancellation across reload/forced rediscovery; late successful and failed search; pending promotion cancellation; issue resolve/reopen races; stale review edits; immutable terminal task payloads; retryable/new tasks; new and stale fingerprints; compensation; capability forgery; Home Graph edit-to-open; and automatic/operator trust provenance.

Run the focused suite with:

```sh
bun packages/engine/scripts/test.ts test/knowledge-terminal-decisions.test.ts test/knowledge-consolidation-judgment.test.ts test/knowledge-node-authority.test.ts test/knowledge-generated-fact-write-boundaries.test.ts
```

The change also runs the complete knowledge/Home Graph runtime tests, the independent build, and normal commit gates (line cap, credential scope, full forced TypeScript solution/type tests, and API checks).

Verified runtime result: 453 tests across 51 knowledge/Home Graph files, 2,846 assertions, all passed on the combined THE-24/THE-23/THE-25 tree. The independent build also passed.
