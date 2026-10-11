# Agent main-conversation READ admission

Scope: the existing autonomous permission owner and the Agent main conversation's
`read` tool. This does not migrate settings, `agent_harness`, write/edit, every
contract-member registry, or every legacy SDK caller. Qualification is recorded
separately from the implementation contract below.

## Original obligation and entry points

The [autonomous decision contract](autonomous-jev-decisions.md) assigns semantic
decisions to Jev while retaining authentication, capability, privacy, scope,
revocation, schema and one-use execution boundaries. The
[Agent inventory](https://linear.app/the-artificery/issue/TA-63/port-the-redesigned-agent-and-preserve-cancellation-authority) classifies the old read filename,
extension and session-written-path waiver rules as semantic guesses. Its later,
detailed platform-boundary entries likewise assign platform-path and original
request interpretation to Jev. The declared limits and the obligation not to
turn an unrelated task into unsolicited platform work remain in force.

The actual path is `composeAgentToolRegistry` -> `registerAllTools` -> registered
read projector and existing Agent wrappers, then `executeToolCalls` ->
`PermissionManager.admitAutonomous` -> `ToolRegistry.executePrepared` -> the
wrapped `ReadTool`. The registry is constructed with the same services-owned
manager that bootstrap supplies to the orchestrator. There is no manager rebind
or public admission-mint API.

| Entry | Authority behavior |
| --- | --- |
| Agent main conversation | Opts into `agent-main-conversation` read projection and construction-bound manager ownership; consumes a genuine current admission. |
| Native/session contracts | Retain their existing original-source, captured-input and permission ownership. This slice does not opt every separate member registry into the Agent surface. |
| Direct Agent registry/body calls, copied receipts, callback-only prepared calls | Cannot create the active read proof; no admitted Agent read body executes. |
| Raw/non-adopted SDK tools | Preserve the legacy callback path. An old embedding manager can still execute a raw tool through the current registry, but cannot thereby acquire the strict read proof. |
| Explanation API | Synchronously reports mechanical shape and that admission is still required. It performs no asynchronous semantic reading and grants no authority. |

No separate authenticated manual main-conversation read bypass was found or
introduced. Tests for forged objects and callback invocation specify the opted-in
SDK binding contract; they are not evidence that model text can execute arbitrary
JavaScript inside the host.

## One owner, from evidence to bytes

1. **Prepare actual subjects.** The registration-owned read projector captures
   the real `ProjectIndex`, canonical root, exact requested paths, validated
   lexical paths, canonical targets, and current resource/parent identities.
   Both an alias and its target become semantic subjects. Their owner-resolved
   relationship is retained for original-request interpretation. A changed
   target cannot be hidden only in a digest. The metadata is detached, frozen,
   descriptor-checked and privacy-inspected before model access. Resource hashes
   contain identities, not file bodies or credential values.
2. **Observe before admission.** The manager's existing scoped recorded port
   obtains fresh per-subject `secrets`, `platform_source` and
   `platform_requested` observations using the same original host goal and
   criteria. Global read-classification caches and tool-authored request prose
   are not admission evidence. Missing recording fails closed. A secret-positive
   or uncertain result excludes `act` under the declared non-secret surface.
   Platform source must be within the original request; uncertainty cannot
   expand scope. These facts constrain the existing common autonomous decision,
   whose recorded lineage includes the observations. They are not a second
   permission system.
3. **Bind one current admission.** Only the manager's private identity map can
   authenticate a recorded `act` for the exact issuer, registry and prepared
   object. The prepared object binds the executor, registration incarnation,
   schema and complete final arguments. The invocation proof is private, tied to
   the exact frozen execution-options and argument objects, and retired when
   the body finishes. Copies, foreign handles, a second manager on a strict
   registry, repeated claims and stale genuine objects cannot fall back to the
   legacy callback route.
4. **Consume without another semantic veto.** The adopted Agent read and
   platform wrappers enforce declared mechanical bounds and current proof only.
   They do not consult path keyword lists, the session-write waiver, fresh
   request prose, or another semantic decision after claim. File count (10),
   offered image modes, maximum image size (5 MiB) and registered schema remain
   enforced. Other Agent wrappers, MCP state and non-read behavior remain in
   their existing composition order.
5. **Recheck at actual access/disclosure.** The existing captured original/view
   `capturedReadAccess` filter, where present, remains before byte access. The
   new checks verify the same index, root and resource identities, combined
   cancellation signals and current admission before access and after awaited
   filtering/extraction. They do not rerun the captured original-owner filter
   after every extraction await. Revoked or cancelled output is withheld.
   No new await lies between the final synchronous path guard and the existing
   synchronous file read.

The common owner still handles `revise`, `defer` and `reject`; none executes the
original read. Operational unavailability, cancellation, failed readiness or
recording failure supplies no `act` and calls no human approval handler. There
is no new retry loop, persistence layer or parallel admission ledger.

## Supported lifetimes and compatibility

Config invalidation advances its incarnation before subscriber callbacks,
including same-value and A-to-B-to-A mutations. Durable-rule, policy and session
grant publication revisions participate in the existing authority frame.
The frame is privately detached and recursively frozen before awaiting Jev.
The public ConfigManager snapshot remains a detached **mutable** copy, preserving
the existing SDK contract. Changing that copy cannot change owner state or a
captured admission.

The actual rule store initializes single-flight. Legacy `init()` retains its
logged/resolved fallback contract; the additive `awaitReady()` reports a retained
thrown load or JSON-parse failure truthfully to autonomous admission. It adds no
schema validation for otherwise parseable malformed rule records; the existing
filtering behavior is unchanged. The production orchestrator
awaits readiness before preparation, and direct admission does so before taking
its frame. Cancellation while readiness is pending causes no judgment or body
execution. There is no hidden retry or initial-generation exemption.

Integrity claims cover supported owner mutations and immutable captures, not
arbitrary in-process mutation of objects exposed by unrelated legacy APIs.
Raw registries remain optionally unbound; strict Agent construction is bound.
Third-party registry overrides must implement the new object/evidence methods if
they replace the registry used by autonomous core. No such override exists in
the checked-in callers.

Filesystem checks are current pre/post snapshots, **not** descriptor-pinned
atomic protection against an external swap precisely during `readFileSync`.
They detect ordinary pending/post-await replacement and canonical alias changes.
`ProjectIndex.reroot` itself has no incarnation: direct A-to-B-to-A reroot outside
the production lifecycle is not separately detected once resource identity is
restored. Do not extend the config/rule/policy/session ABA claim to that case.

## Explicit settings remainder

The original red acceptance commit `5e1e6090` retains the combined read/settings
counterexamples. Newly proposed settings expectations are kept in
`products/agent/src/test/runtime/agent-settings-admission.pending.ts`, outside
default test discovery and never counted as a pass. No pre-existing test was
removed or newly skipped. Existing local and engine settings wrappers are unchanged;
the preferred `settings` -> `agent_harness` route is also outstanding.

Future settings adoption must bind the real set/reset operation, owning tier,
resolved destination and default semantics before the common decision. Declared
set/reset mutation metadata must constrain both plan/read-only and input-only
surface authority, even when a semantic mutation observation is wrong. Local
reset removes an override and may reveal another tier; remote reset currently
sends the captured schema default. Those operations are not interchangeable.

Remote admission additionally needs a reviewed additive config/auth-owner
precondition protocol. Endpoint equality alone does not identify an auth/server
incarnation. The real server must recheck current authorization after body and
ownership awaits, and conditionally commit after reentrant invalidation,
validation and managed-lock callbacks. Cached shared-token revocation fallback
is insufficient for that admitted commit; pairing locking covers only pairing,
not ordinary operator-token or session compatibility. An admitted versioned
envelope must inherently fail old handlers (which ignore unknown fields), with
no top-level legacy key/value fallback after an old-server restart. No credential
values belong in receipts or revisions. Lost dispatch responses require truthful
outcome-unknown handling, not automatic redispatch with a new precondition.

These remote-owner and locking details remain a separate design review and
implementation. This READ slice does not enable a weaker remote fast path or
disable existing manual settings functionality.

## Proof boundaries

`packages/engine/test/authentic-tool-execution.test.ts` exercises identity,
issuer/registry/prepared-object mismatches, replay, callback compatibility,
post-claim cancellation, owner ABA, immutable capture and readiness.
`products/agent/src/test/runtime/agent-read-admission.test.ts` uses the actual
Agent composition with recorded synthetic judgment I/O: authoritative outcomes,
novel harmless/secret paths, secret uncertainty, original-request platform
scope, canonical aliases, direct/forged calls, post-await revocation/cancellation,
first-turn initialization, privacy and non-authoritative explanation.

Existing permission, projection, captured original/view, read, cancellation,
explanation and legacy settings tests remain part of focused qualification.
Synthetic results establish control flow and enforcement; they do not establish
live semantic accuracy, provider calibration, connected-service parity, a fresh
whole-repository test pass, or deployment.

## Local qualification, 2026-10-08

The implementation/test checkpoint is
`e78c3407fba00932d229dd00a7702ed5e0ddc142`, tree
`b676185a6797b29654694ec3d6f3b802833c9d71`, based on frozen
`ca12e5a826b6a899492a7a614481e0c8b4d7c159`. The expected public subpath snapshot
is committed separately at `0646aae9`; it changes 25 existing/new symbol records
(9 additions, 16 declaration changes), with no symbol removals. Root, embed and
terminal API rollups are unchanged.

- Final engine focused suite: **407 passed, 0 failed**, 17 files, 2,460 assertions.
  Covers authentic execution, autonomous admission/choice projection, input
  projection/ingress, config invalidation, permission persistence/scope/snapshots,
  gate policy/registry/privacy, captured original/view boundaries, real native
  agent admission, versioned reads, read-deny propagation and credential reads.
- Final Agent focused suite: **167 passed, 0 failed**, 8 files, 1,208 assertions.
  Includes all 30 actual-composition READ cases, conversational capture, the
  retained session ledger cases, agent tooling, explanation posture, permission
  cancellation, real exec-wrapper cancellation and unchanged legacy settings.
- `bun run build`: engine and all four product builds passed. The WebUI generated
  contract/snapshot check also passed; its existing chunk-size warning remains.
- `api:check`, `contracts:check`, `exports:check`, `subpath:declared:check`,
  `products:check`, `judgment:lint`, `credential-scope:check`, `error:check` and
  `any:check` passed. API Extractor reported its sql-js duplicate declaration and
  gaxios fetch compatibility warnings plus the bundled TypeScript-version notice;
  they were not suppressed or treated as a clean compiler run.
- **Type qualification is composed, not a fresh green full-command claim.** The
  last full `typecheck` command at `6585bb41` passed all nine product projects and
  the standalone consumer type tests, but failed one newly added engine-test
  assertion's optional indexed type. The only subsequent source/test change,
  `e78c3407`, obtains that expected value through the typed canonical getter.
  Incremental engine and Agent test-project preflights then passed with no
  diagnostics. Products subtree `05e494425aaf2d923ca4abf741c41fb9976542ec` and SDK
  subtree `839c0718d60b2fc4f4d25dd808a1f21759a0aabb` are identical at both revisions.
  Earlier failures remain part of the record: the authenticity predicate's
  `never` narrowing was repaired by a boolean return type, and the pre-existing
  mutable-copy snapshot test caught and reversed an accidental public freeze.
- Independent source review cleared the authentic lease, actual Agent issuer
  binding, canonical aliases, readiness and the compatibility repairs. The
  review's captured-filter, malformed-rule and filesystem limitations are
  retained above. No live provider, real credential or live setting was used.

This maps only the inventory's `agent-read-policy.ts` HOIST obligation. The
platform guard's read branch is the required adjacent adaptation; its write/edit
branches and the full tool-policy guard/types remain outstanding. Historical
[`source-reconciliation.json` preserved in Linear](https://linear.app/the-artificery/issue/TA-63/port-the-redesigned-agent-and-preserve-cancellation-authority) recovery hashes and materialization records are not
rewritten as current implementation evidence. The current baseline partition
removes only this adopted source from unresolved accounting and counts the new
bounded mapping once; other pending labels and partial feature claims remain.
The new mapping and this checkpoint supply the current bounded record.

The complete repository test aggregate and connected/live calibration were not
run. Previously recorded canonical environment/timeout caveats elsewhere in the
product records remain in force. This local result does not qualify a later
integration/rebase or authorize publication, deployment or settings migration.
