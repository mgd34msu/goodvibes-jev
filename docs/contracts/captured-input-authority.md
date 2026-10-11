# Captured input authority and contained tools

This contract describes defensive captured-view boundaries and their validation requirements. It does not establish complete tool parity, cross-platform release readiness, universal atomicity or autonomous permission authority. Protected argument projection is separately specified in [owned tool-input projection](protected-tool-input-projection.md); semantic gate evidence and cancellation are specified in [gate input and exec admission](gate-input-and-exec-admission.md).

Captured authority owns source identity, receipt integrity and actual access scope. It must not acquire authority from model-shaped fields, copied paths or a historical permission path. Dirty-owner result publication has the explicit limits below.

## Ownership and authorization

- Admission owns a cloned receipt and rejects replacement or mutation after any asynchronous step. Initial, repair and amendment planners remain on that generation. Corrective planners carry the original owner identity while reading a frozen descendant result view.

- Opaque, WeakMap-minted leases cross the construction-only second AgentManager spawn argument. No model-shaped AgentInput field or copied path grants authority. Members rebind validated existing branches on resume and keep separate cancellation signals.

- Original-owner and actual-view read checks remain live. Missing managers/filters, forged/revoked leases, source or view redirection, excluded paths and unsupported aliases hold. Invocation arguments are owned before permission callbacks may yield. Unauthenticated inputs are copied and frozen; registry-authenticated inputs retain their exact admitted identity and currentness checks.

- Captured runs always own fresh registries, caches and project indexes, including when the captured cwd equals the runtime default. Unrelated owner passive code injection and owner reindex observers are not forwarded.

- Retained captured paths stay protected after lease release and in a fresh process. Ordinary owner-root reads cannot acquire authority by naming an absolute copied path or a symlink to it. Reserved path recognition only denies access; execution authority still requires the construction-owned lease.

- Actual file reads, file-preview search and basic writes check authority before the backend. Tool delivery and every initial/retried provider request revalidate the cumulative readset. Initial repository mapping uses guarded ImportGraph reads and export reads, and carries its readset into the planner's first provider admission.

- Validation is conservative and may repeatedly inspect the recorded tree. It does not claim OS-wide atomicity against uncooperative external writers.

## Supported workflows and scope

Capturing input adds no human approval step of its own. The selected permission/judgment adapter retains responsibility for semantic decisions. Deterministic source identity and scope checks are not an approval, autonomous decision or semantic fallback.

- Captured reads retain in-process text, outline, symbols, AST and media extraction behind the actual per-file read check. File/content/symbol/structural/reference search uses the owned invocation's current original/copy checks. The default reference backend's existing LSP-unavailable fallback remains visible; no new external LSP process is granted authority.

- Mutable members can write and edit text, then inspect the actual resulting files. Edit registration pins the member cwd. Dependency discovery is guarded; the old automatic host `npx tsc` observer is explicitly unavailable for captured edits and starts no process. Verification uses the contained exec path instead.

- Inspect reads are authorized asynchronously before the same resolved backend path is opened; scaffold writes require a mutable member and current authorization for each output path; project/API/frontend modes keep their existing Jev readings. Fetch remains on its existing HTTP/network-policy path; local file URLs and disk-output/cache parameters cannot open captured or owner files.

- Guarded local analysis includes impact, dependencies, dead code, coverage, bundle, surface, preview, security, permissions, env audit and test finding. Relative explicit project roots resolve against the captured root. Historical diff, breaking-change and semantic-diff analysis use a fixed Git object reader with captured-view HEAD and separately identified pinned comparison commits. Safe literal/glob/icase/top/exclude selectors remain available; live attribute predicates fail explicitly. Metadata paths are authorized before blob reads; the owner Git directory is never exposed to tools. Upgrade analysis keeps the existing network path while reading admitted package metadata.

- Captured exec uses a fresh permission-filtered disposable projection, strict process containment and live authority checks through output and apply-back. Retained until jobs, explicit background calls to the constructed exec backend, PTY interaction through an existing configured prompt-answer adapter, and pre-command file operations use the same boundary. The default subagent caller still forces background requests to foreground, without expanding that caller policy. It never falls back to host execution. Actual-runner validation must perform write, edit, analysis, dependency-backed Bun build/test and read through the real member tool path, including resume.

