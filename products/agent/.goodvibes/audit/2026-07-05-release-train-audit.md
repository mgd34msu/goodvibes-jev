# Release-Train Blocker Audit (W4-REL)

Investigation-only audit. No code changed, no scripts run destructively (no `bun
install`, no `sdk-dev.ts restore`/`link`, no global-install smoke test executed).
Repo: goodvibes-agent main @ c5fa750c. SDK overlay is currently ACTIVE — its state was
not touched.

## 1. Overlay-block is confirmed by-design (as the brief states)

Ran `bun scripts/sdk-release-gates.ts` read-only. Output:

```
sdk-release-gate: local SDK overlay is active — run `bun scripts/sdk-dev.ts restore` before publishing
```

Exit 1, **exactly one** issue reported. `sdkPinAgreementIssues` (scripts/sdk-release-gates.ts:40-74)
checks four things: overlay-marker presence, exact-semver pin, pin==installed version,
and bun.lock resolving the pin — only the marker tripped; pin/lock/installed already
agree (all read "0.38.0"). `nonNpmSdkImportOffenders` (scripts/sdk-release-gates.ts:80-99)
reported zero offenders. This confirms the brief's framing: with the overlay linked,
`publish:check` is *expected* to fail, and `bun scripts/sdk-dev.ts restore` is the known,
sole remedy — a Wave-6 ship step, not a Wave-4 defect. **Not a blocker.**

## 2. Install genuineness: no cache-poisoning residue found (WO-0B precedent)

- `scripts/sdk-dev.ts`'s `link()` already carries the WO-0B fix, in-code and
  documented: it `rmSync`s the destination `dist/` and `package.json` before
  `cpSync`, specifically to avoid writing through bun's hardlinked global cache
  (the comment at scripts/sdk-dev.ts:110-120 names the hazard and says "Ported with
  the fix from goodvibes-webui's sdk-dev.ts — do NOT restore the in-place-copy
  pattern"). This is the fixed pattern WO-0B told WO-0A to port; it is present.
- Inspected the machine-global bun cache entry the agent's pin targets:
  `~/.bun/install/cache/@goodvibes-jev/engine/sdk@0.38.0@@@1`. Its `package.json` has
  exactly one `"file:"` dependency (`bash-language-server: file:vendor/bash-language-server`),
  which is a legitimate third-party package vendored **inside** the SDK's own npm
  tarball (has its own `package.json`, `CHANGELOG.md`, a `GOODVIBES_PATCH.md`, a
  compiled `tree-sitter-bash.wasm`) — not a `workspace:*` residue pointing at a local
  monorepo sibling. No `workspace:` string appears anywhere in that cache entry's
  `package.json`.
- `bun.lock` records `@goodvibes-jev/engine/sdk@0.38.0` with a real `sha512-...` integrity
  hash and pins all eight companion `@pellux/goodvibes-*` packages
  (contracts/daemon-sdk/errors/operator-sdk/peer-sdk/transport-core/transport-http/
  transport-realtime) to exact `0.38.0` — no `workspace:*` anywhere in the lockfile.
- **Conclusion: the cached/pinned 0.38.0 the agent will restore to is genuine.** No
  evidence of the WO-0B poisoning pattern on this machine for this package.

## 3. A sharper, concrete finding: `restore` alone (without a coordinated pin bump) is not just gated, it is *actively broken*

The brief frames "npm-pin restore is the Wave-6 ship step" as a known, deliberate gate.
Grounding shows the mechanics are sharper than "the gate blocks publish until restore
runs" — **the agent's own product source already imports SDK exports that do not exist
in the currently-pinned npm 0.38.0 at all**, because Waves 1-3 built the session-spine
REST adapter (W2A/W3-A1) against the SDK's 0.39.0-track overlay. Diffed the overlay's
`node_modules/@goodvibes-jev/engine/sdk/package.json` exports map against the cached
pinned-0.38.0 tarball's exports map:

- `./platform/runtime/session-spine` exists in the overlay, **does not exist** in npm
  0.38.0's exports map or dist (`find .../0.38.0.../dist -iname '*session-spine*'`
  returns nothing). Consumed at `src/runtime/session-spine-rest-transport.ts:27`
  (`SpineResult`, `SpineTransport`) and `src/runtime/services.ts:14`
  (`AGENT_SPINE_PARTICIPANT`, `SessionSpineClient`).
