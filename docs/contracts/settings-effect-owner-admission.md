# Settings effect-owner admission

## Prepared producers

The registered `settings` set/reset actions and `agent_harness` set_setting/reset_setting modes prepare the actual effects before the common PermissionManager decision. They no longer depend on `confirm` or `explicitUserRequest` as authority, and the preferred wrapper no longer clones arguments into a second tool body. Read/list operations and the separately provisioned import flow retain their existing behavior.

Preparation resolves the exact catalog key and coercion, validates the complete semantic effect through the privacy boundary, and captures the actual owner:

- Registered host boolean settings use the real ConfigManager host schema, managed-policy check, and physical project/global destination plan.
- Ordinary local settings retain local set versus remove-override reset behavior.
- Wake enablement captures both rows before admission. The same owner advances one exact configuration incarnation and checks the original authority again before each captured publication.
- Empty secret-backed values and resets capture an exact physical-scope deletion plus configuration mutation. They do not call the legacy cross-scope credential-revocation sweep. The secret owner captures candidate-store and keyfile observations, prepares encrypted payloads without generating or migrating key material, acquires the existing writer locks, and revalidates before publication.
- Daemon settings use the installed client's prepared owner capability when installed. A missing capability refuses; it never falls through to an unbound legacy writer. Discovery-only callers retain the pinned HTTP precondition path. Remote reset sets the serving schema default.
- Raw credentials remain refused before hosted judgment, including credentials supplied through a setting alias. Secret references remain opaque. This does not turn inline raw credentials into ordinary admitted tool arguments.

## Lifetime and receipts

The registry's exact options/arguments body proof is consumed once. A presentation record or caller-authored confirmation cannot create it. Async secret-store acquisition retains the original source/config/route restrictions. ConfigManager's only exemption is the authentic prepared mutation's exact +1 transition; there is no generic invalidation suppression window. A compound plan cannot reenter its own finish method.

Secret deletion has a one-use lock-scoped finish capability and a restriction-only completed-effect fence. The fence binds the original policy, exact generation transition, and original file observations updated only by known publications. A settlement callback that replaces credentials, changes the source, or cancels prevents the remaining config effect.

Installed-client replacement includes an installation incarnation, so A→B→A replacement retires preparation. Catalog replacement and config/rule revisions are checked. The existing generic AutonomousToolSource contains snapshot content rather than an independent source incarnation: source changes/revocation are covered, but an unobserved plain-object A→B→A source change is not represented as generic source-ABA protection here. Native callers require their actual owner lifetime guard.

Receipts preserve committed paths and partial/unknown outcomes. Response loss is not retried and does not trigger local fallback. Local readback never repairs a file or changes a committed result into a no-effect refusal. A whole-turn cancellation still terminates the outer orchestrator; the owned settings operation returns its actual partial receipt before that termination. Per-call/registry receipt tests exercise that distinction.

This is same-owner admission and exact captured effects, not a new cross-process configuration-file CAS protocol.

## Verification

All tests use synthetic local homes and recorded synthetic judgment I/O. Remote transport coverage uses owned loopback fixtures, never a live account/provider.

- Actual registered preferred settings/harness producer and compatibility tests cover act/reject/defer, false mutation readings and write-deny policy, read-only operations, no human permission callback, forged/copied/replayed admission, config and rule ABA, source revocation, alias/coercion replacement, host settings, raw-secret alias privacy, compound wake cancellation, scoped secret deletion and post-secret revocation, installed remote lifecycle, remote default reset and response loss.
- Config/secret owner regressions cover one-use handles, cross-owner/copied handles, retained finish closure expiry, keyfile/store ABA, completed-deletion replacement, reentrant compound finish and same-owner interleaving.
- Retain canonical goodvibes_settings regression coverage.

## Committed scope and configured source ownership

Preferred settings and harness tools prepare complete effects before canonical admission and consume exact one-use local or connected owner capabilities. Compound operations retain each owner's allowed transition, reject intervening config/rule/client/credential replacement, and return truthful partial or unknown outcomes without replay. Secret deletion handles the exact owning scope, encrypted/legacy envelopes and keyfile incarnation; it does not silently delete an inherited source or create/migrate credentials. Later replacement cannot erase a genuinely committed receipt, but it makes verifiedInOwningStore false.

Remote settings bind the installed client, endpoint/auth/connection incarnation, server configuration and credential owner. Validate the remote destination through source-isolated tests and actual owned loopback client/server tests, without changing local configuration. Generated transport metadata is excluded from semantic decision facts; real destinations/effects remain included. Generic plain-object source A→B→A without an owner incarnation is not claimed as solved; native ledger source guards are separately owned.

Configured Discord uses authenticated account identity, an explicit immutable channel scope and exact credential alias/tier/pending-mutation snapshots. Read leases and poll publication recheck current ownership. Optional tagging uses the real root admission owner and rejects foreign rows, changed credentials or retired catalogs. The fixed-origin HTTP transport and source-screening ownership stay authoritative. A bot's historical DM list is not inferred from READY, outbound defaultChannelId or missing API endpoints. Synthetic tests do not establish live provider/account acceptance.

Retain exact modern-encrypted, legacy-envelope and keyfile-incarnation/ABA tests,
actual installed-client/dial lifecycle and server preconditions, alongside local
config/scoped secret owner tests. Source changes must be checked through real
SDK/daemon SDK declarations, public consumer and Agent source/test types, public
API extraction, generated artifacts and applicable ordinary gates. These
validation requirements do not claim a test run, release or live-account proof.