## Platform and process containment

Captured exec requires Linux x64 or arm64 and a working bubblewrap/seccomp boundary. `auto` contract isolation selects a worktree when the root is a Git repository with a commit, otherwise a shared tree; that selection alone supplies no captured execution backend on macOS or Windows. Linux without usable containment also holds. There is no host-execution fallback. A skipped test on an unsupported host is not capability evidence; containment qualification must require real positive fixtures.

### Declared dependencies

Declared dependency inputs are admitted under the original owner authority, copied immutably and mounted read-only. Workspace links can map only to an already-authorized captured target; command preparation reads captured bytes rather than later live owner edits. Actual-runner validation must invoke a real ignored TypeScript compiler dependency and a captured workspace package, including resume.

### Environment and network

Networking follows the existing trusted exec sandbox plan and gate; the filesystem projection does not introduce a blanket network refusal. Local socket controls establish the declared policy behavior, not external DNS or internet reachability. The process uses the existing ambient credential scrub and preserves explicit environment overrides. Ambient PATH/HOME/TMPDIR point into the projection; no host filesystem mount is granted by an environment value. Unsupported stdin/input options return a typed refusal rather than being silently ignored.

### Publication and retained jobs

Retained jobs are owned by one captured authority, drained before its completion checks and stopped before terminal events or view disposal. Concurrent publishers and member write/edit/scaffold operations share a publication lock; changed output is compared before publication and empty-directory operations preserve topology without erasing omitted denied children. Notebook edits, exclusive member backups and atomic writes use the same owned publication scope. Repeated backups pin the exact intermediate revision produced by the batch; rollback preserves original bytes and executable modes. Embedded validators reuse the existing fixed command map through captured execution and a scoped publication lease.

### Runtime admission

In constructed production paths, fixed typecheck/lint validators and direct foreground, retained-background and interactive Node/npm/npx commands share the same construction-owned, pinned runtime admission and read-only projection. The existing shell AST selects optional runtime availability only; it grants no file or process authority. Unknown, wrapped, dynamic and parser-incomplete commands attempt the full admission. Simple Bun build/test and non-executing shell primitives retain their lightweight existing substrate; indirect Node use inside those exempted Bun workflows remains unavailable unless the command also selects the Node runtime. Missing or restricted runtimes produce an explicit refusal through the captured aliases, with no host-process fallback or implicit process-executable bind. Known system Node/npm command aliases are blocked inside the existing OS mounts; this does not claim to inventory every alternate runtime binary in that substrate.

### Bun evaluation and history

Composed direct captured exec and captured REPL JavaScript/TypeScript evaluation share an original-owner-authorized ordinary Bun runtime, pinned during trusted construction and proved in an empty contained boundary before project execution. Source launches admit their interpreter; compiled products declare the packaged sibling interpreter. Missing, changed or denied runtimes remain unavailable, with no PATH fallback, host evaluation or inherited runtime-mode marker. Direct exec consumes this admission without a prior REPL or validator call. Missing or failed admission installs an explicit captured Bun refusal while preserving shell and separately admitted Node execution; a compiled product binary or known system Bun/bunx alias cannot replace the admitted interpreter. Project Bun configuration and preloads retain their native behavior. Evaluation has fresh per-call variables. Its bounded in-process attempt history and session metadata are owned by the exact captured authority and run, never imported from host history files; cached results revalidate their original permission/lifecycle bindings before delivery. Different runs or rebound authorities start empty. Other runtimes and durable history remain held.

### Registry sources

Registry search, content, preview, dependencies and recommendation use an opaque admitted project/global skill and agent context, with source identity and current host authorization checked before disclosure and each queued Jev reading. Denied includes hold the containing content rather than silently dropping context. These bounded workflows do not establish complete captured-tool parity.

### Construction scope

