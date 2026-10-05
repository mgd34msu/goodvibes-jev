# WebUI acceptance reconciliation

Checkpoint: 2026-10-05, merged main
`1941b66e59822f98864474dda198bb86dd1443d1` (tree
`a4648cde33bc703301d23678727d50196556a59a`).
[THE-30](https://linear.app/the-artificery/issue/THE-30/port-webui-with-preserved-ui-and-behavior)
remains **In Progress** and [migration.json](../../products/webui/migration.json)
remains **partial**. This is an evidence reconciliation, not a new feature gate
or a declaration of full product parity.

## Acceptance basis

The original issue requires the upstream v2.0 Chat, Work, Library and Personal
places, shared shell/settings/UI kit, responsive list/detail behavior,
themes/assets, navigation and existing controls. It also requires source-by-source
semantic migration, real SDK shapes, meaningful interaction/screenshot proof,
packaging/PWA/daemon bundle behavior and connected-daemon flows where available.

The [666-path inventory](../inventory/webui.md) retains 597 PORT, 62 JEV and seven
DROP dispositions. These describe required treatment of the pinned source, not
666 completed mappings or 62 wholly unimplemented modules. The existing 17
mapping records are unchanged. [Import proof](../../products/webui/docs/migration-proof.md)
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
2. **Browser judgment production composition and readers (THE-70).** Fixed
   Library/status catalogs, authenticated transport, versioned adapters and the
   palette caller exist. Production registry installation, genuine authenticated
   source-reference issuers, the dynamic-error caller and remaining semantic
   readers need integration and real daemon proof. Unknown prose stays
   unclassified. Source references do not grant hosted transmission permission;
   no browser credential/model client or heuristic outage fallback is permitted.
   Sources: [THE-70](https://linear.app/the-artificery/issue/THE-70/integrate-authenticated-webui-judgments),
   [palette caller](../../products/webui/src/lib/command-judgment.ts),
   [optional runtime capability](../../packages/engine/sdk/src/platform/runtime/services.ts).
3. **Native host/source-bearing ingress.** The existing `contracts.start` input
   carries `ask`, session, workspace and isolation, but no native source. A native
   runner rejects a source-less start. Source-bearing native task
   ingress and host-owned continuation/execution integration require current
   authority/scope and durable execution ownership; this does not imply a new
   user-facing Revise action. Existing
   `workLedger.intake.*` requires a persisted paired-token admin owner, fresh
   authorization and `read:work-ledger` plus `write:work-ledger`; shared tokens and
   user sessions are unsupported there. Intake admission is not execution. A
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
   budget estimates and preserving accepted-input floors. Propagation through the
   session wire and WebUI callers is still missing; the context response has no
   provenance fields. This engine/wire consumer dependency is separate from
   THE-70's browser judgment registry/issuer lane. The current source supplies the
   documented `display.theme` enum/default in the bounded follow-up below;
   `display.treeGlyphs` still has no canonical schema entry. The session permission-mode verbs still expose fixed
   mode enums, not the engine-owned gate-preset catalog needed by the replacement
   sheet. Do not invent provenance, glyph config or a local preset policy; preserve deterministic current behavior while those contracts are
   supplied and integrated.
   Sources: [completed SDK context integration](sdk-nullable-context-windows.md),
   [session renderer](../../products/webui/src/views/work/SessionDetail.tsx),
   [session wire](../../packages/engine/sdk/src/platform/control-plane/method-catalog-control-core.ts),
   [canonical display schema](../../packages/engine/sdk/src/platform/config/schema-domain-core.ts),
   [current mode consumer](../../products/webui/src/lib/permission-mode.ts).
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
