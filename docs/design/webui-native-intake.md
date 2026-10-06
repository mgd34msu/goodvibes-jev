# WebUI original-source admission

Work → New → Native request uses the existing authenticated
`workLedger.intake.capture/get/admit/resume/cancel` routes. One deliberate Submit
captures the original text and immediately invokes Jev admission. There is no
separate human Admit/Approve gate, browser semantic classifier, browser model
client or outage fallback. The shared Jev transport retains retry ownership.

## Source and identity

The browser preserves the textarea's complete original value, whitespace,
Unicode and repeated requirements. It never trims, expands files, normalizes
quotes, generates criteria or supplies a source revision. Explicit unread
file/image/context markers accompany the text. Unsupported and missing context
remain the daemon's blocked/refused dispositions.

Before any intake POST, a strict-durability IndexedDB transaction commits an
immutable original command with distinct request/input IDs. Identical deliberate
submissions get new IDs; interrupted delivery retains both original IDs. The
journal is bound to the selected endpoint, authenticated native project, paired
principal and transport (direct or relay public host key). It contains no token,
relay rendezvous credential, grant or client-fabricated authority. The host still
owns session, workspace incarnation, source identity and source revision.

The journal is append-only, globally bounded to 128 records and 8 MiB, and never
evicts unresolved records. Capacity, corruption, denied storage, an aborted
transaction or lack of strict transaction durability block further publication.
There is no localStorage fallback. User-cleared or browser-evicted site data is
outside this persistence guarantee. The UI discloses local original-text storage.

Every native request rechecks `control.auth.current` and `workLedger.project`
under the same client lifetime. An existing paired admin with
`read:work-ledger` and `write:work-ledger` is required; shared bearers and user
sessions fail closed. The native server independently revalidates the actual
paired authority and current scopes. This UI creates no new token or grant.
Connection, token or relay changes retire pending operations, including A → B → A
identity changes. Restored records are listed only under the current verified
binding; native responses must match their original request/input/text.

## Recovery and outcomes

Opening, reopening and Inspect only read the daemon's capture. A lost capture or
admission acknowledgement remains unknown until that lookup answers. Retry
submission first inspects, and only replays the immutable capture if not found,
or invokes admission if captured. It never re-admits processing or terminal
inputs. While idle, New request permits a deliberately separate input while
keeping the original in Saved requests, even if that original is stale or its
remote outcome remains unknown. The UI explicitly says this does not cancel
remote intake. In particular, a legitimate host workspace-scope revision change
can stale an older capture while permitting a fresh capture by the same paired
owner. Resume is offered only for `processing` with `recovery: required`, and
rechecks that state before using the returned source revision. No background
poll, retry loop or implicit recovery rerolls unchanged semantic evidence.

Cancel intake can run while admission is pending. It looks up the original
source and invokes the dedicated authenticated cancellation method; it does not
claim cancellation from a local abort. Closing the dialog only detaches local
requests. A late pre-cancellation response cannot replace the newer UI outcome.
If publication already won, the real work receipt remains visible. Cancellation
does not cancel an already admitted execution.

`work` renders the immutable admission receipt and exact criteria. `turn`,
`blocked`, `refused` and `cancelled` remain genuine recorded dispositions with no
approval, legacy task or model-turn fallback.

## Boundaries still open

This slice stops at admission. It does not invoke native execution, claim an
execution receipt, or pass a serialized turn result into ordinary chat. Native
execution needs the explicit durable execution owner/control integration; hosted
conversation delivery still needs canonical broker input identity, currently
authenticated native authority, a nonserialized admission capability and durable
dispatch reconciliation. Existing `contracts.start/reply` and `tasks.create` are
not substituted for these dependencies.

## Proof

- Journal unit tests cover exact source preservation, committed strict durability,
  cross-owner isolation, immutable conflicts, capacity and storage failures.
- Browser-service tests use the actual WebUI HTTP facade and native SDK validator
  for automatic capture/admit, restart lookup, interruption, cancellation,
  identity replacement and refusal of unsupported authority.
- The daemon fixture generator uses production `DaemonServer` composition with
  a real pairing store, native source owner and SQLite ledger. Owned synthetic
  proposer/Jev responses produce unchanged HTTP captures for all five operations,
  all terminal outcomes, interrupted recovery and cancellation during a wait.
- Chromium regressions replay those captures through the production browser
  bundle and genuine IndexedDB. They cover exact text, one-submit behavior,
  lost acknowledgements, reopen/reload, recovery, pending cancellation, source
  holds, unsupported authority, storage failure and same-owner second-tab reads.

These are orchestration and lifecycle proofs, not live semantic calibration,
live provider acceptance or end-to-end hosted conversation/execution proof.