Pinned runtime guarantees above require the runtime-admission owners supplied by the production orchestrator. Legacy or manually assembled low-level bindings that omit those owners are not certified: the substrate still has compatibility branches that can bind the current process executable. A copied authority-shaped object, command classification or legacy embedding cannot establish the production admission, full parity or autonomous authority.

## Captured write/edit auto-heal

When `tools.autoHeal` is enabled, write syntax failures and edit post-validation failures use one construction-owned repair backend. Formatter and linter commands operate on disposable authorized projections. Candidate mode never publishes any command changes, including neighboring files, modes, deletions or side effects. Only the requested file's exact, regular, single-link UTF-8 candidate may return. Existing validator execution retains its ordinary publication behavior.

Stages are bounded to admitted project-local tools: Prettier with project/editor configuration disabled; Biome with a fixed isolated configuration; and ESLint with configuration discovery, ignore discovery and cache disabled and a fixed repair rule. Missing binaries, unsupported versions or unavailable containment produce explicit stage warnings and proceed to the existing ToolLLM stage. Ambient/global tool discovery, host project configuration, npm package resolution and network access are not repair capabilities. No new setting or tool family is introduced.

Every candidate retains the existing JS/TS parser and `engine.tools.heal-acceptance` decisions: all stages must fix the reported errors, and model rewrites must change only the fix. Original-owner/view read authority, the exact member revision and the original publication lease are checked before and after each stage and judgment, and immediately before rewriting. Fresh asynchronous authority admission runs before every provider and judgment dispatch, including retries and fallback endpoints; a refused gate terminates before transmission. Judgment retains its final synchronous signal/lease/revision fence. The owned cancellation signal reaches providers and judgments; in-flight authority monitoring cancels cooperative work and discards late results. Already-started transmissions cannot be retracted.

Rejected or unparsable repairs do not replace the initial write. Atomic edit validation still restores only unchanged owned revisions; conflicting newer bytes are retained and an incomplete rollback is reported. Repeated write backups use the final healed revision. Repair output, byte counts, edit diffs, caches and undo records describe the final content. Missing/forged/rebound backends, immutable planners and aliases remain held. Ordinary live-tree auto-heal keeps its existing backend. This repair boundary does not establish support for unrelated workflows.

Captured text-edit history is finalized on success, validation failure and exception exits, including an earlier accepted repair followed by a later failure. Each retained file is recorded once only after fresh read admission and an exact owned-revision check under the original active publication lease. Successfully rolled-back files and conflicting newer revisions create no new entries. Any failed finalization admission withholds the entire new history batch, preserving prior undo/redo. Cancellation, revocation or denied admission can leave already-published bytes in the member view without a new undo entry; history bookkeeping does not re-read withheld contents or grant delayed mutation authority. These checks fence snapshot recording, not the later general-purpose synchronous undo/redo API.

## Dirty-owner result publication

An unchanged admitted dirty owner baseline receives only the authorized binary delta from input commit to result commit, after whole-patch preflight and receipt/permission/cancellation revalidation. Owner HEAD, index and pre-existing dirty bytes remain intact. The receipt is `applied` with no hash, and explicitly says uncommitted; when auto-commit was requested it reports that committing is deferred for the dirty baseline. Changed or conflicting owner state remains not-applied with both sides retained. This path does not perform a dirty-input automatic commit; the synthetic input baseline never enters owner history.

## Reproducible validation

Use owned temporary repositories, local stored permission rules and in-process scripted providers. No production provider or credential is used.

- [test/contract/initial-planner-view-guards.test.ts](../../packages/engine/test/contract/initial-planner-view-guards.test.ts): mapping, routing, planner, judgment, receipt replacement and cancellation. Retain stale-view refusal cases.

- [test/contract-input-authority.test.ts](../../packages/engine/test/contract-input-authority.test.ts): actual AgentManager/AgentOrchestrator/tool/provider denial and nonempty allowed controls for planner/member read and file-find, generated-file write/read, missing/forged/revoked/cancelled bindings, aliases and post-read stored-policy revocation, and concurrent same-cwd runs with distinct leases (revoking one leaves only the survivor able to read and make its next provider call). Byte-reader taps and captured provider requests check denied data never reaches those consumers.

