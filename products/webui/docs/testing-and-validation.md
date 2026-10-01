# Testing and validation

The WebUI is a monorepo product. Run installation and the engine build from the
monorepo root, then the commands below from `products/webui`. Its source and
browser harness originate at upstream `dadf57700668fe4500b17b0b0b4520715ab25ef4`.
No standalone release workflows are installed by this port.

## Required product checks

| Command | Evidence |
| --- | --- |
| `bun run typecheck` | Browser, scripts and Playwright programs compile; compiler file enumeration covers every authored TypeScript file |
| `bun run lint` | Type-aware ESLint rules over the product |
| `bun run test` | Isolated Bun behavior tests, with happy-dom and synthetic daemon/browser seams |
| `bun run generated:check` | Checked-in settings, ownership and presentation match public workspace engine data |
| `bun run build` | Generated-data check followed by an actual Vite production browser bundle |
| `bun run release:gate` | Workspace engine dependency, lock record and public export boundaries |
| `bun run e2e --project=phone --project=desktop` | Real Chromium over the built app with stateful synthetic daemon responses |
| `bun run e2e --project=lan-origin` | Actual private-network HTTP origin posture where the host provides that interface |

The product checks do not replace the monorepo's architecture, source accounting,
contract, judgment, typecheck or release gates. A successful mock browser run does
not prove real daemon composition or complete the remaining JEV obligations.

## Focused work

`bun run test <file>` runs a unit slice through the guarded engine runner. `bun run test:changed` selects tests
whose import graph changed from `origin/main`. `bun run e2e <spec> --project=phone`
runs a browser slice. Run changed behavior and all required aggregate checks on
the final integrated code.

Useful foundation specs include `chat-journey`, `chat-session-switch`,
`shell-layout`, `phone-smoke`, `settings-config`, `pairing`, `daemon-receipts`,
`command-palette`, `pwa-offline` and `design-proof`. Context-window regressions
cover known/unknown/non-local sessions; receipt regressions cover StrictMode and
stable-ID replay after sign-out and reattachment.

The unit runner clears inherited credentials and user-state paths, guards real
network calls, owns child-process lifetime and temporary storage, and retains the
product's isolated-module and DOM preloads. Do not bypass it with direct `bun test`.

## Browser isolation

Playwright builds this product and serves it on port 4318. The API proxy targets
only the local 503 stub on 59991. Each test owns its stateful in-page mock and its
browser context; no live providers, mail, credentials or payments are used. Build
and preview skip machine CLI/settings discovery. Phone tests use 390×844 and
desktop tests use 1280×800. The LAN project uses a real private-network address. When LAN coverage is
requested (including the full matrix), an unavailable interface produces an
explicit unsupported failure. Phone/desktop projects can be selected independently.

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when the environment provides an existing
Chromium executable. Otherwise Playwright uses its installed browser. Use
`--workers=1` when sharing a constrained compiler/browser host.

The monorepo's `WebUI browser (phone, desktop, LAN)` CI job restores the existing
engine build artifact, installs Chromium with the official Playwright installer,
and runs `bun run e2e --project=phone --project=desktop --project=lan-origin --workers=2`.
The harness checks generated data, builds the production app, starts its own
synthetic stub, and serves that app. It refuses existing servers in CI. A stub
bind failure or missing private interface fails the lane rather than borrowing
an unknown daemon or skipping required LAN coverage. This job gates automatic
release alongside the other monorepo checks.

`DESIGN_PROOF_SHOTS=e2e/.artifacts/screenshots` captures the design-proof states
in both viewports. CI always uploads available HTML reports, failure traces,
screenshots, and the console log as `webui-browser-proof`, retained for seven
days. Setup or launch failures are failures; they are not browser assertions.
The restricted local environment has executed no app assertions, so ordinary
CI must supply that evidence before browser parity can be claimed.

`bun run test:live` remains a separate opt-in local-daemon smoke. Review its boot
configuration and dependencies before running; it does not submit model turns,
and it is not part of the synthetic default suite.

## Generated data and packaging

`bun run release:prepare` regenerates config schema, ownership and presentation
from the actual workspace engine and updates versioned icon/manifest URLs. It
does not install dependencies, bump versions, rewrite remote workflow pins,
commit, tag or publish. `bun run generated:check` verifies these snapshots without
rewriting them before a production build. Engine version numbers are not faked
to match the former independently published SDK.

`bun run pack:bundle` packs the real `dist/` into the deterministic static archive
layout understood by the daemon installer. The monorepo owns release versioning,
CI topology, tags, publication and the final release acceptance decision.
