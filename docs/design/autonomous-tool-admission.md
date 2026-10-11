# Autonomous tool admission vertical

Scope: the primary orchestrator path. Each product caller must establish its own
autonomous admission binding.

## Shared entry point

Native consumers import `decideAutonomousTool` and its input/result/source/choice types from `@goodvibes-jev/engine/sdk/platform/permissions`. This is the same selector the real manager uses. A native caller supplies its actual recorded port, host binding/evidence, legal choices and deterministic current-authority guard. The selector does not mint native capabilities or supply a durable execution claim; that remains the caller's owner-held boundary.

## Real path

`executeToolCalls` uses the actual `PermissionManager` and `ToolRegistry` to prepare, admit and execute an owned action. Preparation performs the existing argument repair before admission, then checks the registered schema and freezes the resulting complete arguments. No repair occurs after the decision. Registration identity and schema revision are checked again before the exact executor receives those arguments. Metadata inspection accepts prototype data methods (including real class tools), rejects accessors/proxies without invoking them, and uses callback-free final checks and captured invocation intrinsics.

`PermissionManager.admitAutonomous` binds the full host-supplied original goal and ordered criteria, refuses missing/malformed source context, and rejects source changes before execution. It captures current permission configuration, grant/rule data, surface, project scope and untrusted-source exposure. Host callbacks are staged before the coherent owner frame. The real ConfigManager supplies getAutonomousPermissionSnapshot; legacy readers without that coherent seam cannot grant autonomous execution. Borrowed authority metadata rejects executable accessors/proxies. Its scoped recorded port rechecks that authority before every transport attempt, including argument-repair calls. It does not implement transport retry; the shared judgment port owns temporary-unavailability backoff and lifetime/caller cancellation. Missing/failed recording is an operational failure, never a semantic answer.

The gate's named risk/boundary readings and settings-specific observations remain evidence, with their actual recorded call IDs included in the final receipt. A separate recorded Jev question selects a legal autonomous outcome. Explicit refusals constrain the available choices; an allow preset, remembered grant or legacy `confirm`/`escalate` never becomes the new semantic answer. The first slice uses the existing high-stakes choice confidence band for an act candidate. A weaker candidate gets one further Jev question over actual non-executing options. This does not redefine the legacy critical band's `actAt: null`. Live calibration of the new question remains required; the offline fixtures do not supply it.

- `act`: carry a validated THE-116 receipt, current binding and real call lineage to execution. After the final reentrant hook, revalidate, durably record the claim note and atomically consume the in-process single-use claim before calling the exact prepared body.
- `revise`: choose only an offered host alternative. Prepare its arguments, privacy/schema check them, and obtain a fresh bound decision. A logical call can consume each initially offered revision once; it cannot mint an endless series of alternatives.
- `defer`: return the receipt without running the body. The manager's source-revision condition prevents repeated unchanged admission from becoming act; offered host conditions resume only after their selected version changes. A per-source pending reservation and admission epoch prevent concurrent or superseded decisions from claiming the same action; a changed source enters a fresh decision. Other host conditions must also resume via fresh admission.
- `reject`: return the receipt without running the body.

The decision log stores the typed semantic receipt as a reading note and the actual outcome/claim notes. Permission audit and returned tool results carry the same receipt. The real interactive caller supplies its original turn text. A bound session contract supplies Contract.ask and ordered top-level source quotes (owner-authored criteria retain their text) through a live actionSource hook; missing or retired source ownership is refused, with no unit-brief or empty-criteria substitution. No human handler is called by this migrated path, even when a legacy handler is installed on the manager.

The public selector captures borrowed binding, evidence, choices, state and call lineage before awaiting the recorded port. Typed registry references are structurally validated and frozen; canonical UUID/SHA identity encodings are not reinterpreted as raw payment-card text. This exemption does not apply to original goals, ordered criteria, arguments, proposed revisions, or arbitrary fields labelled as metadata. Those retain complete pre-transmission inspection. Other reference text still crosses the privacy boundary, and explicit credential field syntax is protected regardless of casing.

## Bounds and remaining migration

The source claim protects duplicate delivery within this permission runtime. It is not cross-process exactly-once execution or a durable crash-recovery queue; contract start idempotency has its own tracked owner. Claimed sources are not evicted into renewed authority. Claim/deferral capacity exhaustion is explicit. Deferral does not authorize delayed execution or silently subscribe to an invented condition.

The retained `checkDetailed`/`check` API and old duck-typed embedding managers remain compatibility callers. Their callback-era fixtures are labelled explicitly; autonomous executor fixtures separately preserve exact-command case/whitespace scope, same-class isolation, live deletion and post-decision revocation. External native-work criteria-array provenance beyond the existing contract source records, nested tool wrappers, sandbox/PTY prompts, settings capability consumption and other product-specific callers each require a binding to the common current claim. Intercepted-tool controls alone do not establish those bindings, native inbox dispatch, provider calibration or live deployment.

The [Agent main-conversation READ adoption](agent-read-autonomous-admission.md)
is a bounded consumer: it binds actual canonical/alias subjects and the
construction-owned manager, gathers non-secret/requested-scope evidence before
this same decision, and consumes current proof through the real wrappers and
byte reader. Its private execution lease does not change raw legacy callback
authority or establish admission for non-read wrappers.

No source summary, old approval token, arbitrary model-generated prose, stale receipt or unknown continuation grants execution. Protected input is rejected locally before preparation/model access. Tests intercept every tool body and inject all model/transport responses; no fixture executes a shell payload or contacts a provider.

## Proof

The failing-before fixture used the real old manager/registry/orchestrator with no human handler: named Jev readings completed, but the old path synthesized `user_prompt` / `user_denied`. `packages/engine/test/autonomous-tool-admission.test.ts` now exercises the same actual path and adds recorded outcomes, repair-before-admission, immutable execution input, revision, deferral, replay, exact grant scope/deletion, final-hook cancellation/revocation, tool replacement, central outage recovery and cancellation, and pre-admission repair retry revocation.
