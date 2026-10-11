# Agent SETTINGS admission

Scope: SETTINGS admission through the Agent, shared permission owner and serving
config/auth owners. READ admission has its own consumer contract.

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

## Validation requirements

Preserve the public READ evidence signatures and every non-overlapping public
export when composing declarations. Validate engine and daemon declarations,
engine-test, Agent source/test and public-consumer types, all product type
projects, API stability, contracts, exports and declared subpaths. Product builds
must use their own source-bound outputs; sparse fixtures must materialize and
build prerequisites rather than borrow unrelated output. Shared installed
packages do not establish fresh-install dependency behavior.

Focused suites cover config/auth serving owners and lifecycle, wire protocol,
admission/projection, existing config compatibility, built-auth/HTTP and actual
Agent READ/SETTINGS composition, legacy helpers, registration, settings ownership
and non-authoritative explanations. Handover and synchronous-stop controls must
exercise retry ownership. Preserve counterexamples for post-act semantic veto,
false read classification and post-await or reentrant revocation/cancellation.
Forgery/direct-call controls specify SDK binding; they are not model-exploit claims.

The real Agent/manager/projector/client path must connect to two separately
dispatched real router requests and real serving config/auth owners. Set, default
reset, reject/defer, revocation and lost-acknowledgment controls use temporary
files and an engine-owned child on an ephemeral loopback port. Agent imports only
the public client surface; private auth/router construction belongs in the engine
test helper. A bounded private control pipe owns setup, inspection and teardown.
No external service, provider or native daemon runtime is needed.

Legacy compatibility controls use byte-exact legacy handler/helper regions,
separate from the current factory. They distinguish legacy 400 rejection from
current unsupported-owner 409 refusal, preserve no-write and no-downgrade
behavior, and demonstrate why legacy top-level keys are omitted. Public READ
field declarations must remain explicit; declaration-only repairs must not alter
emitted runtime behavior. Run built-auth controls against newly built artifacts.

Keep architecture, product-boundary, credential-scope, error, no-any, judgment
registration and documentation checks alongside source/test/consumer type gates.
Component qualification is not a substitute for a fresh full-command result;
interrupted logs cannot establish a terminal pass or process lifetime. Full
repository runtime tests, exact-head hosted CI and live semantic calibration are
separate validation boundaries. Scripted recorded Jev answers establish ownership
and effect-path behavior, not live model accuracy or calibration.
