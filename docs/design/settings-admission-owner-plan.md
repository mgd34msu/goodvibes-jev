# SETTINGS admission: existing-owner plan for review

Historical design record. See [the implementation contract](agent-settings-autonomous-admission.md)
for the current same-owner behavior. The future-tense seams below describe the
proposal at its design boundary.

## Bounded entry and compatibility

The first adopted caller is Agent main-conversation `goodvibes_settings` (set or
reset only). Its actual write path is `createGoodVibesSettingsTool` ->
`applyRoutedConfigWrite` -> `applyConfigWrite` -> local ConfigManager or HTTP
`POST /config`. `buildAgentConfigRouting` supplies a connected **read** callback,
not a connected writer. Product `routeConfigWrite` / `DaemonConfigClient.set` and
preferred settings/harness remain separate. No WS method/schema change is needed
for this first HTTP lane; a future connected conditional method would share the
same owner service without replacing legacy `config.set`.

Legacy direct ConfigManager, raw SDK settings, manual `{key,value}` HTTP and
connected `config.set` interfaces remain available. Strict adopted settings must
not fall back to any of them after missing, stale or unsupported admission.
Mixed-version failure is an explicit operational hold, never an unconditioned
write or human semantic approval prompt.

`runtime.workingDir` is not a ConfigKey and is rejected by this tool before
routing. Its separate manual workspace-swap handler is not an effect this slice
must pretend to bind. Declared credential keys remain usable for the reference
and clearing forms already admitted by the existing privacy boundary; there is
no blanket key ban.

## Actual source constraints

- `config/manager.ts:337–363`: set requires writable, advances the permission
  incarnation, calls invalidation subscribers, coerces/validates and reads the
  managed lock, then assigns. A wrapper compare before setDynamic is too early.
- `config/manager.ts:970–1009`: local reset removes the surface override and can
  additionally remove daemon/shared overrides. It is not set(schemaDefault),
  nor an existing atomic multi-file transaction.
- `tools/goodvibes-runtime/index.ts:244–274`: remote reset currently sends the
  schema default; local reset invokes reset(key). Keep these physical operations
  distinct in the bound plan and outcome.
- `config/settings-io.ts:29–45`: raw persistence reads can quarantine malformed
  files before the nominal write. Preparation must use a strict non-mutating
  read, not this recovery helper. No quarantine can precede admitted effect.
- Managed-lock reads also recover/quarantine through `readStore`, and malformed
  state can become an empty lock list. The existing non-mutating
  `readHostManagedSettingLock` is the strict owner seam to reuse for admitted
  capture/commit. Unknown/unreadable policy cannot mean unlocked.
- `writeFileAtomic` performs stale-temp cleanup; quarantine can reap old corrupt
  files and write companion receipts. These are extra effects. The admitted
  path must explicitly omit/defer opportunistic recovery/cleanup or bind their
  effect set. A nominal final rename guard alone does not cover them.
- `tools/goodvibes-runtime/config-routing.ts:218–239`: hosted clientOwnedStore
  writes directly through persistSharedKey. A redirected file is a distinct
  effect destination; it must not bypass a declared read-only owner or borrow
  another surface's ConfigManager identity.
- `config/daemon-config-route.ts:319–370,422–442`: discovery/probing can change the
  route before dispatch. It can also reap stale runtime records. A prepared
  admitted route must be captured after resolution and cannot silently select
  a new owner later; housekeeping during preparation must be non-mutating or
  separately deferred, not hidden before admission.
- `daemon-sdk/src/system-routes.ts:222–238`: current admin check is before the
  awaited body parse. New conditional requests must reacquire current authority
  after that await and again at the final owner commit.

## Proposed minimum dataflow

Names below describe seams, not approved public API signatures.

1. The registered settings projector captures exact operation/key, normalized
   value or reset default, schema identity, ConfigManager identity, full ordered
   effect destinations and routing facts. Facts come from the actual backend
   and are detached/frozen before admission, never from caller booleans. Value
   coercion must be reflected in the proposed action, not discovered after Jev
   approves a different value. Any subsequent repair changing the effect needs
   a fresh capture and decision.
