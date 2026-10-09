# Agent SETTINGS admission

Status: locally qualified candidate, awaiting hosted review/CI. This is
the separately reviewed SETTINGS follow-up to the frozen Agent READ slice.
It has not been published as part of the four-line HTTP auth repair in PR #201.

## Scope and existing contracts

The adopted entry is the real Agent main-conversation `goodvibes_settings`
registration in `composeAgentToolRegistry`. `set` and `reset` use the existing
recorded PermissionManager decision and registry execution claim. There is no
human semantic approval callback, caller-authored request waiver, second
settings-hazard veto, or parallel admission service.

The existing persistence contract remains whole-file last-writer-wins
(`utils/atomic-json-store.ts`). ConfigManager already describes daemon batch
writes as non-transactional across tiers and concurrent processes. This change
binds the actual serving owner and its supported lifetime/publication changes;
it does not introduce cross-process configuration CAS, global writer locks or
an atomic filesystem guarantee against arbitrary external edits.

Legacy ConfigManager setters, raw SDK tools, manual `{key,value}` HTTP requests,
the connected `config.set` route and legacy policy helper exports retain their
contracts. A strict Agent call cannot fall back to those interfaces when its
admission, route or remote precondition is absent or stale.

Other tool compositions, including engine agent/contract registries and hosted
sessions that do not install the main-conversation flag, remain on their
existing paths. Preferred settings/harness and the originating-surface
`clientOwnedStore` effect set remain separately outstanding. Installing the
strict main-conversation flag with such a redirected store holds the operation;
it cannot borrow the hosting manager's authority for a different file. Context,
MCP, write/edit and unrelated tool policies are unchanged.

## One decision, exact effect

1. The registered settings projector captures immutable arguments and resolves
   the actual local or remote owner. Route discovery is non-mutating: no stale
   runtime-record reaping or quarantine is hidden before admission. The capture
   binds normalized value or the actual reset effect, schema, ordered
   destinations, owner identity and current route observations.
2. Declared credential previous values become configured/redacted posture
   before observation. The complete ordinary previous/proposed value and exact
   source/effect cross `snapshotJudgmentInput` before any recording, hashing or
   semantic redaction call. Intended credential values and reset defaults are
   separately protected; a posture projection cannot make an inline credential
   write admissible. Secret references are never resolved.
3. The same recorded/current port collects hazard, original-host-request and
   necessary value-display evidence before the common decision. Caller
   `explicitUserRequest` text cannot replace the host source. Supporting reads
   have recorded decision IDs. There is no post-claim semantic read.
4. Registered `set`/`reset` facts impose a mutation floor on surface authority,
   plan/read-only exclusion and explicit policy classification. Semantic
   `mutates:false` cannot make these operations reads. Stronger network,
   destructive or escalation evidence remains stronger. Declared schema,
   privacy, read-only and managed-policy constraints remain fail-closed.
5. The authentic admission binds the same PermissionManager issuer, exact
   registry/prepared call/executor, immutable args/options and closed backend
   evidence. Copied admissions, alternate managers, callback-only calls,
   mismatched handles and replay do not authorize the strict body. Legacy raw
   embeddings retain their callback path without acquiring a strict proof.

The public READ `ToolAdmissionEvidence` and its accessor retain their original
shape. Settings adds a separate closed evidence field; the common owner reads
both variants through an additive combined accessor. No writable grant state is
exposed by this compatibility distinction.

## Local ConfigManager transition

ConfigManager owns private prepared-mutation and transition handles. Preparation
is not a grant. It normalizes and validates without recovering malformed stores,
then binds exact set/remove destinations and the existing incarnation.

`beginPreparedMutation` advances that incarnation before the existing
invalidation subscribers and validation work. The registry retires the active
invocation before begin, preventing reentrant reuse. After begin and route
sampling, PermissionManager accepts only this exact handle's private expected
pre-value transition. It rechecks source, scope, policy, rules, session grants,
signal and owner frame. A nested mutation, failed/no-op mutation, `save` or
`saveProject` invalidates it. The two save methods advance the existing counter
without adding new subscriber callbacks.

