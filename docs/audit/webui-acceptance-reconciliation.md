# WebUI acceptance reconciliation

Historical checkpoint: 2026-10-05, merged main
`1941b66e59822f98864474dda198bb86dd1443d1` (tree
`a4648cde33bc703301d23678727d50196556a59a`).
[THE-30](https://linear.app/the-artificery/issue/THE-30/port-webui-with-preserved-ui-and-behavior)
remains **In Progress** and [migration.json](../../products/webui/migration.json)
remains **partial**. This is an evidence reconciliation, not a new feature gate
or a declaration of full product parity.

## Current accounting checkpoint (2026-10-08)

Reviewed source: merged main `dfe395031e14542ac21d35fb89336886fbdacffd`.
The historical counts below remain attached to their original SHA. That
accounting baseline retains 666 source dispositions, 17 mappings and partial
status; the local preset and Mail follow-ups below each add three mapping
records (23 total), without changing dispositions or partial status.

- **THE-70 is complete.** [PR149](https://github.com/mgd34msu/goodvibes-jev/pull/149)
  merged as `aa961d0092555f80ff233bc065f9a69c097d9ae4`.
  [Actual-main CI37521857400](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37521857400)
  passed all 36 validation jobs with auto-release skipped; 838 browser cases passed
  and 76 were explicitly skipped. All 22 added runtime cases executed. Production
  registry installation, real host chat-title/error issuers and dynamic-error
  callers are implemented. Three closed purposes retain actual-dispatch,
  revocation, log and delivery authority; status remains catalog-enum-only.
- **Native source intake is implemented.** [PR129](https://github.com/mgd34msu/goodvibes-jev/pull/129)
  merged as `71a1d4657c171e010ce93e819ba31182041a7973`;
  [CI37422249353](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37422249353)
  passed 35 jobs and 676 browser cases, with 76 explicit skips. All 24 added
  native cases passed. PR135 adds durable execution; PR139 adds hosted delivery;
  PR142 adds native-owned session continuation. PR142's actual-main
  [CI37476251975](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37476251975)
  passed 36 jobs and 756 browser cases, including all 104 relevant native cases,
  with 76 explicit skips. PR144 Fleet actions and PR146 hunk comments extend the
  same owned source boundaries. Ordinary hosted ingress remains separate.
- **Settings/context credit stays bounded.** PR127 propagates known/unknown
  context provenance; PR128 supplies the canonical theme enum/default; PR189
  repairs scalar/budget draft reconciliation after canonical config refresh.
  At that reviewed SHA, concrete open WebUI gaps are engine-owned gate-preset
  presentation adoption,
  typed `webui.mail.reply-subject` in the reachable Mail Reply flow, and canonical
  persisted `display.treeGlyphs`, including genuine credential classification,
  generated metadata, persistence and actual browser proof. A read-only glyph
  presentation reader is not the persisted setting.

These receipts establish controlled runtime/browser behavior on the named trees.
They do not establish deployed account/provider acceptance, final-SHA live
calibration (THE-35), all source mappings or THE-15 release readiness. No unresolved
mapping count is treated as a count of wholly unimplemented features.

## Local gate-preset follow-up (publication pending)

The local session picker now consumes labels and settable ids directly from the
engine's browser-safe gate preset table. Three inventory mappings cover this
preset slice. Source, type, API, package and behavioral unit checks
have passed for that slice; the seven phone/desktop scenarios are discoverable,
but actual hosted browser and publication proof remain pending. These local
results do not close THE-30 or replace the merged receipts above.

## Local Mail reply-subject follow-up (publication pending)

Source commit `56f00c524cec98a82eeabcafcee91ad026c15c7c` implements the typed
`webui.mail.reply-subject` reader and reachable Mail reply caller. Only a canonical
complete mail read with current account/mailbox/UID identity can issue its opaque
subject reference. An acted boolean keeps the exact subject or prepends `Re: `;
pending/held readings do not choose a heuristic fallback. Manual editing remains
available, and cancellation plus draft/client-lifetime guards retire stale work.

Three mappings cover MailView, its behavior tests and the presentational
MailCompose. Together with the three preset mappings, the working-tree total is
23. The mail slice's local unit tests and affected type/build checks passed;
final union publication and actual browser execution are still pending. Synthetic
reader and transport fixtures do not establish live classification accuracy
(THE-35), external mail delivery or broad THE-30/THE-15 acceptance. Canonical
persisted `display.treeGlyphs` remains open.

## Acceptance basis

The original issue requires the upstream v2.0 Chat, Work, Library and Personal
places, shared shell/settings/UI kit, responsive list/detail behavior,
themes/assets, navigation and existing controls. It also requires source-by-source
semantic migration, real SDK shapes, meaningful interaction/screenshot proof,
packaging/PWA/daemon bundle behavior and connected-daemon flows where available.

The [666-path inventory](../inventory/webui.md) retains 597 PORT, 62 JEV and seven
DROP dispositions. These describe required treatment of the pinned source, not
666 completed mappings or 62 wholly unimplemented modules. The reviewed-main
baseline has 17 mapping records; the bounded preset and Mail follow-ups add six,
for 23 working-tree records. [Import proof](../../products/webui/docs/migration-proof.md)
and [upstream delta accounting](webui-upstream-delta.md) retain their historical
observations; their old local-browser restrictions and missing-slice statements
do not override the merged evidence below.

New semantic consumers follow the [autonomous Jev decision contract](../design/autonomous-jev-decisions.md):
recorded `act`, `revise`, `defer` and `reject`, current host-owned bindings and
execution claims, with shared-port transport waiting kept separate. Historical
`confirm`/`escalate` readings remain readable history. They must not become a new
human semantic approval/reply path. Explicit user cancellation or destructive
session-action confirmation is not a replacement for Jev's semantic decisions.

## Merged slices and actual browser execution

Each listed post-merge CI run has 36 job records for its exact merged SHA:
35 succeeded and the auto-release job was skipped. Counts below are executed
passing browser cases, not test discovery. Every run also reported 76 established
viewport-specific skips and passed all four LAN-origin cases.

| Merged slice | Merge commit | Post-merge CI | Browser passes |
| --- | --- | --- | ---: |
| [PR #120: contract inspection](https://github.com/mgd34msu/goodvibes-jev/pull/120) | `96764055a25c2ab292aa772107013befe7972bc5` | [37298968156](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37298968156) | 564 |
| [PR #121: native wire/evidence fidelity](https://github.com/mgd34msu/goodvibes-jev/pull/121) | `d2081356ca244e0ae80803e005d94f6a5644b47c` | [37324466929](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37324466929) | 574 |
| [PR #122: explicit contract cancellation](https://github.com/mgd34msu/goodvibes-jev/pull/122) | `55a130177961ae53f4544ff09c62b866d49c9094` | [37325309532](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37325309532) | 588 |
| [PR #123: session input receipts](https://github.com/mgd34msu/goodvibes-jev/pull/123) | `464da684706c73c1bc82b57553ce7d706f52bc69` | [37339623941](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37339623941) | 600 |
| [PR #124: session lifecycle identity](https://github.com/mgd34msu/goodvibes-jev/pull/124) | `1941b66e59822f98864474dda198bb86dd1443d1` | [37344564143](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37344564143) | 622 |

- **Inspection is implemented.** Work reads generated `contracts.list/get`,
  renders goals, criteria/readings, group/unit/attempt trees, check evidence,
  historical escalation and terminal records, with identity-scoped reads and
  malformed/failed-refresh handling. PR #120 added 32 phone/desktop cases.
  Sources: [contract queries](../../products/webui/src/hooks/useContracts.ts),
  [tree renderer](../../products/webui/src/views/work/ContractTree.tsx).
- **Native evidence is implemented.** Closed wire schemas and the renderer
  preserve original native source, recorded semantic receipts, separate transport
  waiting, durable admission/captured-input provenance and partial completion
  reports. Five actual runner-to-REST scenarios produced ten unchanged GET/LIST
  captures; PR #121 added ten phone/desktop cases.
  Sources: [native renderer](../../products/webui/src/views/work/NativeContractDetails.tsx),
  [capture provenance](../../products/webui/e2e/support/fixtures/contract-inspection/README.md).
- **Explicit Cancel is implemented.** The authenticated existing route is
  single-flight and bound to account/detail intent. Unknown outcomes do not replay;
  fresh list/detail/fleet reads precede any new attempt. Acknowledgement is not
  child drainage or rollback; retained nonterminal records can return `false`.
  PR #122 added 14 phone/desktop cases and actual authenticated HTTP/runner tests.
  Sources: [cancellation controller](../../products/webui/src/hooks/useContractCancellation.ts),
  [HTTP proof](../../packages/engine/test/contract/cancellation-http.test.ts).
- **Session receipt and lifecycle fixes are implemented.** PR #123 retains input
  IDs/states, reconciles through existing events/list/polling and does not resend
  unknown outcomes (12 new phone/desktop cases). PR #124 fences close/reopen/delete
  by originating identity/selection, preserves unknown outcomes, and requires
  target-specific absence proof beyond the capped list (22 new cases). Its final
  integrated local suite passed 2,439 tests, with types, zero-error lint, generated
  data, production build and six release gates passed as recorded in the PR.
  Sources: [receipt browser proof](../../products/webui/e2e/session-followup-receipts.e2e.ts),
  [lifecycle browser proof](../../products/webui/e2e/session-lifecycle-identity.e2e.ts).

The latest [browser job](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37344564143/job/111880532261)
and [report/screenshot artifact](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37344564143/artifacts/11359619267)
establish actual Chromium execution. Artifact retention is limited. The #124
archive's manual visual review was transfer-limited and is **not** claimed; the
earlier slices' inspected screenshots are recorded in their PR/issue evidence.
The local Chromium socket/IPC restriction remains historical/local evidence,
not an absence of CI execution.

Browser tests use controlled daemon fixtures, including exact captures from real
runner/route/broker code with scripted model/executor boundaries. Authenticated
loopback HTTP tests establish their tested auth/scope behavior; neither those nor
the browser replays prove a real connected deployment, user account or provider.

## Dependencies and acceptance still open

1. **Remaining source and semantic consumers.** Complete per-caller evidence and
   source mappings for the original inventory, including remaining Work/fleet
   semantic projections and settings consumers. Merged inspection does not close
   every judgment/action obligation. No new mappings or disposition changes are
   inferred by this reconciliation.
2. **Completed browser judgment runtime (THE-70); live calibration separate.** The production daemon now
   installs the existing command/error adapters against its configured Jev route
   and decision-log policy for three closed source purposes. Its actual initialized
   chat manager supplies titles with fresh read permission and source/lifetime
   fences; canonical authenticated failures issue bounded error references.
   Real asynchronous browser callers adopt only complete current readings.
   Source references never choose an outbound route or grant transmission by
   possession. Revocation fences dispatch, hashes, records and attachments;
   unknown prose has no substring fallback. Controlled actual-daemon HTTP and
   runtime-capture browser tests establish these implementation boundaries.
   Publication and merged-main CI are complete through PR149, as recorded above.
   Live provider calibration remains THE-35; no connected deployment or real-user
   egress is claimed.
   Sources: [THE-70](https://linear.app/the-artificery/issue/THE-70/integrate-authenticated-webui-judgments),
   [runtime policy](../../products/daemon/src/runtime/browser-judgment-composition.ts),
   [source owner](../../packages/engine/sdk/src/platform/judgment-browser/webui-runtime.ts),
   [runtime browser captures](../../products/webui/e2e/support/fixtures/browser-judgment-runtime/README.md).
3. **Implemented native ingress; remaining ordinary hosted ingress.** The bounded
   [WebUI original-source admission](../design/webui-native-intake.md) surface now
   journals exact text and invokes capture/admission in one Submit, with paired
   authority checks and explicit inspect/recovery/cancellation. It renders real
   admission receipts separately from [native execution](../design/webui-native-execution.md)
   and [hosted conversation delivery](../design/webui-native-hosted-turn.md), both
   of which now continue automatically for their matching recorded disposition.
   These owners preserve current authority, exact source and durable no-replay
   boundaries. Ordinary hosted create/steer/follow-up ingress remains a separate
   migration. The existing `contracts.start` input carries no native source and
   remains unsuitable as a substitute. Intake admission is not execution;
   shared tokens and user sessions remain unsupported on the native routes. A
   WebUI caller must not fabricate source revisions, broaden scopes, substitute
   legacy start/reply, or infer authority from inspection receipts.
   Sources: [start wire](../../packages/engine/sdk/src/platform/control-plane/operator-contract-schemas-contracts.ts),
   [runner source guard](../../packages/engine/sdk/src/platform/contract/runner.ts),
   [intake authorization](../../packages/engine/sdk/src/platform/control-plane/routes/native-intake.ts),
   [host composition contract](../design/native-durable-contract-composition.md).
4. **Authoritative context and settings schemas.** Unknown/null/zero/non-local
   context rendering exists. Completed
   [THE-90](https://linear.app/the-artificery/issue/THE-90/preserve-unknown-context-windows)/
   [PR #46](https://github.com/mgd34msu/goodvibes-jev/pull/46) already implemented
   provider known-window/provenance semantics, separating known ceilings from
   budget estimates and preserving accepted-input floors. Merged
   [PR #127](https://github.com/mgd34msu/goodvibes-jev/pull/127) now propagates the
   known ceiling, typed source/origin and accepted-input lower bound through
   session responses and WebUI callers. Unknown capacity remains nullable and
   stale model reads are retired. This engine/wire integration is separate from
   THE-70's browser judgment registry/issuer lane. Usage is still a stored runtime
   estimate, not a fresh count or guaranteed multi-loop session accounting.
   Cap/floor metadata changes have no dedicated realtime event, so refresh still
   needs another invalidation or read; see the [provider API boundaries](../../packages/engine/docs/provider-model-api.md).
   The current source supplies the
   documented `display.theme` enum/default in the bounded follow-up below;
   `display.treeGlyphs` still has no canonical schema entry. The session picker now
   consumes labels and settable preset names from the engine-owned, browser-safe
   `sdk/platform/gate/presets` catalog. Existing session permission-mode get/set
   verbs, custom read-only state and local-runtime scope remain intact. This
   presentation migration does not close the remaining persisted glyph setting
   or broader semantic and connected-daemon work. The separate local Mail
   implementation above still awaits publication and actual browser proof.
   Sources: [completed SDK context integration](sdk-nullable-context-windows.md),
   [session renderer](../../products/webui/src/views/work/SessionDetail.tsx),
   [session wire](../../packages/engine/sdk/src/platform/control-plane/method-catalog-control-core.ts),
   [canonical display schema](../../packages/engine/sdk/src/platform/config/schema-domain-core.ts),
   [gate preset catalog](../../packages/engine/sdk/src/platform/gate/presets.ts),
   [session preset sheet](../../products/webui/src/components/confirm/PermissionModeSheet.tsx).
5. **Connected-daemon, live-provider and whole-product parity.** The successful
   CI matrix is real browser proof, but genuine daemon auth/status/session/chat,
   approved live-provider behavior, remaining visual/interaction parity and final
   integrated release acceptance remain open. Real mail, credential, payment and
   external purchase behavior is not established by these fixtures.
   Sources: [THE-15](https://linear.app/the-artificery/issue/THE-15/verify-integrated-parity-live-proofs-and-release-readiness),
   [THE-35](https://linear.app/the-artificery/issue/THE-35/run-live-judgment-calibration-and-classification-proofs),
   [product validation runbook](../../products/webui/docs/testing-and-validation.md).

## Typed terminal palette follow-up

Current source adopts the exact 13 palette choices and `goodvibes` default from
[pinned SDK `17eae838`](https://github.com/mgd34msu/goodvibes-sdk/blob/17eae838461a6529135fe2cad41332d2dc46cb27/packages/sdk/src/platform/config/schema-domain-core.ts).
The existing palette-purpose description and genuine credential-key reading are
unchanged. The public value type stays `string`; runtime writes use the enum.

General settings uses the regenerated engine metadata. Functional tests cover
real config dispatcher/handler/ConfigManager persistence, rejected writes,
external reload and browser-appearance independence. TUI and Agent tests exercise
canonical palette application, live preview/cancel/save and left/right enum
cycling, including the `vaporwave` alias. Fresh/unset/reset values use `goodvibes`;
recognized saved case/whitespace forms are normalized in the read view without
rewriting files during ingestion. Key-specific unrelated writes retain the saved
spelling; an explicit bulk save serializes the resolved canonical name. Unknown
values retain ordinary quarantine.
The setting remains client-local and separate from `display.themeMode`.

Phone/desktop cases are authored for the production WebUI against a disk-backed
config route fixture. Authorization, error categorization readings and unrelated
app routes are synthetic; validation and config persistence are real. This does
not establish genuine deployed-daemon acceptance. Browser execution and visual
proof must be established by the candidate's CI evidence; the historical merged
matrix above does not validate this follow-up.

Sources: [engine behavior tests](../../packages/engine/test/config-terminal-theme.test.ts),
[real route fixture](../../products/webui/e2e/support/terminal-theme-host.ts),
[phone/desktop cases](../../products/webui/e2e/terminal-theme-config.e2e.ts).

The merged counts above are credited only to their stated baseline. Separate
unpublished local candidates are not shipped evidence. The inventory requirements
and test gates are unchanged; no new release control is introduced.