2. Finish credential/redaction observations and route discovery outside any
   final mutation lock. Declared credential fields use existing exact ownership
   metadata and redacted configured/source postures; never resolve secret refs.
   Other existing value-redaction observations must finish before admission via
   the same scoped recorded port. Previous-value lookup, precondition acquisition
   and readback use the same actual resolved HTTP owner, not an independently
   connected readDaemonSnapshot. No raw persisted credential reaches judgment,
   receipts or logs.
3. Extend registration-owned admission evidence with a closed settings operation
   record. Its set/reset mutation fact drives BOTH preset readOnly exclusion and
   runBoundary surface authority; a false semantic `mutates` cannot lower it to
   read. Semantic outward/send evidence can still raise the effect. Hazard and
   requested-effect observations use the original host source plus the resolved
   effect plan before the existing common Jev decision. No post-claim semantic
   veto, arbitrary explicitUserRequest waiver or approval callback.
4. The existing authentic manager/registry execution record binds the exact
   prepared settings plan and issuer. Wrappers consume only that active proof;
   direct, copied, reused, mismatched and callback-only calls cannot create it.
5. ConfigManager remains the mutation engine. Add a branded prepared-mutation
   handle owned by it, containing no grant. An internal begin-commit step does
   its existing invalidation and validation work, then exposes an opaque exact
   transition for this prepared operation. Only its own expected g -> g+1
   transition, with unchanged pre-effect permission values, may be recognized
   by the already-bound authentic invocation. A nested mutation (even an ABA or
   failed/no-op mutation), changed schema/managed lock, cancellation, source,
   policy or grant invalidates it. A caller cannot nominate an allowed revision,
   substitute a callback or mint a transition token. The final implementation
   must use ConfigManager's internal mutation primitives rather than recursively
   calling public set/setProjectValue/resetHostSetting and accidentally advancing
   its own generation twice.
6. After all reentrant work, the existing manager validates that one bound
   transition and all other authority fields. The actual effect owner then
   rechecks its prepared store/effect binding and commits synchronously without
   another callback or await. No new standalone mutation engine or parallel Jev
   admission registry is introduced.
7. A committed result retires execution authority. Subsequent presentation or
   readback consumes a truthful effect receipt, never the old grant. Own config
   invalidation must not turn a successful write into a false refusal. Later
   supersession or cancellation cannot retroactively mean nothing was written.
   Multi-file reset reports exact completed files if a later I/O step fails;
   there is no invented all-or-nothing transaction or automatic rollback.

## Remote protocol and actual auth owners

Use an exact nested versioned envelope on existing POST /config, with capture
and apply arms. Neither contains top-level legacy key/value. An old handler
therefore rejects it even if the daemon restarts onto an old version after
negotiation. A new handler that sees the envelope must never downgrade malformed,
unsupported or mixed input to the legacy arm.

The capture result is a bounded/expiring owner precondition reference, not a
permission grant. Its private record binds command, actual config owner,
incarnation, server lifetime, current auth kind and exact credential/session
incarnation and scope. Apply requires the same current authority and exact
versioned acknowledgment. A legacy success response is not that acknowledgment.

Existing owners to extend:

- `PairingTokenManager`: reuse its existing directory owner lock and strict
  persisted read for shared/paired SETTINGS authority. Ordinary isLegacyRevoked
  intentionally has cached-error fallback; do not change that manual API or
  repurpose the native-only capability. Under the held lock, the new seam must
  revalidate without last-seen stamping/reentrant ordinary authentication.