- [test/contract-input-authority-boundaries.test.ts](../../packages/engine/test/contract-input-authority-boundaries.test.ts): independent construction, dual-path authorization, cancellation, revocation, exclusions, receipt mutation, and read/write/edit argument mutation across permission awaits, explicit relative analysis roots, cached search revocation, and zero host-compiler admission for captured edits with dependents. Also validate inspector canonical-path rejection, mutable/immutable/denied/cancelled scaffold controls, and fetch file-URL/disk-parameter non-admission.

- [test/contract-input-manifest-preparation.test.ts](../../packages/engine/test/contract-input-manifest-preparation.test.ts): default immutable authorities prepare expected Git-tree/path strings, symlink descriptors and a membership index from one private receipt clone. Live Git provenance, path enumeration, byte hashing and policy/lifecycle/alias checks still run at each original validation point. Standalone validators prepare fresh expectations, and custom corrective-view callbacks keep every invocation. Controls retain original-receipt mutation/replacement holds, changed target/unrelated files, added/removed paths, source/view replacement, aliases, denial/cancellation at both permission callbacks, callback failure and final refusal. An intermediate unrelated-file mutation is rejected before a later callback can restore it.

- [test/contract-input-retained-process.test.ts](../../packages/engine/test/contract-input-retained-process.test.ts): a fresh process boots the actual ordinary owner-root Agent after snapshot/member lease release. Absolute retained paths and aliases open no denied bytes and deliver no denied marker; a separate ordinary allowed file still delivers nonempty content. The child receives paths only, with no receipt, token or in-memory captured-root registration.

- [test/contract/actual-input-authority-graph.test.ts](../../packages/engine/test/contract/actual-input-authority-graph.test.ts): real contract runner, decomposition adapter, member orchestration, actual tools and scripted provider; original denial and allowed nonempty controls through all handoffs, dirty owner preservation, and stored-rule revocation after initial mapping but before the first provider call, and persisted-member resume/rebind through the real provider. The resume case drains an interrupted run after a write, rejects its old lease, reuses the existing member cwd with a new validated lease, and keeps later owner bytes out. Its member uses real edit and analysis tools, then a contained Bun build/test with success, exit-code, stdout and sandbox evidence assertions.

- [test/contract/actual-reference-inspection-input-authority.test.ts](../../packages/engine/test/contract/actual-reference-inspection-input-authority.test.ts): paired nonempty allowed and stored original-path denial cases through the actual contract, AgentManager, AgentOrchestrator and registered tools for reference search, component inspection, preview analysis, text edit/readback and generated write/readback. Reference search asserts the existing `grep_fallback` result and real source locations; it grants no external LSP process. Inspection asserts a real component, analysis a nonempty diff, and mutations their registered readback. Fixture-only digest witnesses establish original/member identity before subject admission and unchanged denied contents before owned cleanup. Backend byte-open/process taps and captured provider requests remain separate witnesses. An armed alternate owner registry stays unused; reference revocation and cancellation after an admitted read withhold the next provider request and drain owned work before final effect assertions. The existing analysis preview envelope may report transport success with a structured read refusal; that refusal is not counted as successful analysis.

- [test/contract/actual-registry-input-authority.test.ts](../../packages/engine/test/contract/actual-registry-input-authority.test.ts) and [test/captured-registry-source.test.ts](../../packages/engine/test/captured-registry-source.test.ts): actual member search/content/preview/dependencies/recommendation, allowed project/global source controls, denied/unregistered contexts, source mutation, cancellation, include boundaries, queued judgment revocation and cached source revocation before later provider turns.

- [test/captured-exec-modes.test.ts](../../packages/engine/test/captured-exec-modes.test.ts) and [test/captured-exec-file-ops.test.ts](../../packages/engine/test/captured-exec-file-ops.test.ts): actual contained PTY/until/background backend/file operations, two-owner shutdown isolation, concurrent publication, pending-policy cancellation, typed timeout status and empty-directory preservation. The actual Agent graph must additionally run retained until work through completion and dirty-owner delivery.