- `platform/control-plane`'s `index.d.ts` in the overlay re-exports
  `RegisterSharedSessionInput` (and eight sibling `SharedSession*` types) from
  `./session-types.js`; the pinned 0.38.0's `platform/control-plane/index.d.ts` has
  **no such re-export at all** — that whole export line is absent. Consumed at
  `src/runtime/session-spine-rest-transport.ts:26`.

Both are used in non-test source, not just scripts. **If `bun scripts/sdk-dev.ts
restore` is run today in isolation** (removing the overlay and reinstalling the pinned
0.38.0 without also bumping the pin to a published version that carries these two
exports), the agent's own `bun run typecheck`/`bun run build` will fail on unresolvable
imports — this is not a hypothetical, it is a direct consequence of the exports-map
diff above.

**This does not change the brief's ruling** (still: document, don't fix — restoring or
bumping now is out of scope for Wave 4). It sharpens the Wave-6 ship-step
documentation: restore and the pin bump to 0.39.0 must land as **one atomic step**, in
this order — (a) SDK 0.39.0 published with the session-spine subpath and the
SharedSession* control-plane types; (b) agent's `package.json` devDependency pin bumped
to `0.39.0`; (c) `bun scripts/sdk-dev.ts restore` run; (d) `bun run typecheck` (or
`bun install` + typecheck) run immediately to confirm resolution — never restore alone,
never bump-the-pin-then-restore-later as two separate commits with a broken interval
in between committed to `main`.

## 4. No second bypass path (confirmed)

`nonNpmSdkImportOffenders` only sweeps `src/` by default. Grepped `scripts/*.ts`,
`package.json`, and `bunfig.toml` for any other local-path SDK reference
(`GOODVIBES_SDK_PATH`, a literal `Projects/goodvibes-sdk` path, or a `file:`/`link:`/
`workspace:` specifier for `goodvibes-sdk`) outside `scripts/sdk-dev.ts` itself — found
none. `scripts/release.ts` (392 lines) has zero SDK/overlay-specific logic of its own;
it delegates entirely to `publish-check.ts` via the `ci:gate` chain
(`package.json:56`: `... && publish:check && package:install-check &&
verification:ledger`), so there is exactly one place the overlay gate lives, and it is
wired into the chain CI actually runs.

## 5. Residual hardening gap worth naming (not a Wave-4 fix; noted for the record)

`sdkPinAgreementIssues`' version-agreement check compares **version strings only**
(installed `package.json` version vs. the pin vs. what `bun.lock` mentions), not a
content hash. In this repo's actual overlay, the local SDK checkout's own
`package.json` version field is *still* `"0.38.0"` (the SDK repo hasn't bumped its own
version yet mid-development toward 0.39.0) — meaning the version-agreement checks
would report **no issue** even with the overlay linked; the *only* thing catching the
overlay today is the explicit marker-file existence check. That is sufficient as
designed (the marker is written unconditionally by `link()` and only removed by
`restore()`), but it means the gate's integrity rests entirely on that one marker file
staying present. If it were ever deleted manually while the overlaid `dist/` remained
(accidental `rm` of just the marker, not the whole package dir), `publish:check` would
pass while shipping unpublished, possibly-dirty SDK code with no other check catching
it. Documenting only — not a Wave-4 defect (no evidence this has ever happened; the
marker is written/removed as one atomic step by the two commands that touch it), but a
candidate hardening item for whoever owns the release gates next: cross-check the
installed dist against `bun.lock`'s recorded integrity hash, not just the version
string.

## 6. Other candidate blocker classes checked and ruled out

