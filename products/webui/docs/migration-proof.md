# WebUI migration and workspace import proof

Status: partial foundation, under integration. This document records observed
checks; it does not declare WebUI or the Jev migration complete.

## Current accounting checkpoint (2026-10-08)

Accounting reviewed at merged main `dfe395031e14542ac21d35fb89336886fbdacffd`.
THE-70 production composition is complete through [PR149](https://github.com/mgd34msu/goodvibes-jev/pull/149).
Native original-source admission, execution, hosted delivery and native-owned
session continuation are implemented through PRs 129, 135, 139 and 142; Fleet
actions and selected-hunk comments followed in PRs 144 and 146.
These are bounded implementation/fixture receipts, not live calibration.
At that reviewed-main baseline, the inventory, 17 mappings and partial status
were unchanged. Concrete remaining
WebUI gaps include engine-owned gate-preset adoption, typed mail reply-subject
reading, canonical persisted `display.treeGlyphs`, remaining ordinary hosted
ingress and final parity evidence. See the acceptance reconciliation for receipts
and boundaries.

The local gate-preset follow-up now imports the engine-owned picker data directly
and adds three mapping records (20 total), while preserving partial status and
all source dispositions. Its local unit/type/build/API/package checks passed;
publication and the 14 actual phone/desktop browser cases remain pending. The
baseline's missing-preset statements below describe the reviewed main SHA, not a
claim that this local implementation is already merged.

## Historical acceptance checkpoint (2026-10-05)

Reviewed baseline: merged main `1941b66e59822f98864474dda198bb86dd1443d1`.
[THE-30](https://linear.app/the-artificery/issue/THE-30/port-webui-with-preserved-ui-and-behavior)
remains In Progress. The [acceptance reconciliation](../../../docs/audit/webui-acceptance-reconciliation.md)
records the merged slices, exact CI evidence and remaining dependencies against
the original product requirements and current autonomous decision contract.

PRs [120](https://github.com/mgd34msu/goodvibes-jev/pull/120),
[121](https://github.com/mgd34msu/goodvibes-jev/pull/121) and
[122](https://github.com/mgd34msu/goodvibes-jev/pull/122) delivered contract-tree
inspection, native recorded evidence/wire fidelity and explicit contract
cancellation. PRs [123](https://github.com/mgd34msu/goodvibes-jev/pull/123) and
[124](https://github.com/mgd34msu/goodvibes-jev/pull/124) delivered session input
receipt reconciliation and identity-bound close/reopen/delete actions.

The latest [post-merge CI run](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37344564143)
passed all 35 applicable jobs; auto-release was skipped. Its real Chromium
phone/desktop/LAN lane executed **622 passing cases**, including all 22 new
session-lifecycle cases and all four LAN-origin cases, with 76 existing
project-specific skips. [Reports and screenshot captures](https://github.com/mgd34msu/goodvibes-jev/actions/runs/37344564143/artifacts/11359619267)
were retained; manual inspection of that archive was transfer-limited and is not
claimed. These are production-app browser assertions over controlled fixtures,
including real route/runner captures with scripted boundaries. They do not prove
a connected deployed daemon, real account authentication or live-provider parity.

## Historical import source and ownership

- Product source: `mgd34msu/goodvibes-webui` at
  `dadf57700668fe4500b17b0b0b4520715ab25ef4` (WebUI 2.0.0)
- Initial monorepo base: `5957c2be53b6fd5f393885ca00403a9eb4ff8ac6`
- At the import checkpoint, the upstream checkout remained at
  `9856cba64bb7df5677859c846a80eeb5c2da67c0`
  with no working-tree changes; the target was materialized from Git objects
- 659 of the 666 upstream paths are present in this product. The seven omitted
  paths are the two standalone release workflows, standalone `bun.lock`, and
  `sdk-dev`/`check-workflows` scripts and their tests. The reconciled inventory
  records their workspace replacements
- Source dispositions, pending readers and source-delta evidence are in the
  monorepo WebUI inventory and `docs/audit/webui-upstream-delta.md`

The app/assets preserve the upstream Chat, Work, Library, Personal, settings,
responsive shell and PWA. Legacy URL redirects and fragments remain. All actual
legacy package imports are retargeted to declared public engine exports; no
relative engine-source import or cross-worktree dependency link was introduced.
The product manifest uses `@goodvibes-jev/engine: workspace:*`.

## Packaging adaptations

The shared engine toolchain validates the workspace pin, root lock record and
public exports. Build-time generators read actual engine configuration,
ownership and presentation through public subpaths. A non-mutating snapshot
check runs before browser production builds. Version preparation only regenerates
those artifacts and icon/manifest cache stamps; the monorepo owns installation,
versions and publishing. Browser build and preview skip machine CLI discovery.
The production bundler refuses Node-only modules and engines resolved outside
this checkout.

The ordinary unit entrypoint uses the established guarded engine runner with
the product cwd and Bun isolation. A diagnostic run verified that happy-dom,
guarded fetch, isolated home and the network-violation ledger remain active
together; receipt tests pass under that runner.

## Historical import validation

The following observations belong to the initial import/integration checkpoints,
not the latest merged test counts or outstanding acceptance list.

- Own-worktree dependency install completed with lifecycle scripts disabled
- Initial WebUI dependency addition preserved every prior locked package
  resolution; new browser packages were added. Subsequent root dependency
  compatibility work is owned and verified by the coordinator
- Real engine build and package preparation passed
- Product source/scripts/e2e typechecks passed; file enumeration included all
  554 authored TypeScript files
- Shared workspace dependency/export checks passed all six checks
- Root product-workspace structural check passed
- Context regressions passed for known, null, absent and zero windows and the
  explicit SESSION_NOT_LOCAL response
- Receipt regressions passed for StrictMode consumption and stable-ID replay
  after sign-out and reattachment
- Initial full unit run: 2,238 passed, one upstream theme-schema expectation
  failed. Focused reruns pass after tying the rendering expectation to the
  actual engine schema and retaining enum selection behavior
- Full lint reported by the coordinator: zero errors, 269 warnings, after the
  root Ajv compatibility fix; related a11y and package-manager smoke checks pass

The full guarded unit pass completed with 2,241 passing tests across 191
files, zero failures and no network violations (83.6 seconds). A subsequent
event-contract correction changes approval filters from the removed permissions
domain to gate, including the browser fixture; all 17 affected guarded hook tests
pass. The domain invalidation table is checked against the public runtime-domain
type. At that checkpoint, the final integration typecheck/browser pass still needed
to include that correction. The production browser build then consumed the merged
pure payment/browser entry. In the canonical integration worktree at `73cb2c18a570e6a390ffa855c21e47cf7ff3e6e8`, frozen-lock
installation, real engine compilation/preparation, regenerated-data checks and
62 guarded payment UI tests pass. The initial bundle exposed a separate
wake/error-display dependency on the full judgment foundation; the coordinated
runtime-neutral export/import repair resolves it. The actual Vite production
build now passes with the Node-only import guard enabled. The engine browser
chunk is 231 kB and the app chunk is 896 kB; Vite reports a non-failing chunk-size
warning for the latter.

Local browser execution was blocked at the import checkpoint. Command-launched
Chromium failed before any app assertion at its required Unix socket with EPERM;
an accepted execution-escalation retry failed identically. The supported cloud
browser refused the verified local preview with `net::ERR_BLOCKED_BY_CLIENT`.
No protection was disabled and no tunnel was introduced. That local attempt
claimed no browser-flow or screenshot pass. Phone/desktop discovery found 592
cases in 44 files; discovery was not execution. Explicitly requested LAN-origin
coverage fails with a clear unsupported error if no readable private interface
exists, rather than treating skipped proof as success. Subsequent actual CI
browser execution is recorded in the current checkpoint above.

The import added a monorepo WebUI browser lane consuming the shared engine build
artifact on ordinary GitHub runners with official Playwright Chromium, fresh
fixture ownership and LAN host support. At that initial checkpoint it was only
prepared wiring. It has since executed successfully; the historical local launch
restriction is not a current CI browser blocker. No live daemon or provider is
used by this lane.

## Remaining integration and semantic work

The 666-path inventory and its 62 JEV dispositions remain requirements, not a
completed-mapping count. Fixed Library/status catalogs, authenticated palette
and dynamic-error callers, genuine authority-bound source-reference issuers and
production browser judgment installation are implemented by completed
[THE-70](https://linear.app/the-artificery/issue/THE-70/integrate-authenticated-webui-judgments).
Unknown prose remains unclassified outside approved sources/readers. Remaining
semantic consumers still require per-caller evidence; live calibration is THE-35.
No browser model client or Jev credential is an acceptable substitute.

Contract inspection, native evidence and explicit cancellation are implemented.
Source-bearing native intake and its host-owned execution, hosted delivery and
native-owned continuation integrations are implemented. Remaining ordinary hosted
ingress and semantic consumers must retain the source, authority and execution
boundaries in the
[current autonomous contract](../../../docs/design/autonomous-jev-decisions.md).
The source-less `contracts.start` wire is not native admission; native runners
reject it. The existing work-ledger intake requires persisted paired-admin
authority and `read:work-ledger`/`write:work-ledger` scopes. Inspection receipts do
not grant those capabilities or authorize execution. Historical escalation
records stay historical; they are not a new semantic approval/reply workflow.

The canonical engine schema now supplies the pinned upstream 13-choice
`display.theme` enum and `goodvibes` default. General settings consumes generated
metadata; TUI and Agent retain their live-preview picker and enum cycling.
Explicit `vaporwave` retains the neon palette. Recognized saved case/whitespace
forms are adapted in the read view without ingestion rewriting files; explicit
bulk saves serialize the resolved canonical name, and new writes remain exact. Palette ownership stays client-local, separate from light/dark mode
and browser appearance. The key description and genuine credential reading are
unchanged. See the [current source follow-up](../../../docs/audit/webui-acceptance-reconciliation.md#typed-terminal-palette-follow-up)
for the functional proof boundaries.

There is still no canonical `display.treeGlyphs` setting. PR189 completed scalar
and budget settings-draft reconciliation; it did not close the missing glyph
schema/default/generated metadata/persistence/browser proof or its genuine
credential-classification prerequisite. At the reviewed-main accounting baseline, the session permission-mode verbs
expose fixed mode enums without the required engine-owned preset catalog in the
sheet. The local follow-up above supplies that data path while preserving those
verbs; hosted browser/publication proof is still pending.
Unknown/null/zero/non-local context renders honestly.
[THE-90](https://linear.app/the-artificery/issue/THE-90/preserve-unknown-context-windows)/
[PR #46](https://github.com/mgd34msu/goodvibes-jev/pull/46) already implemented
provider known-window/provenance semantics. Merged
[PR #127](https://github.com/mgd34msu/goodvibes-jev/pull/127) now propagates the known
ceiling, typed source/origin and accepted-input lower bound through the session
wire and WebUI callers, preserving nullable unknown capacity and retiring stale
model reads. This remains separate from THE-70's browser judgment registry/issuer
work. Usage remains an estimated runtime snapshot, with no guaranteed multi-loop
session accounting or dedicated realtime event for every cap/floor change; the
[provider API](../../../packages/engine/docs/provider-model-api.md) records these
boundaries.

Complete source mappings, remaining semantic/parity work and final integrated
acceptance remain open. The current CI browser matrix passed; genuine connected
daemon auth/status/session/chat and approved live-provider proof are still
separate requirements under
[THE-15](https://linear.app/the-artificery/issue/THE-15/verify-integrated-parity-live-proofs-and-release-readiness).
No real account, mail, credential, payment or external purchase acceptance is
claimed by the synthetic browser or scripted HTTP fixtures.