- [test/captured-exec-runtime-input.test.ts](../../packages/engine/test/captured-exec-runtime-input.test.ts) and [test/contract/actual-validator-runtime.test.ts](../../packages/engine/test/contract/actual-validator-runtime.test.ts): direct Node/npm/npx before any validator, shared fixed-validator runtime reuse, structural wrapper/alias selection and lightweight Bun controls, denied-byte/process taps, missing/forged/changed runtime holds, cancellation and revocation, and stored original-path denial through the actual default orchestrator and provider.

- [test/captured-exec-bun-admission.test.ts](../../packages/engine/test/captured-exec-bun-admission.test.ts): lightweight boundary-seam coverage for direct admission, source/canonical/alias denial without executable reads, missing and forged capabilities, wrong owners, runtime replacement, known OS alias refusal, and cancellation/revocation before launch and final delivery. [test/captured-direct-exec-compiled.test.ts](../../packages/engine/test/captured-direct-exec-compiled.test.ts) and [test/contract/actual-direct-exec-input-authority.test.ts](../../packages/engine/test/contract/actual-direct-exec-input-authority.test.ts) exercise first-tool registered exec through the real temporary-Git contract graph, with real Bun build/test, project config/preloads, generated-file registered readback, stored original-path denial and zero human approval callbacks. The compiled fixture restores the product and its packaged ordinary-Bun sidecar before running the graph.

- [test/captured-repl.test.ts](../../packages/engine/test/captured-repl.test.ts) and [test/contract/actual-repl-input-authority.test.ts](../../packages/engine/test/contract/actual-repl-input-authority.test.ts): actual contained JavaScript/TypeScript evaluation and captured-history replay, imports/bindings, original/copy and host-history byte-open negative controls, distinct-authority/rebind isolation, bounded retention, cancellation and permission/lifecycle revocation before cached output or provider admission.

- [test/contract/input-delta-apply.test.ts](../../packages/engine/test/contract/input-delta-apply.test.ts): actual runner delivery preserves staged/unstaged/untracked owner data and exact index/HEAD, emits a truthful applied/uncommitted receipt, and holds conflicting owner changes, denied access and cancellation. The actual Agent graph must also verify dirty-owner delivery after real tool execution and contained dependency-backed build/test.

- [test/captured-analysis.test.ts](../../packages/engine/test/captured-analysis.test.ts): actual ordinary and captured default-member historical/upgrade calls, pinned comparison provenance, safe selectors, explicit unsupported errors, original/copy denials and cancellation.

- [test/captured-edit-write.test.ts](../../packages/engine/test/captured-edit-write.test.ts), [test/captured-write-backup.test.ts](../../packages/engine/test/captured-write-backup.test.ts) and [test/contract/actual-edit-write-input-authority.test.ts](../../packages/engine/test/contract/actual-edit-write-input-authority.test.ts): guarded notebook edits, exclusive backups including sequential intermediate revisions, exact atomic rollback and scoped contained validators.

- [test/captured-auto-heal-candidate.test.ts](../../packages/engine/test/captured-auto-heal-candidate.test.ts), [test/captured-auto-heal.test.ts](../../packages/engine/test/captured-auto-heal.test.ts) and [test/contract/actual-captured-auto-heal.test.ts](../../packages/engine/test/contract/actual-captured-auto-heal.test.ts): disposable candidate execution, target-only accepted repair, exact bytes, lease lifetime, rejection, parser failure, stored owner denial, in-flight provider/judgment cancellation and revocation, real contract write/edit repair and repeated healed backups.

- [test/captured-edit-exception-history.test.ts](../../packages/engine/test/captured-edit-exception-history.test.ts): partial/none validator and terminal repair exceptions, exact-byte healed and unhealed undo/redo, normal validation errors, successful atomic rollback, conflicting current/earlier revisions, unchanged prior history, permission/admission/lifecycle holds and finalization within the original publication lease.

- Existing input-snapshot, input-admission, planner-input-views, resume and decomposition suites cover retained generation, cancellation, repair and recovery behavior.

## Manifest preparation and fresh checks