Final ConfigManager checks use strict, non-mutating store and managed-policy
reads. The synchronous persistence tail uses the existing atomic writer with
opportunistic stale-temp cleanup disabled. No model call, await or user callback
lies between final checks and publication. There is no recursive invocation of
public setters to accidentally waive multiple own-generation changes.

Set preserves actual global/project/shared/daemon ownership. Ordinary local
reset removes the applicable overrides, retaining existing project-overlay
semantics; registered host reset preserves its distinct restrictive/default
scalar writes. Ordered multi-file reset is not an invented transaction.
Receipts identify completed replacements and an uncertain destination when
needed. A failed later file reports partial/unknown, never false rollback.

The actual effect receipt is formed before notifications. Postcommit
revocation, cancellation, subscriber failure or a competing write cannot turn
an already completed publication into a no-effect claim. Readback is reporting,
not reuse of the spent permission.

## Remote owner-current protocol

The existing `POST /config` handler adds exact nested version-1 capture/apply
envelopes. They contain no legacy top-level `key` or `value`. An old server thus
rejects them even if it replaces a newer server after capture; malformed, mixed
or unsupported envelopes never downgrade to legacy writes.

Capture returns an opaque reference, exact normalized effect facts and expiry.
The reference is an owner-current precondition, not a Jev permission grant.
The client still needs its authentic common admission; the server still needs
its current existing admin authority. References are bounded to 256 and five
minutes, spent on one apply attempt and never refreshed automatically. The
stateful protocol owner belongs to the actual DaemonHttpRouter, surviving its
per-request handler/context construction. Stop/rebind/token replacement retires
the serving epoch before callbacks/awaits. Endpoint/token equality alone is not
an incarnation.

Normal shutdown and update/rollback handover share `stopRuntime`, which retires
the epoch and fences `enable` before synchronous lifecycle abort callbacks.
Repeated stops still join pending handover work. If `beginStopping` throws
before resource teardown, the prior teardown flag is restored so cleanup can
be retried, while the epoch remains retired. `enable` can rotate a live epoch
and token but cannot reopen a null epoch; a successful start establishes the
next serving lifetime.

Shared/paired authority uses the pairing owner's existing strict lock and fresh
persisted observations. Sessions bind the exact session and user, roles and
expiry. Actual initialization, recovery, parse, read and persistence faults
observed by the serving auth owner hold the strict path. The actual user-store
load reports recovery even if a prior preflight was clean. The pairing constructor
uses its successful strict parsed observation as its actual initial snapshot;
it does not perform a second recovery-capable load after that observation.
Legacy fallback behavior remains available separately. This is an actual-lifetime guarantee,
not reconstruction of arbitrary discarded revocation history from a previous
process or uncooperative external writer.

The server reacquires current admin authority after body parsing. Apply begins
the prepared ConfigManager mutation, then checks auth, owner transition,
lifetime and expiry after reentrant work, immediately before synchronous
publication. No semantic decision is made under the auth lock. The HTTP route
remains directly admin-gated; no fictional GatewayMethodCatalog dependency is
introduced.

Remote reset retains the established operation: set the serving schema default.
It is not converted into local remove-override reset. The client pins the
resolved endpoint, private credential, reference and effect. It does not
redirect, rediscover, select another host, write locally or retry after dispatch.
Lost/malformed acknowledgments report unknown with the invocation spent.
Client authority and cancellation are current at dispatch; cancellation after
the apply request is sent cannot undo a remote publication or prove no effect.
The serving owner still checks its current auth, config and lifetime before writing.
Strict receipt validation rejects inconsistent committed/partial/unknown paths.
Credentials and credential-derived hashes do not enter facts, receipts or logs.

