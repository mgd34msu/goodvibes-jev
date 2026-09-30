# THE-42: aliases before ordinary ingest publication

## Defect and correction

Ordinary artifact and URL ingestion previously published a pending source,
replaced its extraction, and published the indexed replacement before compiling
structured entity aliases. An alias hold then reached the generic ingest catch,
which persisted a failed replacement source. Reingesting an indexed URI could
therefore hide its prior usable knowledge while retaining a mismatched graph.

The source's pending representation is now a detached local draft. Extraction
still runs against retained artifact bytes. Finalization prepares the complete
alias batch from the proposed title, extraction summary/sections, exact structured
entity identifiers, and merged metadata before any source or extraction write.
Successful compilation consumes that prepared alias result without judging it a
second time. Structured project/capability nodes can also require activation
readings or reject a change to operator-reviewed content. These dependencies now
prepare against the exact proposed source/extraction before any source or graph
write. A shared synchronous SQL savepoint publishes the prepared source,
extraction, graph, and revision records together; in-memory state changes only
after the SQL writes succeed. Alias, activation, and reviewed-node holds escape
the ordinary failure handler without publishing a failed replacement.

## Freshness and cancellation

Preparation binds the retained source and extraction, including the canonical URI
reservation. Changes during extraction or alias reading hold before publication.
Finalization rechecks the artifact fingerprint. Alias readings also bind the
installed port and model; an optional ingest signal can interrupt a provider that
does not itself honor cancellation. No partial aliases or heuristic fallback are
published. Input snapshots prevent caller mutation from changing the proposed
content while its readings are pending.

Operational fetch and parser failures retain the existing failed-source path.
Catalog projections still use their genuine observed-record capabilities. Their
precommit guard checks the original retained state; the committed observation
checks actual live source/extraction records against the staged evidence. Copied
JSON gains no observation authority. The ordinary import and standalone compile
contracts keep their existing judgment policy.

This change's atomic boundary covers `ingestKnowledgeArtifact`,
`ingestKnowledgeUrl`, and their `finalizeKnowledgeIngestedSource` path. The
separate standalone compilation and refresh gaps identified here are repaired in
[THE-44](THE-44-atomic-knowledge-compilation.md), which reuses this staged boundary.

## Verification

`knowledge-ingest-alias-holds.test.ts` exercises both public ingestion functions
with real SQLite files and reopened stores. Cases cover first ingest and
replacement of an indexed URI; missing, failed, uncertain and late-batch alias
readings; retained source/extraction, artifact, port and cancellation changes;
unresponsive provider cancellation; late structured-node activation and
operator-review holds; a settled successful replacement; retained observation
freshness and copied-capability rejection; and normal fetch/parser errors. Existing standalone alias, ingest compiler and extraction
hold suites provide adjacent regression coverage. Ports are deterministic test
fixtures; no live provider calibration is claimed.