- A genuine ENOENT store is explicitly distinct from unreadable/corrupt state.
  An absent/unrevoked shared-token capture can be bound under the lock plus the
  facade token epoch, preserving fresh setups. Read/parse/durability errors
  cannot become cached false. The only supported shared flag writer sets true;
  no normal un-revoke API exists. No credential-derived hash is needed.
  Constructor recovery is a concrete unresolved edge: it can quarantine corrupt
  state and leave ENOENT without retaining recovery lineage. The strict seam
  cannot then call that genuinely fresh absence. It needs an owner-recorded
  initialization/recovery distinction and fail-closed treatment of recovered or
  unverified absence, while leaving ordinary legacy authentication unchanged.
- `UserAuthManager`: exact current session object/incarnation, current user roles
  and expiry, not username equality. Its synchronous revoke/expiry/eviction and
  password/user changes must be checked after every reentrant callback. No new
  persisted session store or pairing substitution.
- `DaemonServer` facade: invalidate an opaque settings lifetime before stop
  callbacks/awaits and on shared-token replacement and bind/rebind. Endpoint or
  token A-to-B-to-A equality is insufficient.
- The actual HTTP /config path is directly admin-gated; it does not consult
  GatewayMethodCatalog scopes. Preserve that current authority boundary and the
  Agent's upstream declared surface floor. Do not introduce catalog-incarnation
  machinery as if it were already an HTTP dependency. A future WS conditional
  method will need its own catalog/scope binding review.

Order: finish transport/body/redaction awaits; reacquire current authority; enter
existing shared/paired auth lock where applicable; perform ConfigManager's
pre-commit callbacks; final-check exact transition plus auth/session/scope/server;
commit without callbacks/awaits; release. Failed reentrant pairing revocation is
an explicit busy error, not a successful revoke. No model call belongs inside
this lock.

Client cancellation/currentness is checked immediately before dispatch. Once
sent, remote commit may win; response loss, malformed acknowledgment or uncertain
persistence is outcome-unknown. Never refresh/retry, redirect, switch endpoint,
change local/remote destination or fall back to legacy under the spent admission.

## Required same-owner guarantee versus optional persisted CAS

The minimum adoption contract is current **serving-owner** authority and exact
execution binding, not a new globally serializable configuration store:

- `docs/design/autonomous-jev-decisions.md`, Binding and provenance, requires a
  current context, deterministic checks and the existing execution-ledger claim,
  using the owner's existing synchronization mechanism.
- `utils/atomic-json-store.ts:43–50` explicitly describes concurrent persistence
  as whole-file last-writer-wins and says its synchronous write has no in-process
  write lock.
- `ConfigManager.setDaemonValues` (`manager.ts:393–397`) explicitly says its
  atomic replacement is not a transaction across tiers or concurrent processes.
- `ConfigManager.getAutonomousPermissionSnapshot` is the real permission
  manager's coherent live authority frame. It reports that construction-owned
  instance's held state, not a globally synchronized read of every process's
  settings files.

Accordingly the minimum remote reference should be named/documented as an
**owner-current precondition**: exact facade/server lifetime, exact ConfigManager,
its captured incarnation and actual resolved effect destinations. It is not a
persisted-file compare-and-swap receipt. The caller still needs its authentic
same-manager/registry act, and the server still needs its current existing admin
authority. Same-owner invalidation/validator callbacks run before the final
currentness check; the existing synchronous persistence follows without another
callback or await. Read-only, declared mutation, schema, credential and strict
current managed-policy checks remain. Observed unavailable policy/auth data
cannot become an allow. Remote shared/paired revocation uses that auth owner's
existing lock; this does not claim to lock configuration files.

All final checks are against the real current owner, never a caller-supplied
true callback or nominated generation. Only the owner-branded expected mutation
transition can survive its own pre-mutation invalidation. A different serving
manager, endpoint/server lifetime, source/grant/config generation, operation or
resolved destination requires fresh admission. Post-effect output uses the
actual effect result rather than continuing to exercise the old admission.

The persistence semantics remain the existing ones: supported other managers
or file writers can update stores independently, and atomic replacements are
last-writer-wins. A per-instance frame does not retire for a different process's
unloaded write. A final non-mutating managed-policy read does not make external
policy changes and file publication one cross-process transaction. No guarantee
against arbitrary external file edits or globally ordered file-policy revocation
is being added or claimed. Multi-file reset retains explicit partial/unknown I/O
outcomes, never fictional all-or-nothing success. These limits must be visible
in the protocol and qualification, rather than marketing this as persisted CAS.

