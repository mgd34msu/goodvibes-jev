# WebUI workspace import proof

Status: partial foundation, under integration. This document records observed
checks; it does not declare WebUI or the Jev migration complete.

## Source and ownership

- Product source: `mgd34msu/goodvibes-webui` at
  `dadf57700668fe4500b17b0b0b4520715ab25ef4` (WebUI 2.0.0)
- Initial monorepo base: `5957c2be53b6fd5f393885ca00403a9eb4ff8ac6`
- Upstream checkout remains at `9856cba64bb7df5677859c846a80eeb5c2da67c0`
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

## Observed validation

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
type. The final integration typecheck/browser pass must include that correction. Production browser
build now consumes the merged pure payment/browser entry. In the canonical
integration worktree at `73cb2c18a570e6a390ffa855c21e47cf7ff3e6e8`, frozen-lock
installation, real engine compilation/preparation, regenerated-data checks and
62 guarded payment UI tests pass. The initial bundle exposed a separate
wake/error-display dependency on the full judgment foundation; the coordinated
runtime-neutral export/import repair resolves it. The actual Vite production
build now passes with the Node-only import guard enabled. The engine browser
chunk is 231 kB and the app chunk is 896 kB; Vite reports a non-failing chunk-size
warning for the latter.

Real browser execution is blocked by this environment. Command-launched Chromium
fails before any app assertion at its required Unix socket with EPERM. An accepted
execution-escalation retry fails identically. The supported cloud browser refuses
the verified local preview with `net::ERR_BLOCKED_BY_CLIENT`; no protection was
disabled and no tunnel was introduced. Therefore no actual browser-flow or
screenshot pass is claimed. Phone/desktop test discovery succeeds (592 cases in
44 files); discovery is not execution. Explicitly requested LAN-origin coverage
now fails with a clear unsupported error if no readable private interface exists,
instead of reporting a skipped proof as success.

The monorepo CI now defines one WebUI browser lane that consumes the shared engine
build artifact and runs all phone, desktop and real LAN-origin specs on ordinary
GitHub runners with official Playwright Chromium. It retains reports, failure
traces, design screenshots and console output. Fresh fixture ownership and LAN
host support are required; no live daemon or provider is used. This is prepared
CI wiring, not a claim that those browser assertions have run or passed.

## Remaining integration and semantic work

The existing JEV obligations remain. The new Library arbitrary-status reading,
contract-tree projections/actions/judgments, gate-preset controls and authenticated
closed-battery browser judgment boundary are unfinished. No browser model client,
Jev credential or pretend judgment endpoint was added.

The current engine schema still declares `display.theme` as a string. Its
upstream enum/dropdown behavior, tree glyphs and other current-engine source
changes remain integration requirements. The component tests cover the actual
string schema and enum schemas; they do not mark the missing engine enum done.
Context-window unknown values render honestly, while authoritative context
provenance remains pending the new engine contract.

Current wire compatibility updates consume the public event-domain predicate,
use contract-kind fixtures and hosted `contractIds`, and open a contract group's
existing graph alias with its correctly qualified group ID. They do not amount
to a completed contract-tree migration.

No live providers, real account authentication, mail, credential, payment or
external purchase operations were tested. Synthetic browser tests cannot replace
an actual daemon-backed auth/status/session/chat proof. Final source accounting,
all semantic migrations, browser matrix and whole-tree gates remain required.