Route assertions check supported current inputs and observed runtime-file
identity, including arrival after an absent-daemon capture. A callback-provided
route that changes A-to-B-to-A without exposing a publication revision, or an
unrecorded port arriving externally, is not claimed to be globally detectable.

## Truthful readback and explanations

After committed publication, local and remote owners strictly reread only the
captured effect files. Remote acknowledgment adds only a verification boolean,
never a raw credential or a substitute local cached value. Changed/unreadable
readback remains committed but unverified. It does not quarantine, repair,
redispatch or obtain new permission. Captured current values are shown only
when verified, using the pre-admission display observation; credential values
remain posture-only. This is a readback snapshot under existing LWW semantics.

The Agent explanation path checks mechanical shape and states that current
recorded admission is still required. It performs no semantic request, grants
no authority and does not treat a pending promise as a denial string.

## Qualification record

The latest runtime/API checkpoint is `97ed8774`, tree `9b64b6cf`, composed on
actual main `5dae9807`, tree `9ef62a08`, after PR #218 removed the optional
Verdaccio lane. Exact-tree review preserves all 24 removal-change paths,
including all 15 deletions. The corrected SETTINGS source is independently
reviewed; the final generated API adds 16 exports over this main and removes
none. A three-way comparison preserves every non-overlapping export exactly;
the three overlapping DaemonServer entries retain main's private `stopRuntime`
declaration. The original public READ evidence signatures are unchanged.

- Fresh engine and daemon declaration builds passed, followed by engine-test,
  Agent source/test and public-consumer types, API stability, contracts, exports
  and declared-subpath checks. The first Agent type attempt lacked the sparse
  checkout's daemon/testing prerequisite. That failure is retained; the exact
  daemon source was materialized and privately built before the successful
  affected retry. No production source repair or borrowed output was used.
- Terminal focused results total 853 tests across 40 distinct files, with
  4,419 assertions: 289 owner/lifecycle, 9 wire, 228 admission/projection,
  124 config compatibility, 41 built-auth/HTTP and 162 Agent tests. These are
  separate completed groups, not a full-repository runtime command.
- The handover correction first produced three passes and four failures in
  seven controls. Independent review added two failing synchronous-stop controls
  before the retry-ownership repair. The corrected 185-test serving/lifecycle
  subset passes and is included in the 853 total, not additional credit.
- Dependencies are shared immutable installed packages; outputs are private to
  this checkout. This is not a fresh-install dependency proof. Four-product
  builds and the full product type command were not repeated at this checkpoint;
  their earlier source-bound evidence remains historical below.

Hosted exact-head CI, final publication and live calibration remain separate.
The earlier checkpoints below are historical evidence, not current active gates.

The original actual-composition baseline was 5 pass / 11 fail. Reachable failures
included the post-act semantic veto, false read classification, and post-await
or reentrant revocation/cancellation effects. Forgery/direct-call cases specify
the new SDK binding contract; they are not claims of a model exploit.

At the earlier source checkpoint `2d7e9219` (qualification was then in progress):

- Actual Agent SETTINGS and legacy-policy controls: 53/53, 288 assertions
  (38 admission cases plus 15 existing legacy controls), after the final child
  fixture layout and teardown changes.
- Protocol and serving-owner readback: 57/57 pass, 195 assertions.
- Config owner and existing config regressions: 146/146, 603 assertions,
  including the 22 focused prepared-mutation controls.
- Strict auth and existing native-pairing compatibility: 50/50, 297 assertions,
  after both actual-load corrections.
- Selected existing permission, projection, routing and legacy-policy suites:
  228/228, 1,125 assertions across nine files.
- The real Agent/manager/projector/client path is connected to two separately
  dispatched real router requests and real serving config/auth owners. Set,
  default reset, reject/defer, revocation and lost-acknowledgment controls use
  only temporary files and an engine-owned child listening on an ephemeral
  loopback port. Eight such remote controls pass with 58 assertions. Agent
  imports only the public client surface; private auth/router construction lives
  in the engine test helper. A bounded private control pipe owns setup, inspection
  and teardown. No external service, provider or native daemon runtime starts.