Default immutable authorities may reuse only receipt-derived manifest preparation from a private clone: expected Git-tree/path strings, symlink descriptors and a membership index. Standalone validators prepare fresh expectations; custom corrective-view callbacks retain every invocation. Deterministic performance controls should count manifest preparation while retaining all fresh original/view policy calls.

Live Git provenance, path enumeration, byte hashing and policy/lifecycle/alias checks still run at each original validation point. Full-tree content validation stays at pre-access and post-permission points, so a file changed during one path's permission checks cannot be hidden by restoring it in a later callback. Metadata or receipt names never substitute for byte identity; permission decisions are not cached. This optimization does not eliminate repeated full-tree hashing or promise general latency.

Validation must retain the actual CLI regression for literal-union API equivalence. Cancellation fixtures must wait for the actual request-shape reading to begin rather than assume synchronous admission. Source, type, API and actual-caller checks plus independent review and CI must correspond to the exact candidate being qualified; focused component evidence alone does not establish merge readiness.

Earlier logs cannot qualify changed or reconstructed source. Run source/type/API and actual-caller checks against the tree being evaluated.

## Fresh permission snapshots

The default captured contract REPL attempts optional Node/npm runtime admission when its command shape requires conservative admission. An admitted runtime remains available to authorized nested commands. A Bun-only fixture does not alter that production boundary.

Local timings are not cross-host guarantees. Performance measurements must not replace deterministic authority checks or increase settlement deadlines merely to conceal admission work. The actual default REPL integration fixture retains a 60-second settlement observation and a 90-second test deadline.

`createPermissionConfigReader` binds the manager-owned `getAutonomousPermissionSnapshot()` accessor at construction and calls it afresh for every snapshot, returning detached permissions. The accessor copies current owned permission state without invoking observers. A legacy reader lacking the accessor takes a fresh full snapshot. Failure of an available accessor propagates; it must not select a broader fallback after a failed read.

This avoids copying unrelated configuration, not runtime admission. It introduces no permission-result cache, shared runtime tree, skipped original-path or alias check, delayed revocation, changed-file exemption, host-runtime fallback or deadline increase. Preserve Node/npm source identity, captured authority, projection isolation and final-delivery checks. Ordinary noncaptured permission readers use the same fresh-snapshot semantics.

### Snapshot and runtime validation

- Real-manager tests must reject any full-config clone while proving fresh values
  after settings change, nested snapshot detachment, same-directory owner
  isolation, construction-pinned accessors, legacy compatibility, failure
  propagation, and live stored path denials.
- The real default contract matrix must include the Bun-only positive, two
  revocation controls and an optional-runtime-enabled positive control.
  That control invokes real `node`, `npm` and `npx` from the contained Bun
  evaluation with file-backed stdio under the existing no-socket boundary.
- Runtime tests must exercise changed executable and package identity,
  source/canonical/alias denial, forged and cross-owner tokens, current
  revocation, cancellation, late policy completion, and direct real Node/npm
  plus TypeScript/ESLint commands. Those boundaries are not replaced by the
  snapshot tests.

Snapshot tests do not establish broader captured-tool parity or replace integrated runtime, authority and delivery validation.

Snapshot implementation and validation: [permission reader](../../packages/engine/sdk/src/platform/permissions/manager.ts), [owned configuration snapshot](../../packages/engine/sdk/src/platform/config/manager.ts) and [test/permission-config-snapshot.test.ts](../../packages/engine/test/permission-config-snapshot.test.ts). Runtime containment and selection are defined by [captured exec](../../packages/engine/sdk/src/platform/tools/exec/captured-exec.ts), [Node/npm admission](../../packages/engine/sdk/src/platform/tools/exec/captured-exec-runtime-input.ts), [Bun admission](../../packages/engine/sdk/src/platform/tools/exec/captured-bun-runtime-input.ts) and [captured REPL](../../packages/engine/sdk/src/platform/tools/repl/captured.ts).

Run focused suites through the repository's [engine test wrapper](../../packages/engine/scripts/test.ts), following [engine development instructions](../../packages/engine/README.md), and use supported containment CI for real positive runtime fixtures. Source-only document checks do not execute these suites or replace build, type, generated API, integrated caller, live calibration or exact-head CI qualification.
