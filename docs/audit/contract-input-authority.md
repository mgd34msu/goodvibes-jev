# Captured contract input: defensive acceptance boundary

This repair composes the PR56 input foundation with current main. It does not close full contract tool parity (THE-103) or dirty-input result application (THE-94).

## Ownership and authorization

- Admission owns a cloned receipt and rejects replacement or mutation after any asynchronous step. Initial, repair and amendment planners remain on that generation. Corrective planners carry the original owner identity while reading a frozen descendant result view.
- Opaque, WeakMap-minted leases cross the construction-only second AgentManager spawn argument. No model-shaped AgentInput field or copied path grants authority. Members rebind validated existing branches on resume and keep separate cancellation signals.
- Original-owner and actual-view read checks are live. Missing managers/filters, forged/revoked leases, source or view redirection, excluded paths and unsupported aliases hold. Read/write invocation arguments are copied and frozen before permission callbacks may yield.
- Captured runs always own fresh registries, caches and project indexes, including when the captured cwd equals the runtime default. Unrelated owner passive code injection and owner reindex observers are not forwarded.
- Retained captured paths stay protected after lease release and in a fresh process. Ordinary owner-root reads cannot acquire authority by naming an absolute copied path or a symlink to it. Reserved path recognition only denies access; execution authority still requires the construction-owned lease.
- Actual file reads, file-preview search and basic writes check authority before the backend. Tool delivery and every initial/retried provider request revalidate the cumulative readset. Initial repository mapping uses guarded ImportGraph reads and export reads, and carries its readset into the planner's first provider admission.
- Validation is conservative and may repeatedly inspect the recorded tree. It does not claim OS-wide atomicity against uncooperative external writers.

## Supported and explicitly held workflows

Supported through the existing permission/judgment adapter: plain text read/content/line ranges; guarded find-file listings, statistics and previews; basic mutable-member writes, including reading a newly generated file; initial repository mapping through the guarded import/export scan. This repair adds no human approval step. Semantic permission and planning decisions belong to Jev; source identity, receipt integrity and actual access scope remain deterministic. Ordinary unbound live-tree tools retain their prior behavior.

Held until original-owner-aware backends are implemented and independently accepted: content/symbol/structural/reference search, broad analysis/inspection, edit, exec/build/test commands, REPL, media/outline/AST reads, symlink following, write validators, backup/atomic rollback and write auto-healing. Captured basic writes report auto-heal unavailability rather than invoking its separate provider. Unsupported tool calls return explicit holds. No claim is made that read/find/write alone restores full planner/member parity.

Dirty or changed owner baselines remain not-applied with retained output. This branch does not sweep owner edits into history, change owner staging or implement the separate snapshot-to-result delta application.

## Reproducible synthetic acceptance

All fixtures use owned temporary repositories, local stored permission rules and in-process scripted providers. No production provider or credential is used.

- `test/contract/initial-planner-view-guards.test.ts`: mapping, routing, planner, judgment, receipt replacement and cancellation. The two published stale-view cases were retained red before the fix and green afterward.
- `test/contract-input-authority.test.ts`: actual AgentManager/AgentOrchestrator/tool/provider denial and nonempty allowed controls for planner/member read and file-find, generated-file write/read, missing/forged/revoked/cancelled bindings, aliases and post-read stored-policy revocation, and concurrent same-cwd runs with distinct leases (revoking one leaves only the survivor able to read and make its next provider call). Byte-reader taps and captured provider requests check denied data never reaches those consumers.
- `test/contract-input-authority-boundaries.test.ts`: independent construction, dual-path authorization, cancellation, revocation, exclusions, receipt mutation, and read/write argument mutation across permission awaits. The mutable-argument case was independently reproduced red before immutable invocation ownership was added.
- `test/contract-input-retained-process.test.ts`: a fresh process boots the actual ordinary owner-root Agent after snapshot/member lease release. Absolute retained paths and aliases open no denied bytes and deliver no denied marker; a separate ordinary allowed file still delivers nonempty content. The child receives paths only, with no receipt, token or in-memory captured-root registration.
- `test/contract/actual-input-authority-graph.test.ts`: real contract runner, decomposition adapter, member orchestration, actual tools and scripted provider; original denial and allowed nonempty controls through all handoffs, dirty owner preservation, and stored-rule revocation after initial mapping but before the first provider call, and persisted-member resume/rebind through the real provider. The resume case drains an interrupted run after a write, rejects its old lease, reuses the existing member cwd with a new validated lease, and keeps later owner bytes out.
- Existing input-snapshot, input-admission, planner-input-views, resume and decomposition suites cover retained generation, cancellation, repair and recovery behavior.

The original PR56 CI declaration-order failure is addressed by current main's literal-union equivalence checker; its actual CLI regression is retained. The daemon shutdown fixture now waits for the actual request-shape reading to start before asserting cancellation, instead of assuming synchronous admission. Full exact-head CI and peer review remain required before publication/merge readiness is claimed.