### Stronger optional guarantee, deliberately outside the minimum

If a future API promises persisted compare-and-mutate across cooperating writers,
then ConfigManager's current counter and final-value hash are insufficient. Every
supported writer must participate in whole-operation ownership/publication
fencing, including set/reset/save/saveProject/category operations, migration and
reader-floor writers, shared/daemon helpers, redirected stores, product
onboarding/rollback and every settings-sync.json writer. Locking only writeStore
would let a stale event/history writer restore old managedLocks. Reset needs a
canonical multi-file order and truthful partial-failure behavior. Publication
incarnations must survive replacement/deletion/rollback/ABA. Existing synchronous
strict lock mechanics can inform that separate work; async/default age-takeover
locking and the best-effort surface home claim cannot supply it.

That broad writer participation is required by the **stronger proposed CAS
contract**, not by a pre-existing promise in the settings source. It is not
approved or bundled into minimum admission adoption. The earlier independent
review correctly held the stronger plan; a new independent review is requested
for this explicitly narrower same-owner contract.

### Remaining strict-auth initialization question

The cached-error fallback cannot be used for admitted auth. Current read,
parse, durability or initialization/recovery failure observed by the actual
serving owner must hold the new path. The record must not rename a recovery
failure to genuine fresh ENOENT. The source currently loses that distinction;
its exact same-owner readiness seam remains to be reviewed. A further promise
to reconstruct previously lost shared revocations across restart/external store
replacement requires durable lineage and is not established by a new in-memory
bit. Do not conflate this unresolved auth question with a need for global config
CAS, or silently weaken the current-auth requirement to make it disappear.

The four-line HTTP await-window repair is independently cleared in a separate
checkout. It does not enable the proposed adopted settings path.

## Test-first evidence plan

The test design covers these source-owned boundaries:

- Agent actual-composition suite promoted from the preserved pending settings
  spec, with added reentrant invalidation/cancellation and truthful own-commit
  controls. Existing failures distinguish semantic veto, plan/surface mutation
  misclassification and post-await revocation from new SDK authenticity tests.
- Actual old /config parser controls prove nested capture/apply cannot carry the
  old top-level key; legacy manual compatibility stays visible. Mixed-envelope
  refusal explicitly specifies the proposed parser contract, not an old promise.

After owner review, add synthetic owner-level tests for validator/managed-lock
reentrancy, exact transition mismatch/reuse, config/store ABA and second-manager
writers, multi-file reset failure boundaries, readonly redirection, per-tier
reset semantics, route changes during probe/body waits, paired/shared persisted
revocation/read errors/lock contention, absent fresh stores, exact-session
revocation/expiry/replacement, server restart and token ABA, strict old-server
rejection, one dispatch under response loss, and credential-free artifacts.
No live service/provider, real credential or production setting is needed.

## Independently bounded HTTP fix

The existing admin-after-body-parse window can be fixed without the unresolved
conditional protocol. Retain the first requireAdmin; return a parser Response
unchanged; after successful body parsing, reacquire requireAdmin on the same
request before interpreting the key or dispatching either config or workspace
work. This preserves supported legacy payloads and current auth behavior.

`daemon-config-current-auth.test.ts` drafts the actual-handler/real-auth-owner
red controls for shared and paired revocation, session/cookie revocation and
expiry, user deletion, shared-token replacement, unchanged authenticated
success, initial non-admin refusal, malformed-body response and pre-workspace
dispatch. The setting effect is intercepted; no socket is opened. This bounded
two-check ordering does not establish strict persisted shared-error handling,
mutation-callback currentness, server incarnation or persisted CAS. Those belong
to the conditional SETTINGS protocol rather than the ordinary HTTP auth repair.
The actual-handler controls require no real credential or live service.
