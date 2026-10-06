# WebUI native work execution

The Native request form connects original-source admission to the existing paired
native execution wire. One deliberate Submit preserves the exact original, asks
Jev to admit it and, for a genuine `work` result, automatically requests execution
of that canonical work and attempt. There is no second Approve, Admit or Start
gate. Jev remains the semantic decision owner; the existing shared transport
remains the only Jev retry implementation.

A `turn`, blocked, refused or cancelled intake result does not dispatch execution.
Hosted conversation delivery uses its [separate native owner](webui-native-hosted-turn.md). This path never converts a
serialized result into a turn permit or invokes ordinary chat,
`contracts.start/reply` or `tasks.create`.

## Durable identity and current authority

The original source journal is unchanged. Before any native execution mutation,
a separate append-only IndexedDB journal commits the original input/request IDs
and canonical work/attempt/expected revisions under the same endpoint, project,
paired principal and direct/relay-host binding. It contains neither credentials,
execution receipts nor authority. Strict transaction completion is required;
corruption, conflicts, unavailable storage, lack of strict durability or global
128-record / 1 MiB capacity stop dispatch. No unresolved target is evicted and
there is no localStorage fallback. User-cleared or browser-evicted site data
remains outside the persistence guarantee.

The execution client uses the existing authenticated browser transport. Every
operation rechecks current paired admin identity, `read:work-ledger`, `write:fleet`
and the selected native project, within the original client lifetime. Intake
separately retains its `write:work-ledger` requirement. The daemon independently
rechecks the actual principal, live scopes, source, attempt and workspace.
Browser identity records and admission receipts do not grant execution authority.

Only the existing identity-only `workLedger.execution.start/status/cancel/resume`
methods are used. The browser supplies no original goal, generated criteria,
actor, native source, semantic proof, host session or execution capability.
The execution owner derives these from its authoritative ledger association.

## Dispatch and recovery

After retaining the exact target, request continuation reads status. Only the
specific `NATIVE_EXECUTION_NOT_FOUND` response permits one start. An unavailable,
malformed or interrupted response never becomes absence. A lost mutation
acknowledgement leaves the original target intact and the outcome unknown; the
browser never automatically sends a second start or resume.

Opening, reopening, saved-request selection and Inspect are read-only. They can
observe the canonical admitted target without retaining a new dispatch intent.
Continue request is an explicit interrupted-delivery action: it confirms the
original durable identity, reads status and starts only if the host reports the
same attempt absent. A pending or refused admission intent, existing execution
or recovery-required launch claim is only displayed.

Resume execution re-reads status and is available only for current, nonstale
prepared execution or interrupted admission intent. A launch claim requiring
external-effect reconciliation cannot be resumed by this screen. Passed
execution may explicitly verify and publish; published settlement may be
reconciled using the original admitted revisions. Those operations never select
a new attempt or restart completed effects. Cancellation/prevention remains
terminal. The server enforces all state transitions independently.

Cancel execution uses the retained original target even if a later source lookup
is stale. It may interrupt a pending local request and separately asks the host
to persist cancellation/prevention and drain its owned work. Aborting, closing or
choosing New request only detaches local requests. Per-operation generations
prevent late responses from overwriting a newer cancellation or selection.

## Honest projection

The admission receipt remains visible if execution fails. Pending and prevented
intent states display no execution receipt. Only a real `execution` snapshot can
display contract/owner IDs, bounded runner progress and settlement. Original
requested/admitted revisions remain separate from current ledger revisions,
stale/current-attempt flags and verification. Runner success and criterion counts
are not relabelled as ledger verification or published evidence.

## Proof and limits

- Strict target-journal tests cover commit completion, cross-owner isolation,
  conflicts, capacity, corruption and storage failures.
- Browser-service tests use the actual HTTP facade and SDK response validation,
  with unchanged production-daemon captures, fresh scope/lifetime checks,
  unknown outcomes and same-attempt reconciliation.
- DOM tests cover single-submit dispatch, independent admission/execution
  results, read-only reopening, interrupted continuation, cancellation and late
  responses, new-request detachment, and factual recovery/settlement controls.
- The daemon proof runs production source capture and source2 publication into
  the real native execution graph and foreground body. Only its recorded Jev
  readings and model responses are owned synthetic fixtures. Wire captures keep
  exact HTTP request/response bytes for Chromium replay.
- Browser tests use real strict IndexedDB and the production WebUI bundle, with
  exact captured host identity and state. Browser-run results must be evaluated
  separately from DOM or replay-loader checks.

No real user credential or provider was exercised. These are product orchestration
and lifecycle proofs, not live semantic calibration, live-provider acceptance or
an independent settlement-security certification. Hosted turn delivery now retains canonical broker input identity, current native
authority, a genuine nonserialized admission capability and durable
ambiguous-dispatch reconciliation in its separate owner.