- **Hardcoded versions in release-facing checks**: grepped `scripts/*.ts` and
  `src/cli/*.ts` for literal `0.3x.y`-shaped strings. Only two hits, both comments (not
  logic): `scripts/coverage-gate.ts:26` (a baseline-measurement note: "SDK pinned at
  npm 0.38.0" for the coverage ratchet floors) and `scripts/sdk-release-gates.ts:56`
  (a comment citing the TUI's 0.37.2 incident as the reason the lock/installed
  agreement check exists). Neither drives a comparison against a hardcoded version at
  runtime — the actual pin is read live from `package.json` in both cases. Not a
  blocker; the coverage floors (`FUNCS_FLOOR`/`LINES_FLOOR`, currently 84/82) are a
  ratchet and will naturally need re-measuring once the 0.39.0-bump lands new
  session-spine code, but that is ordinary CI hygiene, not a defect.
- **Stale pins**: only one SDK pin exists (`package.json:95` devDependency, exact
  `0.38.0`); `bun.lock` agrees. No secondary pin (e.g., in a Dockerfile, CI workflow
  file, or a vendored contract manifest) was found referencing a different SDK
  version.
- **Scripts assuming the old (pre-session-spine) local client**: none of the release
  scripts (`sdk-release-gates.ts`, `publish-check.ts`, `package-install-check.ts`,
  `release.ts`) reference the session-spine client at all — they gate on the overlay
  marker generically, not on any specific SDK API shape, so they will not need
  changes when the pin bumps to 0.39.0. The actual old/new-client dependency lives in
  **product source** (`src/runtime/session-spine-rest-transport.ts`,
  `src/runtime/services.ts`), covered in Section 3 above — that is the real blocker
  class this bullet was hunting for, and it is not release-script code, it's the
  runtime itself.
- **`package-verification.ts` SDK-surface assumptions**: the file's checks that
  mention `GatewayMethodCatalog` / `'control.contract'` / `'remote.node_host.contract'`
  (lines ~2007-2011) are **not** live checks against the SDK's actual contract — they
  are meta-checks asserting that the agent's *own* `scripts/check-architecture.ts`
  source text still contains those literal marker strings (a self-check that the
  architecture gate hasn't silently dropped a boundary-policy rule). They read the
  agent's own script source, not the SDK. Low, indirect risk: if Waves 1-3's contract
  work ever renames those specific route ids inside the agent's own
  `check-architecture.ts`, this meta-check would need updating in lockstep — but that
  is an agent-repo-internal consistency check, not something the SDK pin bump touches
  directly. Not a Wave-6 blocker.
- **Contract-package re-sync after `bun install`**: searched the agent repo for any
  committed `operator-contract.json`/`peer-contract.json` snapshot or a
  `contracts:check`/`refresh:contracts:check` script — found none. The agent repo does
  not vendor or snapshot a copy of the SDK's contract manifests; it only consumes the
  installed package's exports at import time. This class of risk (a stale committed
  contract artifact drifting from the live SDK) applies to the SDK repo itself
  (`etc/goodvibes-sdk.api.md`) and possibly to consumers that snapshot contracts —
  **not** to this repo. Ruled out for the agent.
- **`package-install-check.ts`** (302 lines) performs a real global-install smoke test
  (spawns actual `bun`/`npm` installs with a 420s timeout and a redacted-token
  sentinel check) gated behind `verifyPackageCliInstall` passing first. Read, not
  executed (out of scope for a read-only audit — it does real installs). No SDK-
  version-specific logic found in it beyond what `package-verification.ts` already
  supplies.
- **Tarball size/path checks** (`publish-check.ts`): 50MB cap, required/forbidden path
  lists — none of these reference the SDK version or contract shape; unaffected by
  the pin bump.

## Summary (ranked)

| # | Finding | By-design / blocker | Action needed at Wave-6 |
|---|---|---|---|
| 1 | Overlay-marker hard-fail on `publish:check` | **BY DESIGN** (confirmed live) | Run `bun scripts/sdk-dev.ts restore` — known step |
| 2 | Cached/pinned 0.38.0 install genuineness | Verified genuine, no poisoning | None |
| 3 | `session-spine` subpath + `RegisterSharedSessionInput` control-plane export missing from npm 0.38.0; consumed by live agent source | **REAL, sharpened blocker** | Publish SDK 0.39.0 with these exports, bump the pin, restore, and typecheck — as one atomic step, in that order, not restore-then-bump-later |
| 4 | Second bypass path for the overlay/import gates | Ruled out — none found | None |
| 5 | Marker-file-only integrity check (no content-hash cross-check) | Hardening gap, not a defect | Optional follow-on: hash-verify installed dist against `bun.lock` integrity |
| 6 | Hardcoded versions / stale pins / stale local-spine-client assumptions / contract re-sync in release scripts | Ruled out — none found beyond #3 | None (coverage-gate floors will need ordinary re-measurement post-bump) |

---
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017dUjUuzaHwTcMjMvkbs2wB
