# Receipt-bound passive code context

Captured contract agents use a construction-owned, per-run passive code adapter.
They never receive the owner's live `CodeIndexStore`. This is a bounded THE-103
capability, not closure of captured runtime/history parity or all-Agent parity.

## Admission and provenance

The opaque contract authority binds the original owner, actual view and exact
selected input/result receipt. Immutable planners discover only regular-file
members of that selected receipt, including corrective planner snapshots.
Mutable members discover their current files, including legitimate generated
files, with a bounded directory walk. Runtime directories and node_modules are
excluded. Transient contained repair projections are not adapter roots.

Receipt membership is provenance, not permission. Before delegated enumeration
or a byte open, the adapter checks the live original-owner and actual-view read
policy. It rejects aliases, special files, root replacement, missing/forged
bindings and stale generations. Its descriptor reads are bounded, no-follow and
nonblocking; content and metadata are checked again before use. Content hashes
and full metadata identities detect same-line edits, deletion and background
writes without relying on tool-success callbacks or a write-publication lease.

Existing host-owned snapshot-integrity validation remains unchanged, including
its full receipt hashing and corrective-planner source/result checks. Tests
explicitly distinguish those host integrity reads from delegated index input
reads. A denied source contributes no bytes to chunking, embeddings, relevance
judgment or provider chat. The descriptor negative controls measure delegated
index opens, not an assertion that trusted snapshot validation performs no I/O.

## Retrieval and lifetime

Only enabled passive knowledge/code flags, enabled storage and positive token
headroom admit preparation. A fresh in-memory store reuses existing chunking,
SQLite-vector storage and similarity scoring. It accepts only authorized content
snapshots. Live walking, gitignore reads and lexical fallback cannot run through
an authorized store; ordinary store entrypoints reject that mode.

The exact registered semantic provider object and embedding functions stay
pinned across awaits. Hashed, absent and unsupported providers skip honestly.
Only trusted registered implementations declaring `capturedInputAdmission:
'per-attempt'` are eligible, checked before source discovery or reads. Opaque
custom providers without that guarantee are unavailable in captured mode;
ordinary embedding behavior is unchanged. Embedding requests carry
cancellation and per-attempt async admission. Built-in
HTTP embedders recheck immediately before fetch and pass the signal to fetch.
Guarded requests reject redirects, preventing automatic body replay without
fresh admission; ordinary embedding redirect behavior is unchanged.
A pending custom provider cannot start later phases or publish a late result
after cancellation; providers must honor the signal and beforeAttempt contract
for their own internal retries.

Each record boundary revalidates its actual file and the full generation's
metadata, while query, cache-result, stats and provider-delivery boundaries
revalidate the whole admitted index input. Every guard retains the existing
root/receipt integrity checks. Guards do not cache permission decisions.

A provider turn owns one generation. The runner revalidates it for every
provider attempt and after the response, then releases it before tool mutation.
The next turn builds a fresh generation. Content/generation-aware code IDs
prevent same-line edits or rebind from reusing stale pointer blocks. Project
memory keeps its independent retrieval and retention semantics.

## Bounds and availability

The adapter caps discovery at 1,024 entries, 64 files, 128 KiB per file, 1 MiB of
source and 128 chunks. Preparation and query/currentness operations each have a
15-second cancellation deadline, with elapsed-time checks before later work.
Existing synchronous host-integrity operations retain their own finite bounds;
an elapsed deadline stops subsequent work rather than weakening validation.
An exhausted preparation budget reports a skipped/unavailable code source.
Expensive immutable full-tree checks can therefore skip code on larger views.
This feature does not introduce metadata-only snapshot validation.

Disabled gates do not start index reads or embeddings. Source/permission changes
across an active embedding or provider attempt fail closed. No live providers,
credentials or accounts are needed for the synthetic fixtures.