- Source-only architecture, no-any, credential-scope, error, judgment and product
  boundary checks pass. The canonical type command passed its solution/engine
  tests and consumer stages, then failed the old fixture's private cross-workspace
  imports before any product type project ran. Those imports are now removed;
  final affected engine-test and Agent-test preflights pass, as do all nine
  product type projects. This is composed component qualification, not a claim
  that the earlier full command reran green.

Later current-main qualification preserves separate receipts:

- `d8f203ea` passed the canonical engine and all four product builds. API
  extraction had the existing TypeScript-version, sql-js and gaxios advisories.
- The declaration-only correction `41ac7e73` restores the exact explicit public
  READ evidence fields. Forced SDK, engine-test, Agent-test and consumer types
  passed; emitted `input-projection.js` was byte-identical. After the disjoint
  merged PR #204 overlay, SDK/API regeneration passed, and the committed
  `a183296d` snapshot passed `api:check` with zero removed exports.
- The subsequent 27-file engine run at `a183296d` has no terminal receipt:
  309 passing lines and three failing wire-fixture assertions were observed
  before its execution session became unaddressable. Its process lifetime is
  unknown; its lock and temporary tree are preserved. The queued Agent run did
  not start. This incomplete aggregate is not a passing qualification.
- The three failures described a legacy handler while importing the current
  factory. Corrected tests use byte-exact legacy handler/helper regions from
  main `59959220`, pinned to source blob `1e3abfb6`. They distinguish legacy 400
  rejection from current unsupported-owner 409 refusal, preserving no-write and
  no-downgrade controls and demonstrating why legacy top-level keys are omitted.
- Fresh validation uses a distinct checkout and private external temporary
  parent, including the verified disjoint merged PR #207 baseline. At
  `07d6daee`, corrected wire controls pass 9/9 (30 assertions), and the config,
  auth, pairing and protocol owner suites pass 129/129 (589 assertions), each
  with an explicit zero-exit receipt. No unknown earlier run was cleared or
  retried.

The earlier qualified source checkpoint `6fd0ae6e` also preserves the four disjoint merged
PR #208 paths. Its reconstructed main baseline is commit `29b02ffa`, tree
`1806cee3`; no main path was replaced by an older SETTINGS preimage.

- Terminal focused engine results: 531 tests across 27 files, in separate
  groups (129 owner controls, 9 wire controls, 228 admission/projection controls,
  124 config compatibility controls, and 41 built-auth/HTTP controls).
- Terminal Agent results: 162 tests across 9 files, including real READ and
  SETTINGS composition, legacy helpers, registration, settings ownership and
  non-authoritative explanation controls.
- A fresh canonical engine and four-product build passed using only this
  checkout's outputs. The built-auth controls ran against those new artifacts.
- Final engine-test, Agent-test and consumer types passed, followed by API,
  contracts, exports, declared subpaths, product boundaries, architecture,
  credential scope, errors, no-any, judgment registration and docs checks.
  Type qualification remains honestly composed with the earlier nine-product
  project gate and independently qualified merged baseline changes; no fresh
  full type-command or full-repository runtime pass is claimed.

These final gates have explicit zero-exit receipts. They do not establish the
old interrupted process's lifetime or retroactively qualify its partial log.
Hosted exact-head CI and final publication checks remain separate.

Independent source review cleared the original owner/adoption boundary through
`d7e8dd51` and the final readback, auth and child-fixture delta through `2d7e9219`.
Current-main composition, the READ declaration-only correction, and the pinned
legacy-fixture correction received separate source review.
Full-repository runtime testing and live semantic
calibration are not claimed. Scripted, recorded Jev answers prove ownership and
effect-path behavior, not live model accuracy or calibration.
