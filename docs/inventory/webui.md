# Web UI inventory: goodvibes-webui to products/webui

Every tracked file of goodvibes-webui (608 files, from `git -C ~/Projects/goodvibes-webui ls-files`), read in full, with its disposition and, for a JEV file, its decision points. Nothing is dropped unless it is specific to WRFC or QEMU; the intent document's only DROP call for this product (the permission mode sheet and `lib/permission-mode`) is void per the owner ruling of 2026-09-26, so those two files carry JEV instead, becoming the gate presets sheet. Nothing else in this product is WRFC- or QEMU-specific, so this inventory has zero DROP rows.

The web UI is a thin client over the daemon contract: it does not itself judge anything. Every real decision point that the old product's DATA depends on (spam/priority scoring, merchant qualification, review verdicts and acceptance checklists, best-of-N attempt selection, memory confidence, knowledge relevance and specificity) is already computed server-side, and is already inventoried as JEV or HOIST, in packages/engine (docs/inventory/engine.md) or in products/daemon (docs/inventory/daemon.md). What this product's own code does is render that already-judged state, dispatch on already-closed wire enums and HTTP-status/error-type predicates, and run deterministic security and format checks (card material redaction, secret-key redaction, WebAuthn step-up, money formatting) - none of that is a decision point.

Two files in this product genuinely guess client-side over open-ended text, and are marked JEV with a recorded decision point:
- `src/lib/presentation-bridge.ts`'s `classifyBadgeTone`, a self-labelled "heuristic" that classifies an arbitrary status string (used across sessions, providers, knowledge jobs and accounts) into one of four badge tones by a substring-keyword ladder.
- `src/lib/model-catalog.ts`'s `detectFamily`, a twelve-entry regex ladder guessing a model's vendor family from its id/label text, for a display-only "group by family" picker filter. This one is flagged for an owner ruling in its own note: it is a UI grouping convenience, not an automated routing or tier decision, so it may fall outside what the project's "no vendor or model names in routing or tier rules" rule is aimed at; if the owner reads that rule as "no vendor names anywhere, full stop," the right disposition is to drop the grouping feature rather than give it a Jev reading.

Every file that renders old WRFC-loop state (fleet attempt-judgment and best-of-N candidate selection, review verdicts and acceptance checklists, the workstream/phase/work-item tree and its dependency graph) is marked JEV with a note that it is now a view of the contract tree, per the owner ruling that such views are never DROP. None of those files needed a decision-points row of their own: the judging happens server-side, in the engine's contract runner, not in this client. `src/components/confirm/PermissionModeSheet.tsx` and `src/lib/permission-mode.ts` are the matching JEV pair for the permission-mode-to-gate-presets migration: today a fixed five-mode enum, tomorrow a preset picker over the gate's stakes table.

The UI is not redesigned: every screen, panel, command, style and interaction listed here keeps its current look and behaviour. Security checks, money arithmetic, fixed formats and HTTP status handling are never decision points, in this product as everywhere else.

Files: 608. PORT 577, JEV 31, HOIST 0, DROP 0. Decision points: 2.

| Area | Files | PORT | JEV | HOIST | DROP | Decision points |
|---|---|---|---|---|---|---|
| Page shell and assets | 72 | 72 | 0 | 0 | 0 | 0 |
| Root, packaging and docs | 40 | 35 | 5 | 0 | 0 | 0 |
| Scripts and app entry | 29 | 29 | 0 | 0 | 0 | 0 |
| End-to-end tests | 51 | 46 | 5 | 0 | 0 | 0 |
| Hooks | 35 | 35 | 0 | 0 | 0 | 0 |
| Components: core | 35 | 34 | 1 | 0 | 0 | 0 |
| Components: fleet, model workspace, motion, pairing, peek, pricing | 21 | 18 | 3 | 0 | 0 | 0 |
| Components: settings | 31 | 31 | 0 | 0 | 0 | 0 |
| Components: shell, status, toast, voice | 24 | 24 | 0 | 0 | 0 | 0 |
| Library: a11y to cost-source | 31 | 31 | 0 | 0 | 0 | 0 |
| Library: daemon-health to owner-profile | 34 | 29 | 5 | 0 | 0 | 1 |
| Library: goodvibes SDK client | 2 | 2 | 0 | 0 | 0 | 0 |
| Library: pairing to uuid | 53 | 49 | 4 | 0 | 0 | 1 |
| Library: voice | 24 | 24 | 0 | 0 | 0 | 0 |
| Library: device-node, generated, push, pwa | 23 | 23 | 0 | 0 | 0 | 0 |
| Views: chat | 33 | 33 | 0 | 0 | 0 | 0 |
| Views: sessions | 14 | 12 | 2 | 0 | 0 | 0 |
| Views: memory | 13 | 13 | 0 | 0 | 0 | 0 |
| Views: knowledge | 8 | 8 | 0 | 0 | 0 | 0 |
| Views: fleet, workstream and approvals | 12 | 6 | 6 | 0 | 0 | 0 |
| Views: calendar, dates, check-in, checkpoints, CI, mail, phone, principals | 16 | 16 | 0 | 0 | 0 | 0 |
| Views: admin, chat, knowledge and providers wrappers | 7 | 7 | 0 | 0 | 0 | 0 |

## Page shell and assets

| File | Disposition | Note |
|---|---|---|
| `index.html` | PORT | The Vite entry document: icon/manifest links (each cache-busted with a literal `?v=` version string), theme-color meta, and the `#root` mount plus `<script src="/src/main.tsx">`. Fixed markup, no logic. |
| `public/favicon-16x16.png` | PORT | Static favicon asset referenced by index.html. |
| `public/favicon-32x32.png` | PORT | Static favicon asset referenced by index.html. |
| `public/favicon.ico` | PORT | Static favicon asset referenced by index.html and the service worker's precache list. |
| `public/favicon.png` | PORT | Static favicon asset. |
| `public/goodvibes-icon.png` | PORT | Brand mark image; also in the service worker's precached shell list. |
| `public/icons/apple-touch-icon-180.png` | PORT | Static PWA icon referenced by index.html. |
| `public/icons/icon-192.png` | PORT | Static PWA icon; also the Web Push notification icon/badge in public/sw.js. |
| `public/icons/icon-512.png` | PORT | Static PWA icon listed in manifest.webmanifest. |
| `public/icons/icon-maskable-512.png` | PORT | Static maskable PWA icon listed in manifest.webmanifest. |
| `public/manifest.webmanifest` | PORT | Fixed PWA manifest JSON (name, icons, display mode, theme colors). Pure data, no decision logic. |
| `public/sw.js` | PORT | The installable app's service worker: precaches the app shell and hashed build assets (cache-first), never caches `/api/*` or other daemon-owned data paths (`isNeverCache`, a fixed prefix list), and handles Web Push display/click and `pushsubscriptionchange` self-heal. Every branch (`isNeverCache`, `isCacheableAsset`, the approval/needs-input notification-data checks, `linkForNotification`'s `data.kind === 'approval' \| 'needs-input'` dispatch) is a structural check on the daemon's own typed wire shape (`PushMessage.data.kind`), not guesswork over free text. |
| `scripts/cache-bust-check.test.ts` | PORT | Exercises `checkCacheBust` (unit cases plus a real CLI run against fixture directories and the repo's own index.html/package.json). Follows cache-bust-check.ts. |
| `scripts/cache-bust-check.ts` | PORT | Build gate: extracts every `?v=` value from index.html via a fixed regex (`/\?v=([^"'&\s]+)/g`, matching the query-string's own syntax, not prose) and fails the build if any value differs from package.json's version, or if none exist at all (no vacuous pass). Exact string comparison, not a decision point. |
| `scripts/internal-identifier-check.test.ts` | PORT | Exercises the identifier-ban rule (positive/negative fixtures for every banned shape, the exemption list, and a real CLI run against a fixture git repo). Follows internal-identifier-check.ts. |
| `scripts/internal-identifier-check.ts` | PORT | Build gate banning internal planning-identifier shapes (workstream/wave/work-order/debt-register/finding ids) from every git-tracked text file, via a fixed list of syntactic regexes matching literal token SHAPES (`WS-?[0-9]{1,2}`, `DEBT-[0-9]+`, etc.), plus one reviewed, hardcoded exemption (its own test file). This is a structural token-shape ban, not a natural-language classification of meaning, so it is not a decision point; note that its own list documents these ids as project-planning shorthand that must never reach code/docs, consistent with this project's own working rules. |
| `scripts/typecheck-coverage.test.ts` | PORT | Exercises `findUncoveredFiles`/`listRepoTypeScriptFiles`/`listProjectFiles` against synthetic sets and the real repo. Follows typecheck-coverage.ts. |
| `scripts/typecheck-coverage.ts` | PORT | Build gate: compares the set of tracked/untracked TypeScript files (`git ls-files`) against the set `tsc --listFilesOnly` actually loaded for each configured project, and fails naming any file in neither. Pure set-difference over exact file paths, not a decision point. |
| `src/styles/components/admin.css` | PORT | Component stylesheet, verbatim per the intent's "every CSS file verbatim" rule. Presentation only. |
| `src/styles/components/approvals.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/attempt-comparison.css` | PORT | Component stylesheet for AttemptComparison.tsx's best-of-N candidate/pick modal. Styles the contract-tree attempt-judgment view (see views batch for that .tsx file's JEV disposition); the CSS itself is presentation-only layout/color rules over shared design tokens, so it stays PORT regardless of what feature it styles. |
| `src/styles/components/auth-gate.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/calendar.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-actions.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-artifacts.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-composer.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-search.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-stream.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/chat-view.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/checkin.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/checkpoints.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/ci-watches.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/command.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/confirm-sheet.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/dates.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/device.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/diff-multibuffer.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/feedback.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/fleet.css` | PORT | Component stylesheet for FleetView.tsx's process tree/contract-tree rendering. Presentation only; stays PORT (see attempt-comparison.css note). |
| `src/styles/components/hosted-sessions.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/knowledge.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/mail.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/memory.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/memory-diagnostics.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/memory-provenance.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/modal.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/model-workspace.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/notifications.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/owner-profile.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/pairing-handoff.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/pairing-scanner.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/pairing-tokens.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/peek.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/power.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/pricing.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/principals.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/providers.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/queued-messages.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/session-changes.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/session-rewind.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/sessions.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/settings.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/status.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/tailscale.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/task-graph.css` | PORT | Component stylesheet for TaskGraphPanel.tsx's workstream task graph. Presentation only; stays PORT (see attempt-comparison.css note). |
| `src/styles/components/toast.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/voice.css` | PORT | Component stylesheet, verbatim. |
| `src/styles/components/workstream.css` | PORT | Component stylesheet for WorkstreamView.tsx (the contract-tree view). Read in full: layout, badges, and a phone-width master/detail media query, all over shared design tokens. Presentation only; stays PORT (see attempt-comparison.css note). |
| `src/styles.css` | PORT | Read in full (2103+ lines). Global rendering rules, the app shell/sidebar/topbar/panel/badge/chat-message/composer/markdown-code layout for the whole app, built entirely on custom-property tokens from tokens.css and presentation-tokens.css. One structural note: `.badge::before { content: attr(data-contract-glyph); }` renders the SDK presentation contract's glyph as generated CSS content (not a DOM text node), consuming the already-computed `data-contract-glyph`/`data-contract-state` attributes that StatusBadge.tsx/presentation-bridge.ts set (see the Components/Library batches for that classification's JEV disposition) - this file only paints the glyph, it does not classify anything itself. |
| `src/styles/generated/presentation-tokens.css` | PORT | GENERATED FILE (produced by scripts/generate-presentation-tokens.ts from the SDK's presentation contract). A literal, checked-in snapshot of glyph/tone custom properties; regenerated, not hand-maintained. Carries over exactly, regenerated against the engine's own presentation contract post-port. |
| `src/styles/skeleton.css` | PORT | Component stylesheet (loading shimmer keyframes), verbatim. |
| `src/styles/tokens.css` | PORT | The web UI's own design-token source of truth (dark/light theme palettes, density, spacing/radius/typography/motion/z-index scale). Explicitly documented in its own header as a webui-only visual-identity layer, separate from the SDK presentation contract. Verbatim per the intent document; "the UI is not redesigned." |

## Root, packaging and docs

| File | Disposition | Note |
|---|---|---|
| `bunfig.toml` | PORT | Bun install linker pin and test-preload order (temp-root repoint, then test-setup). Deterministic tooling config. |
| `bun.lock` | PORT | Bun lockfile; exact dependency resolution, no guesswork. |
| `CHANGELOG.md` | PORT | Historical per-release changelog, prose entries describing shipped changes; a durable record, not a decision point. |
| `docs/architecture.md` | JEV | Describes the WebUI's architecture including a dedicated "Permission mode, context usage, cost, and compaction" section (the `plan/normal/accept-edits/auto/custom` wire vocabulary read from `sessions.permissionMode.get/set`) and the realtime-invalidation table's `fleet` domain (the live fleet snapshot the Fleet/Workstream views read). Permission mode becomes the gate presets sheet and the workstream tree becomes a contract-tree view; this doc's description of both changes accordingly. No guesswork of its own (it is prose describing a wire contract), so no decision-points row. |
| `docs/assets/screenshots/admin.png` | PORT | Screenshot of the Admin view for the screenshot tour. UI is not redesigned, so the captured layout stays accurate. |
| `docs/assets/screenshots/calendar.png` | PORT | Screenshot of the Calendar view. |
| `docs/assets/screenshots/chat.png` | PORT | Screenshot of the Chat view. |
| `docs/assets/screenshots/collapsed-sidebar.png` | PORT | Screenshot of the collapsed-sidebar layout. |
| `docs/assets/screenshots/fleet.png` | PORT | Screenshot of the Fleet view (the process tree's visual layout is unchanged; only the review/attempt data behind it is now Jev-sourced, not the pixels). |
| `docs/assets/screenshots/knowledge.png` | PORT | Screenshot of the Knowledge view. |
| `docs/assets/screenshots/memory.png` | PORT | Screenshot of the Memory view. |
| `docs/assets/screenshots/providers.png` | PORT | Screenshot of the Providers view. |
| `docs/assets/screenshots/sessions.png` | PORT | Screenshot of the Sessions view. |
| `docs/decisions/2026-07-07-e2e-ci-in-ci.md` | PORT | Decision record for wiring the Playwright suite into CI (non-blocking, then promoted to blocking same day after a real spec defect). Structural CI/job-graph reasoning throughout, no guesswork. |
| `docs/deployment.md` | PORT | Reference for reaching the app from another machine (same-origin serving, Tailscale, the rendezvous relay) and installing it. Deterministic networking/config reference. |
| `docs/development.md` | PORT | Dev-server binding precedence, environment variables, local code map, coding rules, versioning steps. Deterministic reference. |
| `docs/known-limitations.md` | PORT | Intentional gaps and constraints. Its one passing mention of "fleet workstream rows" lacking a wire event is about realtime-push staleness, not a description of workstream/permission-mode behavior itself, so it carries over unchanged under the contract-tree view. |
| `docs/operator-guide.md` | JEV | Dedicates a "## Sessions" passage to permission mode (session-scoped, read/set from the toolbar chip, `custom` read-only) and a "## Workstream" section describing "workstreams, their phases, and their work items, rendered from the same fleet snapshot the Fleet view uses." Both subjects change under this port: permission mode becomes the gate presets sheet, and the Workstream view becomes a view of the contract tree. The guide itself only describes behavior; it contains no guesswork, so no decision-points row. |
| `docs/push-approval-actions.md` | PORT | Documents the Approve/Deny push-notification hand-off (deep link, fragment parse, why background one-tap decide is deliberately unbuilt). Approvals allow/deny is a deterministic daemon decision, unrelated to permission-mode or WRFC; carries over unchanged. |
| `docs/screenshot-tour.md` | PORT | Per-view screenshot captions. Its one mention of the "Approvals/Workstream pair" is a view-name reference in a list of surfaces without captures yet, not a behavior description; the Workstream view it names becomes the contract-tree view but the caption text itself needs no change in kind. |
| `docs/sdk-surface-matrix.md` | JEV | Its matrix rows for "Permission mode" (`sessions.permissionMode.get/set`, session-scoped) and "Fleet" (canonical state "Daemon process tree", owner "Fleet, Workstream") document exactly the two surfaces this port changes (gate presets, contract tree). Reference table, no guesswork of its own. |
| `docs/sdk-update-checklist.md` | JEV | Its "Source checks" section runs `rg -n "wrfc|workmap|owner_decision|owner decision|route selector|resume hooks" src` as a checklist step and instructs "Do not add WRFC/workmap surfaces unless there is a WebUI-facing product request." Once WRFC is replaced by the contract runner throughout the platform, this grep and its wording describe a check against a vocabulary that no longer exists in the source; the checklist's underlying intent (do not casually add engine-internal surfaces during an SDK bump) survives under contract-runner terms, but the literal pattern needs updating. No guesswork of its own (a fixed grep pattern is deterministic), so no decision-points row; the checklist step's search terms are what changes, not a judged reading. |
| `docs/security.md` | PORT | Trust-boundary, auth, relay/step-up, Web Push, network, and logging notes. Deterministic security reference; security content stays code/reference, never judged. |
| `docs/troubleshooting.md` | PORT | Symptom-to-fix reference for dev server, auth, QR scanner, wake word, chat, providers, attachments, Knowledge scoping, and stale Vite caches. Deterministic diagnostic steps and fixed string checks throughout. |
| `docs/ux-overhaul/EXECUTION-15.md` | PORT | Self-labelled "Historical record from the July 2026 UX overhaul, kept for provenance... does not document current behavior." A completed project's own execution-batching notes; kept verbatim as history, like `CHANGELOG.md`. |
| `docs/ux-overhaul/PLAN.md` | PORT | Also self-labelled historical/provenance-only. Its "## Validation & WRFC" section records that the historical UX-overhaul effort was itself reviewed via WRFC (threshold 10/10); this is a fact about how past work was validated, not live tooling or product code, so it is not WRFC- or QEMU-specific code within the meaning of the drop rule, and it stays as historical record. Its use of "workstream" is that project's own parallel-execution unit of work (Foundation workstream, Integration workstreams), a different sense from the product's fleet/workstream feature. |
| `docs/ux-overhaul/TOKEN-CONTRACT.md` | PORT | Also self-labelled historical/provenance-only. Names the design-token vocabulary (`--surface-base`, `--space-*`, etc.) the current `src/styles/tokens.css` still carries; kept as the historical record of where those names came from. |
| `eslint.config.js` | PORT | Flat ESLint config: TypeScript strict/stylistic rule sets, React hooks/refresh/a11y plugins, and a handful of explicit rule-severity overrides. Fixed rule-id-to-severity table, no guesswork. |
| `.github/workflows/ci.yml` | PORT | CI pipeline: test/typecheck/build/coverage, lint, Playwright e2e (blocking per the linked decision record), and a zero-touch auto-release job that tags and cuts a GitHub Release from `CHANGELOG.md` on a green `main` push. Fixed job graph and shell conditionals throughout. |
| `.gitignore` | PORT | Standard ignore list (build output, secrets, runtime/test scratch, harness state). |
| `LICENSE` | PORT | MIT license text. |
| `package.json` | PORT | npm/bun package manifest: scripts (dev/build/test/e2e/lint/gate), dependencies, devDependencies. |
| `playwright.config.ts` | PORT | Playwright harness config: hermetic webServer (dev server + a 503-only daemon stub), phone/desktop/lan-origin projects, fixed private-network-address detection by IPv4 octet ranges (RFC 1918 ranges, an exact numeric-range check, not a guess). |
| `.prettierignore` | PORT | Prettier ignore list (build output, dependencies, generated/binary files). |
| `.prettierrc.json` | PORT | Prettier formatting options (fixed key/value config). |
| `README.md` | JEV | The "What's in the box" table documents "Sessions" as having "per-session permission mode" and lists "Approvals / Tasks / Workstream" as one surface ("Decision queues and orchestration state"), both of which change under this port (gate presets, contract-tree view). Prose description only, no guesswork of its own. |
| `toolchain.config.json` | PORT | Shared-toolchain configuration: SDK pin source, lockfile, overlay marker, source roots, exports-map enforcement. |
| `tsconfig.base.json` | PORT | Shared TypeScript compiler options for the repo's three source trees (src, scripts, e2e). |
| `tsconfig.json` | PORT | TypeScript project for `src/` (DOM lib, react-jsx, bun-types/vite-client types), extends the base config. |
| `vite.config.ts` | PORT | Vite config: SDK-overlay production-build guard, daemon-resolved dev-server host/port/proxy resolution (via `goodvibes-daemon webui status --json` with a `--help`-gated capability check, falling back to the legacy `goodvibes web --json` / TUI settings path), and a fixed vendor-chunking table by package name. Every branch is a structural fallback chain over JSON/CLI output, not a guessed classification. |

## Scripts and app entry

| File | Disposition | Note |
|---|---|---|
| `scripts/coverage.ts` | PORT | Sweeps stale scratch dirs then runs `bun test --isolate --coverage`. Deterministic process orchestration. |
| `scripts/e2e-daemon-stub.ts` | PORT | Hermetic e2e stub server answering a deliberate fixed 503 for the few requests Playwright's page mocks cannot intercept (real service-worker-controlled requests). Fixed status code, no classification. |
| `scripts/generate-config-ownership.test.ts` | PORT | Determinism/drift/up-to-date tests for the config-ownership generator below it. |
| `scripts/generate-config-ownership.ts` | PORT | Build-time snapshot generator: copies the SDK's `DAEMON_OWNED_CONFIG_*` tables verbatim into `src/lib/generated/config-ownership.ts`. Pure data snapshot and byte-for-byte diff, no guesswork. |
| `scripts/generate-config-schema.ts` | PORT | Build-time snapshot generator: copies `CONFIG_SCHEMA` and `FEATURE_SETTINGS` verbatim into `src/lib/generated/config-schema.ts`. Pure data snapshot, no guesswork. |
| `scripts/generate-presentation-tokens.test.ts` | PORT | Determinism/drift/up-to-date tests for the presentation-tokens generator below it. |
| `scripts/generate-presentation-tokens.ts` | PORT | Build-time snapshot generator: copies the SDK presentation contract's glyphs/tones/spinner frames/thinking phrases verbatim into a TS module and a CSS custom-properties file. Pure data snapshot, no guesswork (the mapping logic that uses these values lives in `src/lib/presentation-bridge.ts`, inventoried separately). |
| `scripts/helpers/project-temp.ts` | PORT | Scratch-directory helper for this repo's own tests: creates temp dirs under an in-repo `.test-tmp/`, registers cleanup, and sweeps stale ones by a fixed known-prefix list and age threshold. Deterministic. |
| `scripts/live-daemon-smoke-runner.ts` | PORT | Parent-process wrapper that runs the live-daemon smoke in a child and deletes its scratch tree only after the child has fully exited (deterministic cleanup ordering). |
| `scripts/live-daemon-smoke.ts` | PORT | Boots a real daemon and drives a real session create/list/stream round-trip against it as a non-hermetic smoke lane. All assertions are on real wire responses (object shape, presence of a session id), not text classification. |
| `scripts/pack-bundle.test.ts` | PORT | Tests for the release-bundle packer: layout, checksum manifest, determinism, refusal without `index.html`. |
| `scripts/pack-bundle.ts` | PORT | Packs `dist/` into the release tar.gz asset with a SHA256SUMS.txt manifest, deterministically (sorted entries, zeroed ownership, epoch timestamps). No guesswork. |
| `scripts/release-gate.ts` | PORT | Thin exec of the shared `@pellux/goodvibes-toolchain` sdk-pin-gate CLI. No gate logic of its own. |
| `scripts/sdk-dev.test.ts` | PORT | Tests for the sdk-dev alias's guard clauses and forwarding. |
| `scripts/sdk-dev.ts` | PORT | Thin alias that locates the canonical SDK-overlay tool in the sibling `goodvibes-sdk` checkout and forwards argv to it. No overlay logic of its own. |
| `scripts/sweep-stale-temp.ts` | PORT | CLI entry point for the stale-scratch-dir sweep, wired as the `pretest` script. Deterministic. |
| `scripts/test-temp-preload.ts` | PORT | Bun test preload entry: sweeps stale run roots then installs this run's temp root. Deterministic. |
| `scripts/test-temp-root.test.ts` | PORT | Tests proving the temp-directory redirect is live and every predicate in test-temp-root.ts can answer both yes and no. |
| `scripts/test-temp-root.ts` | PORT | Points TMPDIR/TMP/TEMP at an in-repo run root keyed by pid, and reaps run roots whose owning process is confirmed dead via `process.kill(pid, 0)`. Deterministic liveness check, not a guess. |
| `scripts/tsconfig.json` | PORT | TypeScript compiler configuration for the scripts tree. |
| `scripts/workflow-shape.test.ts` | PORT | Local structural proof that `.github/workflows/ci.yml` parses and has the expected job graph, timeouts, and no `continue-on-error`. Structural YAML checks, not natural-language classification. |
| `src/App.test.tsx` | PORT | Regression tests for the daemon-unreachable overlay, the health-poll-driven overlay, the no-stored-token gate, and delete-means-delete reconciliation. All assertions are on structural DOM/state, not guessed text meaning. |
| `src/App.tsx` | PORT | The app shell: view routing (a fixed list of `ViewId`s and their icons/labels), auth/health gating (structural network-state checks: 401 vs network-unreachable vs health-poll-down), and the companion-chat sidebar with delete-means-delete reconciliation (a real re-fetch proving absence, not a client-side guess). The `workstream` nav entry is a plain routing table row like every other view; the judgment content it routes to is inventoried under Views: fleet, workstream and approvals. No guesswork of its own. |
| `src/bootstrap.test.ts` | PORT | Tests the insecure-origin entry guard: which origins are treated as secure/local (localhost, loopback, RFC1918 LAN ranges, `.local` mDNS) versus genuinely public, and that the app graph is never imported on an insecure public origin. |
| `src/bootstrap.ts` | PORT | Entry guard: on an insecure non-local origin, renders an honest "needs HTTPS" notice and never imports the app graph; otherwise dynamically imports and mounts the real app. The origin check (`isInsecureTransportOrigin`, in `src/lib/insecure-origin.ts`) is a structural IP-range/hostname match, not natural-language guesswork. |
| `src/main.tsx` | PORT | Entry point: imports global styles and calls `bootstrap()` on the root element. |
| `src/mount-app.tsx` | PORT | Normal secure-context boot: constructs the React Query client, mounts `<App/>`, and registers the service worker. |
| `src/styles-cascade.test.ts` | PORT | Structural/textual guard against a CSS selector-specificity/ordering regression (parses `styles.css`'s rule blocks and asserts scoping), not a rendered-style or content-meaning assertion. |
| `src/test-setup.ts` | PORT | Bun test global setup: registers happy-dom, stubs `matchMedia`, patches `React.act` for the test environment. |

## End-to-end tests

| File | Disposition | Note |
|---|---|---|
| `e2e/approval-push-action.e2e.ts` | PORT | Proves the push "Allow"/"Deny" deep-link hand-off against the mock daemon; exact fragment scrubbing and status-text assertions, no guesswork. |
| `e2e/approvals-depth.e2e.ts` | PORT | Approval queue depth: remember tiers, exec-prompt answerable card, deny-with-reason, durable rules. Every assertion reads the daemon's own `recorded` block; deterministic. |
| `e2e/approvals-push.e2e.ts` | PORT | Proves the SSE-pushed `control.approval_update` frame renders a new pending card without a manual refresh, and the honest polling-vs-live toolbar wording. |
| `e2e/calendar.e2e.ts` | PORT | Calendar events/ICS import-export over `calendar.*` against the mock daemon; sort order, 412 unconfigured note, honest counts. |
| `e2e/chat-journey.e2e.ts` | PORT | The modern-chat-app core: send/reply, auto-title, regenerate-with-retained-history, edit-and-branch. Honest-lineage assertions only. |
| `e2e/checkpoints-tasks-mobile.e2e.ts` | PORT | Checkpoints and Tasks phone mutations behind confirm sheets; desktop vs phone gating, deterministic UI flow. |
| `e2e/ci-fix-session.e2e.ts` | PORT | CI fix-session auto-start and accepted-offer open paths; asserts a real attachable session id, never fabricated. |
| `e2e/credential-status.e2e.ts` | PORT | The three honest credential-status outcomes (available/degraded/refused) against the mock daemon. |
| `e2e/daemon-receipts.e2e.ts` | PORT | Connect-time daemon receipts: shown once, dismissible, never re-shown after reconnect. |
| `e2e/dates.e2e.ts` | PORT | Dates/occasions view: upcoming, plans, open items, state sweep, and the proximity-word-not-a-raw-date rule; a fixed regex check on output shape, not content guessing. |
| `e2e/desktop-unregressed.e2e.ts` | PORT | Confirms the phone-scoped responsive changes do not regress desktop layout (drawer open, side-by-side panes, steer). |
| `e2e/fleet-attention.e2e.ts` | JEV | View of the contract tree: the Fleet nav attention badge and per-node reason text cover `input`/`pick`/`conflict`, where `pick` is the best-of-N attempt-selection wait state (the old WRFC attempt-judging surface, `fleet.attempts.judge`/`.pick`) and `conflict` is a merge-conflict wait on the same contract-runner tree. No client-side guesswork; the daemon/engine already computed the reason. |
| `e2e/fleet-depth.e2e.ts` | PORT | Process-tree steer/detach/stop and inline approve/deny on live agent and watcher nodes; general process supervision, not judgment-specific, unaffected by the WRFC-to-contract-tree change. |
| `e2e/fleet-observed.e2e.ts` | PORT | Externally-launched ("observed") foreign-agent visibility; honest external-kind labeling, excluded from own-agent counts. No judgment content. |
| `e2e/hero-steer-from-phone.e2e.ts` | PORT | The flagship phone journey: drawer, find/read/steer a session. Deterministic UI flow. |
| `e2e/hosted-sessions.e2e.ts` | PORT | Daemon-hosted session list/attach/steer/detach/kill, including the beacon-detach path; hermetic against the mock's stateful `sessions.hosted.*` handlers. |
| `e2e/knowledge-depth.e2e.ts` | PORT | Knowledge consolidation candidates and the prompt-packet builder; the view only renders the score/status/reason the daemon already computed, no client-side scoring. |
| `e2e/lan-origin-posture.e2e.ts` | PORT | Proves the daemon's own "needs https, available via tailscale" wording renders verbatim at a real private-network origin; no client-fabricated reasoning. |
| `e2e/mail.e2e.ts` | PORT | Mail view over `email.*`: the three honest refusal states, populated inbox/peek, HTML-suppression restraint. |
| `e2e/memory-consolidation-receipts.e2e.ts` | PORT | Consolidation receipts panel: pending proposal rendering and the one-tap jump-and-highlight into the review queue. Renders daemon-supplied fields only. |
| `e2e/memory-diagnostics.e2e.ts` | PORT | `ops.memory.get` memory-governance panel: tier chip, budget bar, cache table, tripwire line, and the honest "does not serve" state. |
| `e2e/memory-journey.e2e.ts` | PORT | Memory search/browse/add/review/delete/personas journey against the mock daemon. |
| `e2e/memory-provenance-chip.e2e.ts` | PORT | Proves the memory-provenance chip reads the real `metadata.memory.recordIds` wire field end to end, gated on a client preference. |
| `e2e/model-workspace.e2e.ts` | PORT | Multi-target model picker modal; filter enablement, per-target selection independence. |
| `e2e/pairing.e2e.ts` | PORT | QR pairing hand-off: `#pair=<token>` signs in and the token is scrubbed from the URL. |
| `e2e/pairing-handoff.e2e.ts` | PORT | Pairing hand-off offer bundle (notifications + relay), accept and decline paths. |
| `e2e/pairing-tokens.e2e.ts` | PORT | Paired-device tokens: list/rename/revoke, migrate-this-browser, cross-context revoke proof. |
| `e2e/phone-smoke.e2e.ts` | PORT | Every view (including `workstream` and `fleet`) renders on a phone with no horizontal overflow; a rendering/layout sweep only, asserts no content. |
| `e2e/power.e2e.ts` | PORT | Host sleep-ownership: keep-awake chip/toggle, "held because X" line, honest lid-split note. |
| `e2e/pwa.e2e.ts` | PORT | Manifest, service worker cache-honesty, and the Web Push subscribe/unsubscribe/reconcile client, all against mocked browser push APIs. |
| `e2e/queued-messages.e2e.ts` | PORT | Interaction-wins queued-message list/edit/delete against the stateful chat mock. |
| `e2e/settings-config.e2e.ts` | PORT | The Settings modal over `config.get`/`config.set`: domain categories, enum/boolean/money/timezone fields, secret masking, the Advanced editor. Generic config plumbing, no natural-language guesswork. |
| `e2e/shell-layout.e2e.ts` | PORT | Viewport-locked shell invariants: no page scroll, StatusStrip pinned, composer pinned, brand wordmark uncut. |
| `e2e/support/app.ts` | PORT | Shared e2e helpers (`only`, `expectNoHorizontalScroll`, `expectTappable`, `gotoView`); pure layout/geometry assertions, no content interpretation. |
| `e2e/support/assert-contract-shape.test.ts` | JEV | Pins fixture shapes against the real `operator-contract.json`, including `fleet.graph.get` and `fleet.snapshot` (the contract-tree's own wire shapes, its `needsAttention` marker) and `sessions.permissionMode.get`/`.set` (becomes the gate-presets sheet), alongside many unrelated verbs. The check itself (`assertFixtureMatchesOperatorContract`) is a deterministic schema walk, not guesswork, so no decision points; marked JEV because it is a genuine proof over contract-tree and gate-preset wire shapes, per the owner ruling that WRFC-state views (now contract-tree views) carry JEV through their fixtures and tests. |
| `e2e/support/assert-contract-shape.ts` | PORT | The generic per-method output-shape walker (`walk`/`assertFixtureMatchesOperatorContract`) itself: presence/closed-schema checks over `operator-contract.json`, applies identically to every verb, no natural-language interpretation. |
| `e2e/support/chat-mock.ts` | PORT | Stateful in-memory companion-chat mock (sessions/messages/turns/steer/regenerate/edit-branch/queued-messages); deterministic route handlers over an in-memory store. |
| `e2e/support/mock-daemon.ts` | JEV | The hermetic mock daemon's route table. Two of its many served verb families are contract-tree/gate-preset surfaces: `fleet.graph.get` (`fleetGraphResponse`, the workstream dependency-graph fixture, lines ~829-852) and `sessions.permissionMode.get`/`.set` (lines ~1651-1665, the mode string the gate-presets sheet will read/write). Every other route (payments, memory review-queue, CI, pairing, power, push, voice, and so on) is plain deterministic mock-server dispatch. No guesswork anywhere in this file (route matching is exact path/method dispatch); no decision points. |
| `e2e/support/onnx-fixture.ts` | PORT | Hand-built loadable ONNX `Identity` model fixtures (protobuf byte construction) for the wake-word e2e; pure binary construction, no content interpretation. |
| `e2e/support/push-mocks.ts` | PORT | Fakes `serviceWorker`/`PushManager`/`Notification` so the real push client logic runs against controllable stand-ins. |
| `e2e/support/seed.ts` | JEV | Seed fixtures for `fleet.snapshot`, including nodes of kind `workstream`/`phase`/`work-item` (e.g. `workstream-pick-3`, the workstream keyed to `mock-daemon.ts`'s `FLEET_GRAPH_WORKSTREAM_ID`) - contract-tree fixture data, not guesswork. The rest of the file (calendar, memory, mail, providers, pairing, etc. fixtures) is plain deterministic fixture data too; no decision points anywhere in this file. |
| `e2e/support/voice-mock.ts` | PORT | Voice/local-voice/wake-word route mocks and a fake `AudioContext`; deterministic state machine over seeded options. |
| `e2e/tailscale-serve.e2e.ts` | PORT | One-action Tailscale https serve: quiet absence, confirm-gated action, honest success/failure receipt. |
| `e2e/task-graph.e2e.ts` | JEV | Renders `fleet.graph.get`'s dependency graph for one workstream (ready/running/blocked/stalled/done, the at-cap pool note) in both the Workstream and Fleet detail panes - a direct view of the contract tree per the owner ruling. No guesswork in the test itself (it asserts against the daemon's fixed fixture); no decision points. |
| `e2e/touch-targets.e2e.ts` | PORT | 44px touch-target floor audit across the phone hero journey; rendered-box geometry only. |
| `e2e/tsconfig.json` | PORT | TypeScript config for the Playwright specs and the `bun:test` support harness; extends the base config, adds DOM libs. |
| `e2e/turn-control.e2e.ts` | PORT | Server-side stop/steer/queue-when-busy against the held-reply chat mock; wire-call and badge assertions. |
| `e2e/visual-proofs.e2e.ts` | PORT | Screenshot captures plus computed-contrast/luminance assertions for themed surfaces; deterministic pixel/CSS-computed-value checks, not content judgment. |
| `e2e/voice.e2e.ts` | PORT | TTS playback and mic dictation honest-state matrix against a hermetic voice mock; state assertions only, no real audio. |
| `e2e/voice-local-setup.e2e.ts` | PORT | Managed local-voice one-act provisioning: setup, live progress, retriable failure, unsupported platform, older-daemon absence. |
| `e2e/wake-word.e2e.ts` | PORT | Browser-tab wake-word detection: permission gating, real ONNX session creation, chunked/verified model reads, per-origin opt-in, speech-gate blockers. Detection scoring itself is out of scope (fixture models are meaningless-by-design Identity graphs); this proves the pipeline, not a judgment. |

## Hooks

| File | Disposition | Note |
|---|---|---|
| `src/hooks/useAnnouncer.test.tsx` | PORT | Exercises the aria-live announcer store/hook. |
| `src/hooks/useAnnouncer.ts` | PORT | Module-level aria-live announcer store (polite/assertive channels) with a stable region component. Pure DOM/accessibility plumbing, no content classification. |
| `src/hooks/useApprovalUpdates.test.tsx` | PORT | Exercises the approval-update stream consumer. |
| `src/hooks/useApprovalUpdates.ts` | PORT | Opens the raw control-plane stream narrowed to `domains=permissions` and invalidates the approvals/permission-rules query keys on a fixed wire-event name (`approval-update`). Dispatch is exact string equality on a known event name, not guesswork. |
| `src/hooks/useCompactionReceipts.test.tsx` | PORT | Exercises the per-session compaction stream consumer. |
| `src/hooks/useCompactionReceipts.ts` | PORT | Opens the raw control-plane stream narrowed to `domains=compaction`, parses receipts/checks via `lib/compaction.ts`'s defensive wire readers, and appends to a capped (20) per-session log. All deterministic parsing and session-id equality filtering. |
| `src/hooks/useDaemonHealth.ts` | PORT | Composes daemon reachability, auth, working, SSE and route state from several polled queries plus a fixed `FAILURE_THRESHOLD = 2` consecutive-failure counter before declaring the daemon down and trying the relay. The threshold is a deterministic retry/backoff engineering constant on network liveness, not a judged reading of content, so it is not a decision point. |
| `src/hooks/useDaemonReceipts.ts` | PORT | Consumes the daemon's undelivered one-line receipts exactly once per connect (`control.status({ receipts: 'consume' })`), de-duplicated by id. Deterministic queue bookkeeping. |
| `src/hooks/useFocusTrap.test.tsx` | PORT | Exercises the focus-trap hook. |
| `src/hooks/useFocusTrap.ts` | PORT | Traps keyboard focus in a container via a fixed CSS focusable-selector list and keydown/focusin handling. Structural DOM selectors, not content guesswork. |
| `src/hooks/useHostedSessionRealtime.test.tsx` | PORT | Exercises the hosted-session realtime stream consumer. |
| `src/hooks/useHostedSessionRealtime.ts` | PORT | Opens one raw stream narrowed to `domains=session,turn,tools`; dispatches on fixed wire-event names (`hosted-session-update`, `turn`, `tools`) and filters frames by exact session-id match. Deterministic. |
| `src/hooks/useHotkeys.test.ts` | PORT | Exercises combo normalisation and the dispatch pipeline. |
| `src/hooks/useHotkeys.ts` | PORT | Global keydown listener matching fixed keyboard-combo grammar (`mod+k`, two-key sequences like `g c`) via exact string comparison after canonicalisation. Deterministic parsing of a closed key-combo grammar, not natural-language guesswork. |
| `src/hooks/useIsPhoneViewport.ts` | PORT | Reads a fixed `(max-width: 980px)` media query and subscribes to changes. |
| `src/hooks/useMemoryDiagnostics.ts` | PORT | Polls `ops.memory.get` and defensively parses the response via `lib/memory-governance.ts`'s reader; an unparseable 200 is an honest retriable error. No client-side judgment; the memory tier itself is computed by the daemon. |
| `src/hooks/useOriginPosture.ts` | PORT | Fetches this origin's TLS/capability posture once and exposes the daemon's own reason text for a gated capability. Renders the daemon's own wording verbatim rather than fabricating one; no client guesswork. |
| `src/hooks/useOwnerProfile.test.tsx` | PORT | Exercises the owner-profile write hooks' wire payloads (authority stamping, contract-schema conformance). |
| `src/hooks/useOwnerProfile.ts` | PORT | Queries and mutations over `profile.*` verbs, defensively parsed via `lib/owner-profile.ts`'s readers, stamping a fixed `authority: 'owner-direct'` (this surface can truthfully claim it, since only the owner's own settings edits reach these calls). Deterministic wiring, no classification. |
| `src/hooks/usePairingHandoff.test.tsx` | PORT | Exercises pairing hand-off fragment capture and status flow. |
| `src/hooks/usePairingHandoff.ts` | PORT | Captures a `#pair=<token>` (or hand-off bundle) URL fragment synchronously at first render, validates it against the daemon, and surfaces any offer set / origin posture notice. Deterministic fragment parsing and state machine. |
| `src/hooks/usePowerStatus.ts` | PORT | Polls/mutates `power.status`/`power.setKeepAwake`. Plain query/mutation wiring. |
| `src/hooks/usePushSubscriptionReconcile.test.tsx` | PORT | Exercises the push-subscription reconcile-on-open hook. |
| `src/hooks/usePushSubscriptionReconcile.ts` | PORT | Fires a push-subscription reconcile on the rising edge into `enabled` and on a fixed service-worker message type (`goodvibes-push-subscription-changed`). Deterministic. |
| `src/hooks/useRealtimeInvalidation.test.tsx` | PORT | Exercises the single multiplexed control-plane stream and its per-domain invalidation map, including the connection-budget regression it pins. |
| `src/hooks/useRealtimeInvalidation.ts` | PORT | Opens one multiplexed control-plane stream and invalidates query keys via a fixed `Record<domain, queryKeys[]>` lookup table (`DOMAIN_INVALIDATIONS`), keyed on the wire frame's own domain name. This is exact-key dispatch over a closed, code-defined set of domain strings the daemon itself emits, not a guessed classification of open-ended text; its `permissions` row invalidates the `sessions` prefix because `PERMISSION_MODE_CHANGED` rides that domain, a routing-table fact, not a heuristic. The permission-mode DATA MODEL itself (which becomes JEV/gate presets) lives in `src/lib/permission-mode.ts`, not here. |
| `src/hooks/useRelayOverflow.ts` | PORT | Reactively reads the relay overflow-accounting snapshot via `useSyncExternalStore`. |
| `src/hooks/useRelayPairingHandoff.ts` | PORT | Captures a `#relay=<code>` URL fragment synchronously and decodes/stores a relay pairing offline. Deterministic fragment parsing. |
| `src/hooks/useSessionRealtime.test.tsx` | PORT | Exercises the raw `session-update` stream consumer. |
| `src/hooks/useSessionRealtime.ts` | PORT | Opens the raw (un-domained) `?domains=session` stream and dispatches on the fixed `session-update` event name, extracting a session id from the frame's own discriminant fields. Deterministic. |
| `src/hooks/useTheme.test.tsx` | PORT | Exercises the theme/density provider and cross-tab sync. |
| `src/hooks/useTheme.ts` | PORT | Theme/density context provider; reads/writes preferences via `lib/theme.ts` and syncs across tabs via `storage`/custom events. No content judgment. |
| `src/hooks/useUrlState.test.tsx` | PORT | Exercises URL-state decode/encode and StrictMode-safe history pushes. |
| `src/hooks/useUrlState.ts` | PORT | Reads/writes `AppUrlState` (view, session, filters) via `lib/router.ts` and `history.pushState`/`replaceState`, subscribing to `popstate`. Deterministic URL codec, not guesswork. |
| `src/hooks/useVoiceLocalSetup.ts` | PORT | Queries/mutates `voice.local.status`/`voice.local.install`, defensively parsed via `lib/voice/voice-local-setup.ts`'s readers, with a fixed short poll interval only while an install is in flight. Deterministic wiring. |

## Components: core

| File | Disposition | Note |
|---|---|---|
| `src/components/AccountsPanel.test.tsx` | PORT | Exercises `AccountsPanel`'s loading/error/empty/populated states; follows AccountsPanel.tsx. |
| `src/components/AccountsPanel.tsx` | PORT | Read-only display of `accounts.snapshot`'s `ProviderAccountSnapshot`: per-provider active route, auth freshness, usage windows, issues, recommended actions. `toAccountRow` reads fixed named fields (`providerId`, `configured`, `activeRoute`, `authFreshness`, `modelCount`, `usageWindows`, `issues`, `recommendedActions`) off a record with typed fallbacks; no open-ended text classification. Renders `authFreshness` through `StatusBadge`, whose tone classification lives in `lib/presentation-bridge.ts` (a different batch), not here. |
| `src/components/auth/DaemonUnreachableGate.tsx` | PORT | The honest "daemon unreachable" state shown when auth.current fails with a NETWORK error while a token is still stored. Deterministic session/connection-state gate, not guesswork, per the project's auth-gate ruling. |
| `src/components/auth/SignedOutGate.test.tsx` | PORT | Exercises SignedOutGate's token/password/QR-scan/relay-pairing flows; follows SignedOutGate.tsx. |
| `src/components/auth/SignedOutGate.tsx` | PORT | The signed-out first-paint front door: QR pairing hand-off, paste-token, password login, relay-pairing code paste, and in-page QR scan. Every branch (`acceptScan`'s switch on `scanned.kind`, `isDifferentOrigin`) is a structural dispatch over a closed, machine-produced payload shape from `lib/pairing-qr.ts`/`lib/relay-pairing.ts` (different batch), not natural-language guesswork. Deterministic session-state / auth gate, per the project's auth-gate ruling. |
| `src/components/auth/StepUpHost.tsx` | PORT | Inline WebAuthn step-up ceremony host: registers a prompter the transport layer calls on a `401 step-up-required`, runs the passkey ceremony, resolves the retry header. All control flow is deterministic promise/ceremony-state bookkeeping (one ceremony at a time, resolve null on cancel/unmount); a security-adjacent deterministic gate, not guesswork. |
| `src/components/command/CommandPalette.test.tsx` | PORT | Exercises the palette's render, keyboard nav, dispatch/close, and filter-via-registry behavior; follows CommandPalette.tsx. |
| `src/components/command/CommandPalette.tsx` | PORT | Cmd-K palette over the command registry: keyboard nav, grouping, dispatch. The actual query filtering (`filterCommands`) lives in `lib/commands.ts` (a different batch); this file only calls it. A client-side instant-keystroke filter over the app's own closed ~7-command list is the deterministic UI typeahead mechanism the project rules carve out, not guesswork Jev should replace. |
| `src/components/command/CommandProvider.test.tsx` | PORT | Exercises children rendering, default-command registration/teardown, and mod+k / Escape palette open-close; follows CommandProvider.tsx. |
| `src/components/command/CommandProvider.tsx` | PORT | Mounts CommandPalette and ShortcutCheatsheet, registers the fixed set of default navigation/system commands (each with a hardcoded id, title, keyword list and shortcut), and wires the mod+k / `?` hotkeys. The per-command `keywords` arrays are static tags on the app's own closed command list for the typeahead filter in `lib/commands.ts`, the same deterministic UI mechanism carved out for CommandPalette, not open-ended guesswork. |
| `src/components/command/ShortcutCheatsheet.tsx` | PORT | Overlay listing every registered command with a shortcut, grouped. Pure presentational filter (`Boolean(cmd.shortcut)`) and render over the command registry; no guesswork. |
| `src/components/confirm/ConfirmSheet.tsx` | PORT | Touch-first confirm/cancel dialog (bottom sheet on phone, centered dialog on desktop). Purely presentational: renders props, calls onConfirm/onCancel; no decision logic of its own. |
| `src/components/confirm/PermissionModeSheet.tsx` | JEV | The intent document's DROP call for this file is void per the owner ruling; it becomes the gate presets sheet. Today it renders a fixed picker of `SETTABLE_PERMISSION_MODES` (from `src/lib/permission-mode.ts`, a sibling file in a different batch) with `permissionModeLabel` captions, lets the operator select a mode for the live session's local permission runtime, and treats `'custom'` as a read-only wire state that never appears as a selectable option (if the session is currently in custom mode, no rendered choice is highlighted as current). Under the gate's stakes-table model this becomes a preset picker over the gate's own graduated-autonomy presets instead of the old fixed permission-mode enum: the same sheet shape (a list of choices, current-mode highlight, pending-write disabling), but the options and their meaning come from the gate's preset table rather than `lib/permission-mode.ts`'s bespoke mode list. This file itself contains no guesswork (it renders whatever option list and labels it is handed), so it needs no Decision points row of its own; the old data model it depended on is what changes. |
| `src/components/confirm/useConfirmSheet.test.tsx` | PORT | Exercises `ask()` resolving true/false and the never-stack-two-sheets rule; follows useConfirmSheet.tsx. |
| `src/components/confirm/useConfirmSheet.tsx` | PORT | Promise-returning confirm gate backed by ConfirmSheet; pure state/promise bookkeeping, no guesswork. |
| `src/components/CredentialStatusPanel.test.tsx` | PORT | Exercises the panel's available/degraded/refused states and the no-secret-bytes-render guarantee; follows CredentialStatusPanel.tsx. |
| `src/components/CredentialStatusPanel.tsx` | PORT | Display-site adoption of the credential-status facade (`lib/provider-status.ts`, different batch). `isAdminRequiredError` checks a fixed HTTP status (403) on a known route's refusal shape, a structural HTTP-status check, not a decision point. `credentialTone`/`credentialLabel` map two closed booleans (`configured`, `usable`) to one of three fixed labels/tones by a plain lookup, not open-ended text classification, so this is not a decision point either. |
| `src/components/DataBlock.test.tsx` | PORT | Exercises title rendering, empty state, and the string-vs-JSON render branches; follows DataBlock.tsx. |
| `src/components/DataBlock.tsx` | PORT | Generic titled data block: renders a string value as markdown, any other value as pretty-printed JSON with a copy button. Pure type-based branch (`typeof value === 'string'`), not a decision point. |
| `src/components/diff/DiffMultibuffer.tsx` | PORT | Renders a parsed unified diff (`lib/unified-diff.ts` `DiffFile`/`DiffHunk`, different batch) as one scrollable multi-file, multi-hunk surface, interactive for session review and read-only for candidate comparison. Pure presentational renderer over structured diff data; the caller-supplied `statusFor` classification (reviewed/reverted/conflict) is consumed here only as an already-computed enum, not derived in this file. |
| `src/components/feedback/EmptyState.tsx` | PORT | Generic icon/title/description/action empty-state presentational component. |
| `src/components/feedback/ErrorBoundary.test.tsx` | PORT | Exercises catch/fallback/reset/onError behavior; follows ErrorBoundary.tsx. |
| `src/components/feedback/ErrorBoundary.tsx` | PORT | React class error boundary with default fallback (formatError'd message + Retry) or a caller-supplied fallback renderer. No guesswork. |
| `src/components/feedback/ErrorState.tsx` | PORT | Inline failed-query state with a Retry action; renders `formatError(error)`. Presentational only. |
| `src/components/feedback/Onboarding.test.tsx` | PORT | Exercises render/dismiss/persistence/steps/action/per-id-independence behavior; follows Onboarding.tsx. |
| `src/components/feedback/Onboarding.tsx` | PORT | Dismissible first-run teaching panel persisted to localStorage per surface id. Plain read/write of a dismissal flag; no guesswork. |
| `src/components/feedback/SkeletonBlock.tsx` | PORT | Animated loading placeholder (block/text/circle variants). Pure presentational sizing logic. |
| `src/components/MarkdownMessage.test.tsx` | PORT | Exercises fenced-code-block copy action and optional line numbers; follows MarkdownMessage.tsx. |
| `src/components/MarkdownMessage.tsx` | PORT | Renders markdown content via `react-markdown` with a custom code-block renderer that syntax-highlights via `lib/highlight.ts` (different batch) and offers a copy button. Language detection is a fixed regex over the CSS class markdown itself assigns (`language-([\w-]+)`), a structural parse of a machine-generated class name, not prose classification. |
| `src/components/modal/Modal.test.tsx` | PORT | Exercises open/close rendering, Escape/backdrop close, and initial focus; follows Modal.tsx. |
| `src/components/modal/Modal.tsx` | PORT | Generic centered dialog: focus trap, Escape/backdrop close, focus-return-to-trigger. Unmounts entirely when closed. Deterministic DOM/focus management, no guesswork. |
| `src/components/RecordList.test.tsx` | PORT | Exercises empty state, item rendering, selection, and onSelect interactivity; follows RecordList.tsx. |
| `src/components/RecordList.tsx` | PORT | Generic list of records rendered as selectable rows or plain rows, using `bestId`/`bestTitle`/`bestStatus` helpers from `lib/object.ts` (a different batch) to pick a display id/title/status off an arbitrary record shape, and `StatusBadge` for the status tone. This file makes no classification decision of its own; it is a consumer of those helpers and of `StatusBadge`. |
| `src/components/StatusBadge.tsx` | PORT | Pure consumer of `classifyBadgeTone`/`contractGlyphForBadgeTone` from `src/lib/presentation-bridge.ts` (a different batch, already established there as the JEV decision point: an open-ended status string classified into ok/warning/bad/neutral by substring-keyword heuristic). This file itself contains no classification logic: it calls the imported function and renders the returned tone as a CSS class plus the contract glyph as a data attribute. The badge-tone decision point lives in `lib/presentation-bridge.ts`, not here. |
| `src/components/StatusBadge.test.tsx` | PORT | Exercises the healthy/pending/failed/expired/expiring/unconfigured/unavailable tone mappings and the contract-glyph data attribute; follows StatusBadge.tsx (and transitively the decision point recorded against `lib/presentation-bridge.ts`). |

## Components: fleet, model workspace, motion, pairing, peek, pricing

| File | Disposition | Note |
|---|---|---|
| `src/components/fleet/NodeTells.tsx` | JEV | One file, one disposition. `NodeHeadline`/`NodeStallBadge`/`NodeStallNote` are deterministic passthroughs: a replaced-in-place headline string and a pure timestamp-comparison "stall tell", both documented in the file itself as "a marker with the raw facts, not a judgment", and rendered identically for both FleetView and WorkstreamView. `NodeReviewSummary`, the same file's other export, renders a reviewed WRFC-chain/subtask node's latest review verdict/score/cycles/acceptance-checklist via `readReviewSummary` (`lib/fleet.ts`). Per the owner ruling, a UI view of WRFC review-loop state is marked JEV even when it does no guessing itself, becoming a view of the contract tree; since that is a real, non-trivial part of this file, the whole file takes that disposition. No decision points: nothing here guesses, it only re-labels the data source. |
| `src/components/fleet/TaskGraphPanel.test.tsx` | JEV | Exercises `TaskGraphPanel.tsx`; follows that file's disposition. |
| `src/components/fleet/TaskGraphPanel.tsx` | JEV | Renders one workstream's fix-phase task/dependency graph from `fleet.graph.get` (SDK 1.8.0): work-item nodes (`wi-1`, `wi-2`, …) with WRFC-chain states (`pending`/`in-phase`/`blocked-dependency`/`passed`/stalled) and their dependency edges, plus the fleet pool summary line. This is a workstream/phase/work-item tree, not a generic tree-layout renderer, so per the owner ruling it is a UI view of WRFC-loop state and becomes a view of the contract tree, marked JEV with that note. The component itself does no guessing (state labels/tones come from fixed-vocabulary helpers in `lib/fleet-graph.ts`, not in this batch), so no decision points. |
| `src/components/model-workspace/ModelWorkspaceModal.test.tsx` | PORT | Exercises `ModelWorkspaceModal.tsx`. |
| `src/components/model-workspace/ModelWorkspaceModal.tsx` | PORT | Multi-target model picker (main/helper/tool/tts/embeddings) with search, provider/price/group filters. All filtering and target-routing logic (`filterModels`, `groupModels`, `readTargetRouting`, `buildTargetWriteEntries`, etc.) lives in `lib/model-catalog.ts`, not in this batch; this file is wiring, queries and rendering over a closed set of five named targets and wire-reported tier/pricing data. No open-ended text classification. |
| `src/components/motion/index.ts` | PORT | Barrel re-export of `Presence`, `Skeleton`, `useReducedMotion`. |
| `src/components/motion/Presence.test.tsx` | PORT | Exercises `Presence.tsx`'s mount/unmount lifecycle and its exit-duration alignment with toast timing. |
| `src/components/motion/Presence.tsx` | PORT | Pure CSS/React mount-unmount transition wrapper (`unmounted`/`entering`/`visible`/`leaving` phases driven by timers and `prefers-reduced-motion`). No external dependencies, no text or content interpretation of any kind. |
| `src/components/motion/Skeleton.tsx` | PORT | Shimmer placeholder `<div>` with configurable width/height/radius. Pure presentation. |
| `src/components/motion/useReducedMotion.ts` | PORT | Reads and subscribes to the `prefers-reduced-motion` media query. Deterministic browser API read. |
| `src/components/pairing/PairingHandoffOffers.test.tsx` | PORT | Exercises `PairingHandoffOffers.tsx`. |
| `src/components/pairing/PairingHandoffOffers.tsx` | PORT | Renders a fixed, hand-authored table of three offer kinds (notifications/relay/passkey), runs the real client-side ceremonies (push subscribe, WebAuthn registration) per accepted offer, then calls `pairing.handoff.complete` and renders the daemon's own outcome per offer against a fixed `completed/declined/unavailable/failed` vocabulary. No guessed classification of prose anywhere; every branch is closed-set. |
| `src/components/pairing/PairingPostureNotice.test.tsx` | PORT | Exercises `PairingPostureNotice.tsx`. |
| `src/components/pairing/PairingPostureNotice.tsx` | PORT | One-shot dismissible banner rendering the daemon's own plain-http-on-LAN notice string verbatim. No client-side interpretation. |
| `src/components/pairing/PairingQrScanner.test.tsx` | PORT | Exercises `PairingQrScanner.tsx`'s camera lifecycle and failure states. |
| `src/components/pairing/PairingQrScanner.tsx` | PORT | Camera lifecycle, frame-grab loop and a fixed `ScannerFailure` vocabulary (`insecure-context`/`no-camera-api`/`permission-denied`/`no-camera`/`camera-busy`/`camera-failed`/`no-detector`) each with hand-written guidance text. Decoding and payload parsing are delegated to `lib/pairing-qr` and `lib/pairing-qr-camera` (not in this batch); this component only handles camera hygiene and renders which of the seven closed failure kinds occurred. No open-ended text classification. |
| `src/components/peek/PeekPanel.test.tsx` | PORT | Exercises `PeekPanel.tsx`'s open/close, focus-trap and focus-restoration behavior. |
| `src/components/peek/PeekPanel.tsx` | PORT | Right-side slide-over panel: focus trap, Escape/backdrop close, focus restoration, deferred unmount for the exit animation. Pure UI mechanics, no content interpretation. |
| `src/components/pricing/ModelPricesModal.tsx` | PORT | Manual model-price editor modal wrapping `ModelPricesEditor` (not in this batch); writes `pricing.modelPrices` and invalidates cost-bearing queries. Deterministic form/config wiring. |
| `src/components/pricing/PriceSourceNote.test.tsx` | PORT | Exercises `PriceSourceNote.tsx`. |
| `src/components/pricing/PriceSourceNote.tsx` | PORT | Formats a dollar display's pricing provenance from the wire's own closed `costSource` enum (`user`/`catalog`/`provider`/`mixed`/absent) plus a dated `pricingAsOf` stamp; offers the Set/Edit price action. Classifying a fixed, machine-defined vocabulary is a structural check, not guesswork; the label text itself is a static lookup table (`lib/cost-source.ts`, not in this batch). |

## Components: settings

| File | Disposition | Note |
|---|---|---|
| `src/components/settings/CvvHandlingField.test.tsx` | PORT | Exercises CvvHandlingField's enum select and the moment-of-selection warning. |
| `src/components/settings/CvvHandlingField.tsx` | PORT | The typed editor for `payments.cvvHandling`: an ordinary enum select over fixed values ('stored' \| 'prompt') that shows the SDK's own fixed warning string when 'prompt' is selected. No guesswork; a closed two-value enum and a static warning string. |
| `src/components/settings/DeviceGrants.tsx` | PORT | Renders daemon-reported durable device grants (devices.grants.list/revoke, devices.housekeeping.run) and their audit ledger. Pure rendering of structured records with revoke/sweep actions; no classification. |
| `src/components/settings/FeatureUnitCard.tsx` | PORT | Renders one platform feature's enablement control (boolean toggle / enum mode select / constant) and its owned settings fields, dispatching on the feature's declared `enablement.kind`, a closed three-value structural switch, not guesswork. |
| `src/components/settings/MailAccountSettings.test.tsx` | PORT | Exercises the mail/calendar status panel's loading, ready, and not-available states, and asserts no credential fields are rendered. |
| `src/components/settings/MailAccountSettings.tsx` | PORT | Read-only status panel probing the mail and calendar surfaces and mapping the daemon's own typed error codes (404/501/CALENDAR_* codes) to a closed set of status pills via `mailRefusalNote` and fixed `isX Error` predicates. Structural error-code dispatch, not free-text classification; never a credential form. |
| `src/components/settings/MemoryDiagnostics.test.tsx` | PORT | Exercises the memory-governance panel's loading/unavailable/error/populated states and tier-to-tone mapping. |
| `src/components/settings/MemoryDiagnostics.tsx` | PORT | Renders the daemon's own memory-pressure snapshot (tier, budget-vs-RSS bar, per-cache table, paused jobs, tripwire line). `memoryTierBadgeClass`/`memoryTierLabel` map a closed tier enum (normal/elevated/high/critical) to a fixed badge tone; structural enum dispatch, not guesswork. |
| `src/components/settings/ModelPricesEditor.test.tsx` | PORT | Exercises the per-model pricing row editor: add/edit/remove, each committing the full replacement table, plus inline validation. |
| `src/components/settings/ModelPricesEditor.tsx` | PORT | Structured editor for the `pricing.modelPrices` object-typed config key: one row per "provider:model" key with numeric input/output/cache-read/cache-write fields. `parseModelPriceDraft` validates shape (a colon-separated key, finite non-negative numbers), a fixed-format check, not a decision point. |
| `src/components/settings/MoneyField.test.tsx` | PORT | Exercises MoneyField's as-typed, unscaled commit behaviour and inline validation of a malformed or negative amount. |
| `src/components/settings/MoneyField.tsx` | PORT | Typed editor for `unit: 'money'` config keys. Stores the amount exactly as typed (no minor-unit conversion), tolerating a stripped leading currency symbol; `parseMoneyAmountInput` is fixed-format numeric parsing, currency arithmetic and format handling that the intent's deterministic-boundary rule keeps as code. |
| `src/components/settings/NotificationSettings.test.tsx` | PORT | Exercises the push/install capability labels' honest per-state copy, including the daemon-posture-reason fallback. |
| `src/components/settings/NotificationSettings.tsx` | PORT | Web Push subscribe/unsubscribe and install (add-to-home-screen) panel. Every "can't" state is a structural read of DOM feature-detection results (`detectPushSupport`, `useInstallPrompt`) and the daemon's own `pairing.posture.get` reason string, rendered verbatim with a static fallback string; no keyword list or score classifies any free text, it only passes through the daemon's own labeled reason. |
| `src/components/settings/OwnerProfileSettings.test.tsx` | PORT | Exercises the owner-profile panel's honesty states (unavailable vs. empty, forget-found-nothing, staleness) and provenance/undo flows against the real contract shapes. |
| `src/components/settings/OwnerProfileSettings.tsx` | PORT | Renders the owner-profile document (profile.read/status/provenance/forget/undo/append verbs): mechanical fields as labelled values, the owner's own prose lines as prose, third-party (People) section flagged inert. Every render is a direct pass-through of daemon-supplied structured fields and verbatim daemon sentences (write/forget outcomes); no keyword list, score, or threshold in this component interprets the prose content itself, it is displayed, appended, or deleted by exact line/section match, never classified. |
| `src/components/settings/PairingTokensSettings.test.tsx` | PORT | Exercises per-device pairing token list/rename/revoke/migrate/revoke-shared flows, all confirm-gated. |
| `src/components/settings/PairingTokensSettings.tsx` | PORT | Per-device pairing token management surface over pairing.tokens.* verbs. Pure CRUD over structured token records (name, created, last-seen) plus two fixed action flows (migrate this browser, revoke shared token); no guesswork. |
| `src/components/settings/PaymentCardEntry.containment.test.tsx` | PORT | Proves a typed card value never reaches a URL, the rendered DOM, browser storage, or the query cache, and is cleared from inputs after submit, against real production code with only `fetch` stubbed. |
| `src/components/settings/PaymentCardEntry.test.tsx` | PORT | Asserts the owner-ruled markup conditions (autocomplete off, no `<form>`, no `name`/password-type inputs, password-manager vendor opt-outs) on the card entry fields. |
| `src/components/settings/PaymentCardEntry.tsx` | PORT | Card-material entry surface implementing the owner's six-condition card-entry ruling: POST body only (never URL), never rendered back, no password-manager save prompt, draft cleared on success. Card BIN/brand handling and money-cap formatting are structural; the per-condition markup and transport choices are deterministic, not decision points, matching the rule that money/card-material handling stays code. |
| `src/components/settings/PowerSettings.test.tsx` | PORT | Exercises the power panel's ruled shape (one toggle, no timers), held-because line, and lid-split note rendering verbatim. |
| `src/components/settings/PowerSettings.tsx` | PORT | Sleep-ownership panel (power.status.get / power.keepAwake.set): one toggle, and verbatim rendering of the daemon's own held-reasons and lid-split note. No client-side classification of any text; every string shown is the daemon's own accounting. |
| `src/components/settings/SettingsField.tsx` | PORT | Generic schema-driven config-field editor, dispatching on the SDK schema's declared type (boolean/enum/number/string/secret/object) and a small set of key-specific specialized editors (timezone, CVV handling, money unit), all keyed by exact schema type or exact config key, a structural dispatch table, not guesswork. Secret masking and secret-store-only refusal are fixed-format/security-boundary logic. |
| `src/components/settings/SettingsModal.test.tsx` | PORT | Exercises the schema-driven settings modal's structure, feature units, honest degraded states, secret-store-only refusals, and the Advanced escape hatch. |
| `src/components/settings/SettingsModal.tsx` | PORT | The schema-driven settings surface: renders CONFIG_SCHEMA-derived groups/feature units/plain rows/raw rows, writes through `config.set` one key at a time, and distinguishes an admin-scope refusal (403) from a generic fetch failure by HTTP status. All structural; no free-text interpretation. |
| `src/components/settings/StepUpSettings.tsx` | PORT | Passkey (WebAuthn) registration and verification surface for relay step-up. Ceremonies call `navigator.credentials.create/get` and the daemon's stepup verbs directly; every failure path renders a fixed message from `describeStepUpError`. Security-boundary mechanics, not a decision point. |
| `src/components/settings/TailscaleSettings.test.tsx` | PORT | Exercises the tailscale panel's quiet-when-absent behaviour and the one confirmed serve action's success/failure receipts. |
| `src/components/settings/TailscaleSettings.tsx` | PORT | The one confirmed "Serve over tailscale" action, gated on structural availability flags (`available && loggedIn && httpsUrl`) from `tailscale.get`, and rendering the daemon's own receipt detail verbatim on success or failure. No guesswork. |
| `src/components/settings/TimezonePicker.test.tsx` | PORT | Exercises the timezone picker's fixed-list rendering, selection commit, and search-filter behaviour, including pinning the current value in. |
| `src/components/settings/TimezonePicker.tsx` | PORT | Searchable select over the real IANA timezone list (`Intl.supportedValuesOf('timeZone')`); `filterTimezoneNames` is a substring filter over a fixed, enumerable name list, not free-text classification. Deterministic, matching the intent's explicit TimezonePicker carve-out. |

## Components: shell, status, toast, voice

| File | Disposition | Note |
|---|---|---|
| `src/components/shell/AppShell.tsx` | PORT | Phase-2 provider-nesting shell (Theme, ErrorBoundary, Toast, Command, Peek providers) and two command registrations (theme/density toggle) with fixed literal keyword lists for command-palette search only (see command-groups precedent: closed-set UI typeahead over the app's own strings, not guesswork). No content classification. |
| `src/components/status/ConnectionDot.test.tsx` | PORT | Tests the dot's CSS-class mapping per connection state; follows ConnectionDot.tsx. |
| `src/components/status/ConnectionDot.tsx` | PORT | Renders a colored dot from a closed `ConnectionState` union via template-literal class name. Deterministic, not a decision point. |
| `src/components/status/DaemonReceipts.test.tsx` | PORT | Exercises the daemon-receipts show-once/dismiss contract; follows DaemonReceipts.tsx. |
| `src/components/status/DaemonReceipts.tsx` | PORT | Renders daemon-supplied receipt lines verbatim (crash/update/migration/announcement notices), linkifying only well-formed `http(s)://` URLs by a fixed regex split. Structural text-run splitting on a known URL grammar, not natural-language classification. |
| `src/components/status/PowerChip.test.tsx` | PORT | Exercises the keep-awake chip's held/unheld/note states; follows PowerChip.tsx. |
| `src/components/status/PowerChip.tsx` | PORT | Renders the daemon's own `keepAwake.held`/`note`/`grantedClasses` fields verbatim; falls back to a plain "holding: X" line only when the daemon serves no note, never fabricating wording. No classification. |
| `src/components/status/RelayOverflowBanner.tsx` | PORT | Renders a dropped-event count from the relay-overflow store with a resync action. Plain count/arithmetic, no guesswork. |
| `src/components/status/StatusStrip.test.tsx` | PORT | Exercises every axis's labels, contract-glyph attributes and latency/route formatting; follows StatusStrip.tsx. |
| `src/components/status/StatusStrip.tsx` | PORT | Renders the connection/route/auth/working/latency/sse/model-name axes and mounts PowerChip/WakeChip. The `data-contract-glyph` value comes from `contractGlyphForConnection`, a fixed Record lookup in presentation-bridge.ts over the already-closed `ConnectionState` union (not open-ended text) - deterministic, not a decision point; the actual open-text classifier (`classifyBadgeTone`) lives in presentation-bridge.ts/StatusBadge.tsx (other batches) and is not used here. |
| `src/components/toast/index.ts` | PORT | Barrel re-export of Toast/ToastViewport. |
| `src/components/toast/Toast.tsx` | PORT | Renders one toast; maps a closed `ToastTone` union to an ARIA role via a fixed two-branch mapping (warning/danger to alert, else status). Deterministic. |
| `src/components/toast/ToastViewport.tsx` | PORT | Renders the stacked toast list with enter/exit presence animation. No classification. |
| `src/components/voice/MicButton.test.tsx` | PORT | Exercises the dictate button's honest-unavailable/recording/transcribing/error states; follows MicButton.tsx. |
| `src/components/voice/MicButton.tsx` | PORT | Renders one of a fixed set of capability/phase states (insecure-context, unsupported, no-STT, recording, requesting, transcribing, error) as icon+label+note; the "reason" text is read verbatim from the daemon's own `pairing.posture.get` capability reason, never guessed client-side. Deterministic state dispatch, not guesswork. |
| `src/components/voice/SpeakButton.tsx` | PORT | Renders one of a fixed set of TTS playback states (unavailable, loading, playing, idle). Deterministic. |
| `src/components/voice/VoiceSettings.test.tsx` | PORT | Exercises the local-voice setup card's states (checking/unavailable/error/provisioned/unsupported/not-provisioned/progress/receipt/retry); follows VoiceSettings.tsx. |
| `src/components/voice/VoiceSettings.tsx` | PORT | Shared spoken-voice popover (provider/voice pickers, local-voice install card, mounts WakeWordSettings). Calls `classifyBadgeTone('ready'|'unconfigured')` (line 120) as a CONSUMER with a literal input; it does not implement the classification itself, so it carries no decision point of its own (the decision point is recorded on presentation-bridge.ts, in another batch). |
| `src/components/voice/WakeBanner.tsx` | PORT | Renders the persistent top-of-shell wake-word banner from `wakeIndicatorCopy`'s fixed per-phase text table. Deterministic dispatch over a closed `WakeHostState.phase` union, not guesswork. |
| `src/components/voice/WakeChip.tsx` | PORT | Same fixed-phase dispatch as WakeBanner, rendered as a StatusStrip segment instead. Deterministic. |
| `src/components/voice/WakeChip.test.tsx` | PORT | Exercises both WakeChip and WakeBanner's phase-to-copy rendering; follows wake-indicator.ts's fixed switch. |
| `src/components/voice/wake-indicator.ts` | PORT | `wakeIndicatorCopy`/`wakeIndicatorVisible`: a fixed `switch` over the closed `WakeHostState.phase` union producing label/detail/live/attention. Every branch is an exhaustive enum case, not an open-text guess - deterministic, not a decision point. |
| `src/components/voice/WakeWordSettings.test.tsx` | PORT | Exercises provisioning, per-origin opt-in, and verbatim blocker/limitation rendering; follows WakeWordSettings.tsx. |
| `src/components/voice/WakeWordSettings.tsx` | PORT | Wake-word setup card: model provisioning action, per-origin opt-in checkbox, and the resolver's blockers/limitations rendered VERBATIM (the SDK's own sentences, explicitly never re-phrased). The `voice.wake.threshold` mentioned in its header comment is a pinned NUMERIC tuning constant for a local WASM audio classifier (a fixed, already-shipped signal-processing model, not natural-language guesswork), configured elsewhere in the schema-driven Settings group; this file only surfaces provisioning/opt-in/reasons, no classification of its own. |

## Library: a11y to cost-source

| File | Disposition | Note |
|---|---|---|
| `src/lib/a11y.test.ts` | PORT | Asserts `SR_ONLY_CLASS` and `srOnlyStyle`'s fixed CSS values. Follows a11y.ts. |
| `src/lib/a11y.ts` | PORT | `useGenId` (React `useId` wrapper), `SR_ONLY_CLASS` and `srOnlyStyle` constants. Pure accessibility plumbing, no guesswork. |
| `src/lib/approvals.test.ts` | PORT | Unit coverage for approvals.ts's tolerant readers. Follows approvals.ts. |
| `src/lib/approvals.ts` | PORT | Tolerant readers and display helpers for `approvals.*`: edit-hunk extraction, risk/status tone (fixed switch over a closed `ApprovalStatus`/risk-level enum), audit-trail formatting, remember-tier bookkeeping, and `judgmentVerdict`/`judgmentTone`/`judgmentLabel`. The model-judgment verdict (`looks-safe` / `flags-risk`) is a value the daemon's gate judgment tier already computed and stamped on the wire (`record.metadata.judgmentVerdict`); this file only reads and displays it with a fixed switch, it does not itself classify anything. Not a decision point. |
| `src/lib/auth-token.test.ts` | PORT | Pins that `setExplicitAuthToken` clears a token the daemon rejects (401), with a stubbed fetch to avoid a real-socket race. No guesswork; exercises `goodvibes.ts`'s token store. |
| `src/lib/card-material.test.ts` | PORT | Unit coverage for `isCardMaterialKey`'s word-boundary matching. Follows card-material.ts. |
| `src/lib/card-material.ts` | PORT | `isCardMaterialKey`: word-boundary-aware matching against a fixed, declared set of card-material word tokens (cvv/cvc/pan) and two exact key names, a belt-and-suspenders security backstop so card material is never rendered. Deterministic structural check over a closed, declared vocabulary, not guesswork; stays code per the security-checks-are-never-judged rule. |
| `src/lib/checkpoints.test.ts` | PORT | Unit coverage for checkpoints.ts's formatting helpers. Follows checkpoints.ts. |
| `src/lib/checkpoints.ts` | PORT | Display helpers for `checkpoints.*` (kind/retention labels over closed enums, byte formatting, sort, and fixed confirm-prompt wording enriched with a restore-preview's affected-file count). All deterministic formatting and arithmetic over daemon-supplied data. |
| `src/lib/client-compatibility.test.ts` | PORT | Unit coverage for build-version comparison and the compatibility verdict. Follows client-compatibility.ts. |
| `src/lib/client-compatibility.ts` | PORT | Independently-tested browser copy of the SDK's client-build-floor check: `compareBuildVersions` (numeric dotted-version compare), `evaluateClientCompatibility` (ok/restart-required/unknown against a floor header), and an observed-floor store. Structural version-number comparison and a closed three-state verdict, not guesswork; a version string is a fixed format, not natural language. |
| `src/lib/command-groups.test.ts` | PORT | Unit coverage for grouping/ordering commands by their fixed `CommandGroup` field. |
| `src/lib/command-groups.ts` | PORT | Groups the command-palette's own registered commands by their declared `group` field (a closed enum) and supplies fixed human labels. Structural grouping, not guesswork. |
| `src/lib/commands.test.ts` | PORT | Unit coverage for `filterCommands`/`scoreCommand`/registry lifecycle. |
| `src/lib/commands.ts` | PORT | The command-palette registry, plus `scoreCommand`/`fuzzyMatch`, a hand-tuned prefix/substring/fuzzy scorer over the app's OWN closed list of navigation commands (roughly two dozen fixed titles/keywords), used for instant keystroke-by-keystroke typeahead filtering. This is a deterministic UI mechanism (closed set, real-time constraint), not open-ended natural-language guesswork about real-world content; the intent document explicitly keeps the command palette as ordinary PORT UI. Not a decision point. |
| `src/lib/compaction-handoff-contract.test.ts` | PORT | Pins `COMPACTION_HANDOFF_HEADER` byte-identical against the SDK's own export, and that `isCompactionHandoffMessage` matches only that fixed literal string. Exact-string contract test, not guesswork. |
| `src/lib/compaction.test.ts` | PORT | Unit coverage for compaction.ts's parsers and formatters. |
| `src/lib/compaction.ts` | PORT | Parses the SDK's typed `COMPACTION_RECEIPT`/`COMPACTION_CHECK` runtime-event frames defensively (typeof guards over a discriminated union) and formats them: outcome tone/label over a closed 3-value enum, and `checkUsagePct`, plain arithmetic (`tokenCount / threshold`) over two numbers the daemon already computed. The `qualityScore`/`qualityGrade` fields are read and displayed verbatim, never computed or classified client-side (the SDK's own compaction quality judgment is covered in packages/engine's inventory). Not a decision point here. |
| `src/lib/companion-chat.test.ts` | PORT | Unit coverage for companion-chat.ts's tolerant readers and merge logic. |
| `src/lib/companion-chat.ts` | PORT | Tolerant response-shape readers (`companionSessionsFromListResponse`, etc.) and id/message merge helpers for the companion-chat surface, plus a thin localStorage cache. Structural JSON-shape probing over a fixed list of known wire envelope shapes, not natural-language guesswork. |
| `src/lib/companion-sessions-state.test.ts` | PORT | Unit coverage for the companion-sessions reducer/selectors. |
| `src/lib/companion-sessions-state.ts` | PORT | Pure reducer/selectors unifying this browser's local companion-chat session bookkeeping (created-here / cached / removed) with the daemon's own list. No guesswork, no React, no network. |
| `src/lib/composer-keys.test.ts` | PORT | Unit coverage for the send/steer key-combo predicates. |
| `src/lib/composer-keys.ts` | PORT | `shouldSubmitComposerKey`/`shouldSteerComposerKey`: fixed keyboard-event field checks (key/shift/ctrl/meta/isComposing). Deterministic, not a decision point. |
| `src/lib/config-ownership.test.ts` | PORT | Unit coverage for `isDaemonOwnedConfigKey`, including regression coverage for the payments/timezone keys named in the module's merge note. |
| `src/lib/config-ownership.ts` | PORT | `isDaemonOwnedConfigKey`: exact/prefix membership test against the SDK's own generated daemon-owned-key lists (`src/lib/generated/config-ownership.ts`). Purely structural set/prefix membership over a build-time snapshot, not a naming heuristic (the module's own history is a cautionary tale about why it must not be one); not a decision point. |
| `src/lib/config-redaction.test.ts` | PORT | Includes the broad content-scan regression test that catches an undeclared secret-shaped key arriving in the schema; a build-time safety net over the schema's own key strings, not a runtime decision. |
| `src/lib/config-redaction.ts` | PORT | Secret-shaped config masking for the settings display. The declared `SECRET_CONFIG_KEYS` enumerated set is PRIMARY; `SECRET_KEY_SUFFIX` regex is only an additional masking-only safety net, explicitly demoted by the module's own header from its former role as the primary "naming heuristic" (a real defect the header documents and fixes). This is a security/redaction check over config key names, not natural-language guesswork about content, so it stays code per the deterministic-security-boundary rule. `categoryLabelForKey`/`titleCase` are fixed lookup-with-mechanical-fallback, not judgment. Not a decision point. |
| `src/lib/contract-bridge-types.ts` | PORT | Pure type aliases bridging this app's fleet/checkpoints/rewind/sessions/cost-attribution facade types onto the SDK's generated `OperatorMethodInput`/`OperatorMethodOutput` contract types. Includes the `FleetAttemptJudgment` type (the best-of-N judge's proposed-winner-plus-reasons shape) as a type alias only; it names but does not implement any judgment, the judging happens engine/daemon-side. No runtime logic, nothing to classify. |
| `src/lib/cost-source.test.ts` | PORT | Unit coverage for cost-source.ts's formatting helpers. |
| `src/lib/cost-source.ts` | PORT | Formats pricing provenance (`costSource`/`pricingAsOf`) the daemon already stamps on cost figures: a fixed label lookup over the closed `user`/`provider`/`catalog`/`mixed` enum, UTC date formatting, and honest "price unknown" fallbacks. The webui explicitly no longer derives provenance client-side (the module header documents this as a completed fix); pure formatting of server-supplied facts, not a decision point. |

## Library: daemon-health to owner-profile

| File | Disposition | Note |
|---|---|---|
| `src/lib/daemon-health.test.ts` | PORT | Follows daemon-health.ts. |
| `src/lib/daemon-health.ts` | PORT | Daemon-health axis types and pure derivers (deriveAuthState/deriveWorkingState from ok/status, taskCountsFromList matching a closed set of known task status literals, clampLatency/formatLatency numeric formatting). All structural dispatch over closed wire vocabularies and numeric formatting; no open-ended guesswork. |
| `src/lib/device-settings-reachable.test.ts` | PORT | Structural reachability test: every `device.*` schema key routes into a settings group, deterministic set membership checks. |
| `src/lib/errors.test.ts` | PORT | Follows errors.ts. |
| `src/lib/errors.ts` | PORT | Error-predicate library (isSessionNotFoundError, isEmailAuthFailedError, isConflictError, etc.), code-first with message/status fallback, every check is against a closed, documented wire error code, HTTP status, or an anticipated/known literal string the daemon itself sends. Deterministic structural error classification, matches the daemon-side precedent for such helpers; not a decision point. |
| `src/lib/fleet-graph.ts` | JEV | Display helpers for fleet.graph.get, the dependency-graph view of one workstream (nodes/edges/elastic-pool state) - this is the task-graph decomposition half of the old WRFC workstream/fix-phase machinery, now a view of the contract tree (owner ruling: WRFC-state UI becomes a contract-tree view, marked JEV, never DROP). graphNodeStateLabel/graphNodeStateTone are fixed switch-case maps over a closed, wire-declared WorkItemState enum (pending/awaiting-capacity/in-phase/passed/failed/blocked-budget/blocked-dependency/held-merge) - deterministic, no guesswork of its own, so no decision-points row. |
| `src/lib/fleet.test.ts` | JEV | Follows fleet.ts. |
| `src/lib/fleet.ts` | JEV | Shared read-model layer behind the fleet/workstream/attempt-judgment contract-tree views (NodeTells, AttemptComparison, WorkstreamView, FleetView all view this data). KNOWN_PROCESS_KINDS includes the literal `wrfc-chain`/`wrfc-subtask`/`workstream`/`phase`/`work-item` wire kinds; readHeadline/readStallTell/readReviewSummary are pure defensive field-shape readers of daemon-computed values (verdict/score/cycles/checklist, a stall as a plain timestamp comparison), not client-side classification - confirmed no keyword/regex/score computation happens in this file itself, so no decision-points row; the guesswork, if any, already happened server-side/engine-side. |
| `src/lib/highlight.ts` | PORT | Shared highlight.js registration and a fixed file-extension-to-language alias table (`js`->javascript, `py`->python, etc.), exact lookup, not classification. |
| `src/lib/hosted-sessions.test.ts` | PORT | Follows hosted-sessions.ts. |
| `src/lib/hosted-session-stream.test.ts` | PORT | Follows hosted-session-stream.ts. |
| `src/lib/hosted-session-stream.ts` | PORT | Reads the `turn`/`tools` runtime-event envelope for an attached hosted session; type-tag switch over a closed, documented set of event names (STREAM_DELTA, TURN_COMPLETED, TOOL_EXECUTING, ...), defensive shape parsing. Deterministic. |
| `src/lib/hosted-sessions.ts` | PORT | Display helpers and tolerant wire readers for sessions.hosted.*; hostedStatusTone/effectiveDetachPolicyLabel/hostedTerminationLabel are fixed switch-case maps over closed, wire-documented enums (status, detach policy, termination reason), verbatim fallback for an unseen value. Deterministic, no guesswork. |
| `src/lib/insecure-origin.ts` | PORT | Security/entry guard: re-derives the SDK transport's public-vs-private-network host classification (loopback, RFC 1918 ranges, `.local`) to show an honest HTTPS-required message instead of a silent blank screen. A fixed, documented network-range check; a security check, stays code per the rules. |
| `src/lib/knowledge-projection.test.ts` | PORT | Follows knowledge-projection.ts. |
| `src/lib/knowledge-projection.ts` | PORT | Builds a `knowledge.projection.render` request from a projection target; `kind` is validated against the exact closed union the generated contract declares (compiler-checked exhaustive table), id-required-ness is type-pinned to the contract. Structural validation, not guesswork. |
| `src/lib/mail-order.test.ts` | PORT | Follows mail-order.ts. |
| `src/lib/mail-order.ts` | PORT | Sorts inbox messages by server-assigned IMAP `uid` descending rather than the sender-controlled `date` header, an explicit anti-spoofing ordering rule (deterministic numeric sort, a security-adjacent design decision, not content guesswork). |
| `src/lib/mail-refusal.test.ts` | PORT | Follows mail-refusal.ts. |
| `src/lib/mail-refusal.ts` | PORT | Turns an email-surface error into an honest refusal note; dispatches on typed error-predicate functions (isEmailAuthFailedError, isEmailUnconfiguredError, isMethodUnavailableError, isMethodNotInvokableError) from errors.ts, a fixed ordered structural dispatch over closed error TYPES, not open-ended text guessing. |
| `src/lib/memory-governance.test.ts` | PORT | Follows memory-governance.ts. |
| `src/lib/memory-governance.ts` | PORT | MemoryGovernor snapshot types and pure derivers (memoryTierLabel/memoryTierBadgeClass are fixed switch-case maps over the closed, daemon-declared MemoryTier enum; formatMb/clampUsedPct are numeric formatting). No guesswork; the tier itself is computed daemon-side, this file only renders it. |
| `src/lib/memory-provenance.test.ts` | PORT | Follows memory-provenance.ts. |
| `src/lib/memory-provenance.ts` | PORT | Reads a documented `metadata.memory.recordIds: string[]` convention off a chat message's open metadata bag; defensive structural field extraction, not content interpretation. |
| `src/lib/model-catalog.test.ts` | JEV | Follows model-catalog.ts (detectFamily's decision point below). |
| `src/lib/model-catalog.ts` | JEV | Multi-target model routing and catalog display helpers; almost all of it (target routing to config keys, filterModels, groupModels by provider/pricingTier, tierToCategoryFilter) is fixed structural dispatch over closed enums and wire-documented paths. `detectFamily` (line 211, using FAMILY_PATTERNS at lines 196-209) is a genuine decision point: see below. Flagging for owner review: this is a *display-only* "group the model picker by family" convenience (mirrors the TUI's own grouping, not an automated selection), so it may not be what the project's "no vendor or model names in routing or tier rules" rule is aimed at (that rule reads as being about automated failover/tier selection, not a human-operated UI grouping toggle) - recorded as JEV per the letter of the decision-point criteria (a regex ladder over text), but the disposition is worth an owner ruling if a "no vendor names anywhere, full stop" reading is intended instead, which would make this a plain removal of the family filter rather than a Jev reading. |
| `src/lib/model-prices.test.ts` | PORT | Follows model-prices.ts. |
| `src/lib/model-prices.ts` | PORT | Manual model-price table parsing/validation (numeric range checks, a `provider:model` key-shape regex). Money arithmetic and fixed-format validation, stays code per the rules. |
| `src/lib/money.test.ts` | PORT | Follows money.ts. |
| `src/lib/money.ts` | PORT | Money amount parsing/formatting and currency-exponent-aware minor-unit conversion, all integer arithmetic on parsed decimal strings. Money arithmetic, stays code per the rules; not a decision point. |
| `src/lib/object.test.ts` | PORT | Follows object.ts. |
| `src/lib/object.ts` | PORT | Generic defensive wire-object readers (asRecord, firstString, bestId/bestTitle/bestStatus trying an ordered list of KNOWN field names, formatBytes). `bestId`/`bestTitle`/`bestStatus` try a fixed, ordered list of exact, known field names from the wire contract (id/sessionId/taskId/... ), not free-text guessing about meaning - structural field-precedence lookup, not a decision point. |
| `src/lib/owner-profile.test.ts` | PORT | Follows owner-profile.ts. |
| `src/lib/owner-profile.ts` | PORT | View types and defensive wire readers for profile.* verbs, bound to the generated contract. `readTier`'s "unrecognised tier reads as closed" is a single fixed fail-safe default to the MORE restrictive of two known enum values (never open-ended classification of free text) - a deterministic safe-default, not guesswork, confirmed by reading the surrounding code. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `src/lib/model-catalog.ts:196-217` (`FAMILY_PATTERNS`, `detectFamily`) | A 12-entry hand-written regex ladder matching a model's `id + label` text against vendor/family name patterns (`/claude/i` -> Claude, `/gpt\|\bo1\b\|\bo3\b\|\bo4\b/i` -> GPT, `/gemini/i` -> Gemini, `/llama/i` -> Llama, `/qwen/i` -> Qwen, `/glm\|chatglm/i` -> GLM, `/minimax\|abab/i` -> MiniMax, `/deepseek/i` -> DeepSeek, `/mistral\|mixtral/i` -> Mistral, `/command\|cohere/i` -> Command, `/grok/i` -> Grok, `/kimi\|moonshot/i` -> Kimi), first match wins, else `'Other'` | A choice reading classifying the model's id/label text into the closed family-label set, for the model-workspace "group by family" display filter only (mirrors the TUI's own picker grouping, cross-surface parity) - not an automated routing/tier decision, so it is a narrow display convenience rather than the kind of vendor-in-routing-logic the project's no-vendor-names rule targets; owner ruling requested (see file-table note) on whether that rule should instead simply drop this grouping feature. |

## Library: goodvibes SDK client

| File | Disposition | Note |
|---|---|---|
| `src/lib/goodvibes.test.ts` | PORT | Exercises the client below: route-disposition pins against the generated `WEBUI_METHOD_ROUTES`/`WEBUI_METHOD_DISPOSITION` artifact (no hand-written row shadows or diverges from a generated one), wire-call assertions (URL, method, body envelope) for every namespace (fleet, checkpoints, ci, checkin, occasions, principals, channels.profiles, sessions, etc.), compile-time `@ts-expect-error` typed-input guards, the `sdk` facade's own key-shape pins, a runtime JSON-Schema conformance walk (`assertConforms`) of every bridge-typed sample against `operator-contract.json`, token-honesty (`getCurrentAuth`) tests, client-build-floor header recording, and the `hostedSessionDetachBeacon` keepalive-fetch tests. Every assertion is a structural/wire-shape check (URL string, HTTP method, JSON body equality, schema `required` fields present) against this project's own generated contract; nothing here classifies or scores open-ended text. |
| `src/lib/goodvibes.ts` | PORT | The webui's typed transport layer over the daemon's operator/gateway contract: `sdk.operator.*` and `sdk.chat.*`. Contents are (1) route derivation from the generated facade (`buildExtraMethodRoutes`/`EXTRA_METHOD_ROUTES`, `isExtraRoutedMethod`, `webuiRouteFor`), (2) URL/query building and path-param interpolation (`buildUrl`, `interpolateRoute`), (3) the HTTP helpers (`requestJson`, `requestStream`, `authHeaders`, `hostedSessionDetachBeacon`) that attach auth, route through `routedFetch`, record the daemon's announced client-compatibility floor, and normalize failures into a typed error (`status`/`category`/`body`), (4) three narrowly-scoped dispatchers (`invokeOperator`, its documented escape hatch `invokeOperatorUncheckedInput`, and `invokeGatewayMethod` for ws-only/generic-invoke verbs), and (5) roughly 2000 lines of request/response type definitions and thin per-verb wrapper functions across every namespace the app calls (approvals, tasks, watchers, calendar, email, memory, push, pairing, tailscale, step-up, config, payments cards, power, voice, models, occasions, principals, channels.profiles, checkin, ci, fleet incl. attempts/graph/observed, checkpoints, rewind, sessions incl. hosted, cost attribution, login/auth token handling). No function in this file itself performs open-ended-text classification, keyword/regex matching over prose, or score/threshold judgment over unbounded content: fields that read as judgment output (`MemoryRecord.confidence`, `ApprovalAnalysis.classification`/`riskLevel`, `FleetAttemptJudgment.reasons`/`scoredBy`) are typed wire-format fields the daemon/engine already computed, and `fleet.attempts.judge` here is a bare one-line RPC forward (`invokeGatewayMethod('fleet.attempts.judge', { groupId })`) with no scoring logic of its own, matching the task brief's expectation that such logic lives in `src/lib/fleet.ts` or server/engine-side, not in this transport file. Only import paths change, to point at the engine's contract types (the 507 contract methods named in the intent document's Contracts bullet). |

## Library: pairing to uuid

| File | Disposition | Note |
|---|---|---|
| `src/lib/pairing-qr-camera.ts` | PORT | Camera surface for the QR pairing scanner (getUserMedia open/stop, frame grab, downscale). `classifyCameraError` maps a getUserMedia rejection to a `ScannerFailure` by a fixed `switch` over DOMException `.name` values (`NotAllowedError`, `NotFoundError`, `NotReadableError`, ...), a closed, machine-defined vocabulary, not guesswork. |
| `src/lib/pairing-qr-detector.ts` | PORT | Picks a QR decoder backend (platform `BarcodeDetector`, else bundled `jsQR`), by capability probing (`typeof`, `getSupportedFormats`), not content classification. |
| `src/lib/pairing-qr.test.ts` | PORT | Follows pairing-qr.ts. |
| `src/lib/pairing-qr.ts` | PORT | Parses a scanned QR's text into a validated `ScannedPairing`, trying four KNOWN, documented wire shapes in a fixed precedence order (JSON payload, bare relay code, URL, query string) via `fromJson`/`fromBareRelayCode`/`fromUrl`/`fromQueryString`, each a structural parse (JSON.parse, `new URL`, fixed field-name aliases) against shapes the GoodVibes family itself generates, never open-ended natural-language interpretation. |
| `src/lib/pairing.test.ts` | PORT | Follows pairing.ts. |
| `src/lib/pairing.ts` | PORT | Reads the `#pair=<token>` / `#offers=...` URL fragment (URLSearchParams over a fixed key vocabulary) and strips it after use. Deterministic parsing. |
| `src/lib/payments-cards.test.ts` | PORT | Follows payments-cards.ts. |
| `src/lib/payments-cards.ts` | PORT | Card-entry rules for this surface: asks the SDK's `CARD_ENTRY_SURFACES` allowlist (never a local list) whether card entry may happen here, builds/validates a card draft into daemon input (digit-count, expiry regex, CVV digit-count), and mirrors the owner's verbatim entry-condition text. Security/money-adjacent structural validation; Luhn is explicitly NOT checked (left to the daemon). No open-ended classification. |
| `src/lib/permission-mode.test.ts` | JEV | Follows permission-mode.ts. |
| `src/lib/permission-mode.ts` | JEV | The intent document's call to DROP this file is void (owner ruling: only WRFC- or QEMU-specific code drops, and this is neither). Today it is a fixed vocabulary of five session permission modes (`plan`, `normal`, `accept-edits`, `auto`, `custom`) read/written via `sessions.permissionMode.get/.set`, with a label lookup and a settable/read-only split. It becomes the gate presets sheet's data model: the flat mode enum is replaced by presets computed over the engine gate's stakes table (graduated autonomy from a deterministic boundary), per goodvibes-jev-intent.md's "gate (replaces permissions)" subsystem row. The file itself contains no keyword/text guesswork (it is a closed-set enum, membership check, and label `Record` lookup), so it needs no decision-points row of its own; the judgment work is the gate's stakes-based preset selection, not anything this file computes. |
| `src/lib/presentation-bridge.test.ts` | JEV | Follows presentation-bridge.ts. |
| `src/lib/presentation-bridge.ts` | JEV | Maps webui status vocabulary onto the SDK presentation contract's glyphs. Most of the file (`CONNECTION_TO_CONTRACT_STATE`, `AUTH_TO_CONTRACT_STATE`, `WORKING_TO_CONTRACT_STATE`, `SSE_TO_CONTRACT_STATE`, `MEMORY_TIER_TO_CONTRACT_STATE`) is a deterministic fixed `Record` lookup over already-closed TypeScript unions (`ConnectionState`, `AuthState`, etc.) and is not a decision point. `classifyBadgeTone(value: string)` (line 73) is different: it is a self-labelled "heuristic" that classifies an arbitrary, open-ended status string, used across sessions, providers, knowledge jobs, and accounts, into one of four tones by substring keyword matching. See decision points below. |
| `src/lib/provider-models.test.ts` | PORT | Follows provider-models.ts. |
| `src/lib/provider-models.ts` | PORT | Tolerant readers turning a provider/model wire response into picker options; sorts configured-before-unconfigured then alphabetically (deterministic), and resolves provider/model aliases via a fixed, declared `CATALOG_PROVIDER_ALIASES` map, not a guessed correspondence. |
| `src/lib/provider-status.test.ts` | PORT | Follows provider-status.ts. |
| `src/lib/provider-status.ts` | PORT | Rolls per-route freshness (an already-closed wire enum: healthy/expiring/expired/pending/unconfigured) into one provider pill via a fixed `FRESHNESS_RANK` worst-wins table; an unrecognized future freshness value maps deterministically to `status unavailable`/`unconfigured`, never guessed. Deterministic closed-enum classification, not a decision point. |
| `src/lib/queries.ts` | PORT | The react-query cache-key registry (`queryKeys`) plus the boot-snapshot loader. Pure data/wiring, no classification of any kind; several comments document that the fleet/workstream cache key rides the same `['fleet']`/`['workstream']` prefix, a naming convention, not guesswork. |
| `src/lib/relay-connection.test.ts` | PORT | Follows relay-connection.ts. |
| `src/lib/relay-connection.ts` | PORT | The transport-route seam (direct vs. relay `fetch`) and the WebAuthn step-up retry-on-401 flow. Every branch is a structural check (HTTP method, response status, a `www-authenticate` header regex against a fixed literal, a JSON `error` field equality) - deterministic wire-protocol handling, not guesswork. |
| `src/lib/relay-pairing.test.ts` | PORT | Follows relay-pairing.ts. |
| `src/lib/relay-pairing.ts` | PORT | Stores/reads a relay pairing payload (localStorage), parses/strips the `#relay=` fragment, and decodes a `gvrelay1.` pairing code via the SDK's own decoder. Deterministic parsing and persistence. |
| `src/lib/relay-stream-overflow.test.ts` | PORT | Follows relay-stream-overflow.ts. |
| `src/lib/relay-stream-overflow.ts` | PORT | A tiny pub/sub store accumulating a dropped-event count from `relay-overflow` SSE frames. Pure arithmetic and state, no classification. |
| `src/lib/rewind.test.ts` | PORT | Follows rewind.ts. |
| `src/lib/rewind.ts` | PORT | Derives turn anchors from a session's message list (group by `turnId`, label from first non-empty body, truncate to 80 chars). Structural grouping and truncation, not a judged reading of the content. |
| `src/lib/router.test.ts` | PORT | Follows router.ts. |
| `src/lib/router.ts` | PORT | Dependency-free URL state encoder/decoder over a fixed, enumerated `ViewId` set and `filter[key]=value` query params. Deterministic. |
| `src/lib/sdk-subpath-imports.test.ts` | PORT | Scans this repo's own source for `@pellux/*` import specifiers and resolves each against the installed package (`Bun.resolveSync`), asserting none reach into `/dist/`. Structural source-scanning and module resolution, not a decision point. |
| `src/lib/secret-store-only-config-keys.test.ts` | PORT | Follows secret-store-only-config-keys.ts. |
| `src/lib/secret-store-only-config-keys.ts` | PORT | A fixed, declared set of config keys whose real value only ever comes from the daemon's secret store (mail/calendar passwords), so `config.set` on them is refused with the real `/secrets set` command named instead. Exact set-membership and deterministic string-derivation (`daemonSecretKeyFor`), a security/credential-routing check, not guesswork. |
| `src/lib/sessions-union.test.ts` | PORT | Follows sessions-union.ts. |
| `src/lib/sessions-union.ts` | PORT | Tolerant readers for the cross-surface session union list. `kind`/`status`/`project` are read as open strings by design (an unrecognized future value renders verbatim rather than being dropped), and `sessionUpdateIntent` maps a wire event name to a coarse intent via a fixed, declared `SESSION_UPDATE_INTENT_MAP`, returning `null` (never a guessed intent) for an event the map does not name. Deterministic lookup over closed, machine-defined wire vocabularies, not a decision point. |
| `src/lib/settings-model.test.ts` | PORT | Follows settings-model.ts. |
| `src/lib/settings-model.ts` | PORT | Builds the schema-driven settings model (groups, feature units, plain/raw rows) purely from SDK schema metadata and the live config snapshot; excludes card-material keys via the already-deterministic `isCardMaterialKey`. `filterSettingsModel`'s free-text search is a plain case-insensitive substring match over the settings surface's own labels/keys for instant filtering, the same deterministic UI-typeahead mechanism already established for the command palette (src/lib/commands.ts), not guesswork. |
| `src/lib/settings-owner-profile-group.test.ts` | PORT | Pins that the ten `profile.*` schema keys reach the settings workspace under the real "Owner Profile" label. Structural schema/label assertions, follows settings-model.ts. |
| `src/lib/settings-wake-word-group.test.ts` | PORT | Pins that `voice.wake.*`/`voice.local.*` keys group under "Voice" and that an unmapped namespace falls back to Title Case. Structural label assertions, follows settings-model.ts / config-redaction.ts. |
| `src/lib/stepup-prompter.ts` | PORT | The registration seam between the transport layer and the step-up ceremony UI (register/resolve a prompter callback). Pure wiring, no classification. |
| `src/lib/stepup.test.ts` | PORT | Follows stepup.ts. |
| `src/lib/stepup.ts` | PORT | The browser WebAuthn step-up ceremony (register/assert a passkey, encode the assertion header, parse `authenticatorData`). `normalizeCeremonyError` maps a fixed set of DOMException names (`NotAllowedError`, `InvalidStateError`, `NotSupportedError`, `SecurityError`) to typed `StepUpErrorCode`s, a closed, machine-defined vocabulary, not guesswork. |
| `src/lib/theme.test.ts` | PORT | Follows theme.ts. |
| `src/lib/theme.ts` | PORT | Theme/density preference persistence (localStorage read/write, `prefers-color-scheme` fallback, DOM attribute application). Deterministic. |
| `src/lib/timezones.test.ts` | PORT | Follows timezones.ts. |
| `src/lib/timezones.ts` | PORT | IANA timezone list/validation/filter for the timezone picker, backed by `Intl.supportedValuesOf`/`Intl.DateTimeFormat`. The filter is a plain substring match over zone names (the same deterministic typeahead pattern as commands.ts), not guesswork. |
| `src/lib/toast.dom.test.tsx` | PORT | Follows toast.ts. |
| `src/lib/toast.test.ts` | PORT | Follows toast.ts. |
| `src/lib/toast.ts` | PORT | Toast notification state (reducer, provider, hooks) and the auto-dismiss hover/focus-pause timer. Pure UI state machine, no classification. |
| `src/lib/triggers-settings-reachable.test.ts` | PORT | Pins that every `watchers.triggers.*` schema key is reachable in the settings workspace under the "Watchers" label. Structural schema/label assertions, follows settings-model.ts. |
| `src/lib/ui-preferences.test.ts` | PORT | Follows ui-preferences.ts. |
| `src/lib/ui-preferences.ts` | PORT | Webui-local UI preference persistence (code-block line numbers, memory provenance chip toggle) via localStorage plus a cross-tab custom event. Deterministic. |
| `src/lib/unified-diff.test.ts` | PORT | Follows unified-diff.ts. |
| `src/lib/unified-diff.ts` | PORT | A tolerant unified-diff parser (files/hunks/lines) driven entirely by git's own fixed diff-line-prefix grammar (`@@ ... @@`, `--- `/`+++ `, `diff --git`, `+`/`-`/` `/`\`) via regex over that fixed machine syntax, not natural-language prose. Structural parsing, not a decision point. |
| `src/lib/uuid.test.ts` | PORT | Follows uuid.ts. |
| `src/lib/uuid.ts` | PORT | UUIDv4 minting with a `crypto.getRandomValues` fallback for insecure origins where `crypto.randomUUID` is unavailable. Deterministic. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `src/lib/presentation-bridge.ts:73-100` (`classifyBadgeTone`) | A self-labelled "heuristic": lower-cases an arbitrary status string (drawn from many unrelated domains: session turn state, provider auth freshness, knowledge job status, account auth freshness) and tests it against four hardcoded keyword/substring ladders in sequence - `error`/`fail`/`denied`/`expired` → `bad`; `warn`/`pending`/`blocked`/`expiring` → `warning`; `healthy`/`ok`/`ready`/`active` → `ok`; anything else → `neutral` | A coarsen/choice reading over the closed `{ok, warning, bad, neutral}` set, replacing the substring-keyword ladder with a single classification of the status text into one of the four bands |

## Library: voice

| File | Disposition | Note |
|---|---|---|
| `src/lib/voice/capture.test.ts` | PORT | Tests capture.ts's frame pump, resampling and scaling; follows that file. |
| `src/lib/voice/capture.ts` | PORT | The one browser microphone path (`AudioCaptureOpener`): device support detection, the Web Audio frame pump (scale/resample/slice into the SDK's fixed frame contract), and the AudioWorklet/ScriptProcessor tap. `classifyGetUserMediaError` maps `DOMException.name` (NotAllowedError/SecurityError/PermissionDeniedError vs NotFoundError/NotReadableError/etc.) to a closed `AudioCaptureError` reason, a fixed, machine-defined error-code match, not open-ended text classification, so it is not a decision point. |
| `src/lib/voice/index.ts` | PORT | Barrel re-export of the voice module's public surface. No logic. |
| `src/lib/voice/mic-arbiter.test.ts` | PORT | Tests MicArbiter's exclusivity/suspend-resume policy; follows that file. |
| `src/lib/voice/mic-arbiter.ts` | PORT | One-device-two-consumers arbitration: push-to-talk always wins by suspending wake detection first, refuses a second concurrent stream. Deterministic state machine, no guesswork. |
| `src/lib/voice/request-policy.test.ts` | PORT | Tests coalesceForSpeech's boundary splitting and scheduleTtsRequests' concurrency/retry/skip policy; follows that file. |
| `src/lib/voice/request-policy.ts` | PORT | Bounded TTS request policy: coalesces reply text into the fewest synthesis segments by splitting on paragraph/sentence/whitespace boundaries (a deterministic text-wrapping algorithm, not a natural-language judgment), caps concurrency at 2, and retries-then-skips on a transient failure. `isTransientTtsError` checks a fixed HTTP status code (429), a closed machine-defined check, not a decision point. |
| `src/lib/voice/tts-player.test.ts` | PORT | Tests TtsEngine/WebAudioSink playback sequencing; follows that file. |
| `src/lib/voice/tts-player.ts` | PORT | Gapless Web Audio playback engine for spoken replies: one long-lived sink per reply, schedules decoded buffers back-to-back, single-voice interrupt-on-new-speak. Deterministic audio scheduling, no guesswork. |
| `src/lib/voice/useVoice.ts` | PORT | React glue: voice status/config reads, `useTts` (speak/stop through the singleton engine), and `useVoiceInput` (mic capture through the shared arbiter to `voice.stt`, review-before-send). Deterministic state-machine wiring over daemon calls, no guesswork. |
| `src/lib/voice/useWake.ts` | PORT | React glue joining the wake host to the daemon client and React: provisioning, live host state, mounting/settings application, transcript-sink registration. Deterministic wiring, no guesswork. |
| `src/lib/voice/voice-config.test.ts` | PORT | Tests deriveVoiceAvailability/readSharedVoiceConfig's defensive parsing; follows that file. |
| `src/lib/voice/voice-config.ts` | PORT | Defensive wire parsing of `voice.status` (provider capability tokens, a closed set: tts/tts-stream/stt/realtime/voice-list) and `config.get`'s shared tts.* defaults. Degrades to an honest "not available" on any unrecognised/legacy shape rather than guessing; membership checks against a fixed, closed vocabulary are not a decision point. |
| `src/lib/voice/voice-local-setup.test.ts` | PORT | Tests the voice.local.status/install wire-shape parsers; follows that file. |
| `src/lib/voice/voice-local-setup.ts` | PORT | Managed local-voice (piper/whisper.cpp) provisioning shapes and defensive parsers over a closed, fixed set of wire enums (runtime states, install engine states, install phases). Structural validation only, no guesswork. |
| `src/lib/voice/wake-chime.test.ts` | PORT | Tests playWakeChime's oscillator scheduling; follows that file. |
| `src/lib/voice/wake-chime.ts` | PORT | Synthesises the two-tone wake-confirmation chime via Web Audio oscillators. Fixed audio synthesis, no guesswork. |
| `src/lib/voice/wake-config.test.ts` | PORT | Tests resolveWebuiWakeSettings/configPathReader; follows that file. |
| `src/lib/voice/wake-config.ts` | PORT | Adapts the daemon's nested `config.get` tree to the SDK's flat `resolveWakeRuntimeSettings` reader, and states this tab's fixed capability answers (speex availability from WASM presence, VAD availability from daemon-reported provisioning, no filesystem retention, no local-file playback). Every answer is a structural capability check, not a guess. |
| `src/lib/voice/wake-host.test.ts` | PORT | Tests WakeHost's apply/suspend/resume/failure state machine; follows that file. |
| `src/lib/voice/wake-host.ts` | PORT | The browser tab's wake-word host: device via the arbiter, inference runtime via onnxruntime-web, chime/indicator/transcript wiring, and an honest state machine including every refusal. The wake-word DETECTION ITSELF (scoring audio frames against `voice.wake.threshold`/`voice.wake.vadThreshold`) is the SDK's already-pinned, already-tuned local audio classifier (a signal-processing model with empirically measured false-accept/recall tradeoffs, documented in the generated config schema, not a natural-language judgment task) - this file only hosts it, resolves the pinned model id, and reports honest state; no open-ended text classification of its own, so not a Jev decision point. |
| `src/lib/voice/wake-models.test.ts` | PORT | Tests loadWakeModel's chunked download, cache, and checksum verification; follows that file. |
| `src/lib/voice/wake-models.ts` | PORT | Downloads the pinned wake-word model bytes from the daemon in chunks, verifies them against a pinned SHA-256, and caches verified bytes. Deterministic integrity checking (checksum comparison, offset/length bookkeeping), a security-adjacent verification step that stays code, not a decision point. |
| `src/lib/voice/wake-runtime.ts` | PORT | Loads the onnxruntime-web inference runtime (one binary serving both the wasm and webgpu backends), with WebGPU capability probed via `navigator.gpu` and thread count gated on `crossOriginIsolated`. Deterministic runtime/capability selection, no guesswork. |

## Library: device-node, generated, push, pwa

| File | Disposition | Note |
|---|---|---|
| `src/lib/device-node/capability-bindings.ts` | PORT | Web-platform binding for the SDK device-capability contract (getUserMedia, getDisplayMedia, geolocation, clipboard, Notification, vibrate). `announcedCapabilities` is a fixed boolean/type-of feature-detection ladder (secure context plus API presence), `runWebNodeCapability` dispatches on a closed `capabilityId` string union via `switch`. Authority (whether a capability may run) is explicitly not decided here; that lives upstream. All deterministic. |
| `src/lib/device-node/phone-node-client.test.ts` | PORT | Exercises phone-node-client.ts's pairing, work-pull/complete, redelivery-dedupe and activity-log-bounding behavior. |
| `src/lib/device-node/phone-node-client.ts` | PORT | The SDK peer-contract pairing/heartbeat/work-pull/complete loop for this browser acting as a paired device node. Token validated by use (discarded on 401/403) and executed-work markers are structural dedupe bookkeeping, not guesswork; a work item of an unrecognised type is refused rather than guessed at. |
| `src/lib/generated/config-ownership.ts` | PORT | Generated (`scripts/generate-config-ownership.ts`) build-time snapshot of the SDK's daemon-owned config prefixes/keys/paths; data only, regenerated from the engine at build time, no logic of its own. |
| `src/lib/generated/config-schema.ts` | PORT | Generated (`scripts/generate-config-schema.ts`) build-time snapshot of the full config schema (5372 lines of typed field descriptors and their descriptions); data only, regenerated from the engine's schema, no logic of its own. |
| `src/lib/generated/presentation-tokens.ts` | PORT | Generated (`scripts/generate-presentation-tokens.ts`) build-time snapshot of the SDK presentation contract's status glyphs and state tone-color table; data only, regenerated from the engine, no logic of its own. |
| `src/lib/push/approval-action-link.test.ts` | PORT | Exercises approval-action-link.ts's hash parse/strip. |
| `src/lib/push/approval-action-link.ts` | PORT | Parses/strips a fixed `approval-action`/`approval-id` URL-fragment pair (exact query-param keys, closed `'approve' \| 'deny'` union) so ApprovalsTasksView can complete a push action tap. Exact-parameter parsing, not guesswork. |
| `src/lib/push/fleet-focus-link.test.ts` | PORT | Exercises fleet-focus-link.ts's hash parse/strip. |
| `src/lib/push/fleet-focus-link.ts` | PORT | Parses/strips a fixed `fleet-node`/`fleet-session` URL-fragment pair so FleetView can focus the node a needs-input push named. Exact-parameter parsing, not guesswork. |
| `src/lib/push/notification-link.test.ts` | PORT | Exercises notification-link.ts's `linkForNotification` mapping. |
| `src/lib/push/notification-link.ts` | PORT | Maps a push notification's typed `data.kind` (`'approval'` \| `'needs-input'`) plus an optional action-button id onto a fixed in-app URL via `switch`/equality checks over a closed, structured vocabulary the daemon itself defines; falls back to root for anything unrecognised. Deterministic structural dispatch, not natural-language guesswork. |
| `src/lib/push/push-client.test.ts` | PORT | Exercises push-client.ts's subscribe/unsubscribe/reconcile flows. |
| `src/lib/push/push-client.ts` | PORT | Browser half of Web Push: VAPID subscribe/unsubscribe/reconcile against the daemon's push.* verbs, device-id persistence, and an endpoint-hash comparison (SHA-256, byte-identical to the daemon's own hashing) to detect drift before writing. Every failure is a named, closed `PushSubscribeFailure` reason. All deterministic wire/crypto plumbing. |
| `src/lib/push/push-facade.test.ts` | PORT | Exercises the push facade surface (re-export/wiring test). |
| `src/lib/push/push-support.test.ts` | PORT | Exercises push-support.ts's capability/permission detection and base64url codec. |
| `src/lib/push/push-support.ts` | PORT | `detectPushSupport`/`readNotificationPermission`: fixed boolean feature-detection (secure context, ServiceWorker/PushManager/Notification presence) into a closed 3-state or 4-state union; `urlBase64ToUint8Array` is a pure base64url codec. Deterministic. |
| `src/lib/push/reconcile-on-open.test.ts` | PORT | Exercises reconcilePushSubscriptionOnOpen's drift-detection/reconcile-on-open behavior. |
| `src/lib/push/sw.test.ts` | PORT | Exercises the service worker's push-handling behavior (public/sw.js), a different batch's file. |
| `src/lib/pwa/install-prompt.test.ts` | PORT | Exercises install-prompt.ts's affordance resolution across platform/state combinations. |
| `src/lib/pwa/install-prompt.ts` | PORT | `resolveInstallAffordance`: a fixed if/else ladder over three booleans (standalone, hasPromptEvent, isIos) into a closed 4-value union. `isIos` matches a fixed, closed device-name pattern (`iPad\|iPhone\|iPod`) against the user-agent string, a feature/platform-family detection, not open-ended natural-language classification. Deterministic. |
| `src/lib/pwa/manifest.test.ts` | PORT | Exercises the PWA manifest (public/manifest.webmanifest), a different batch's file. |
| `src/lib/pwa/register-sw.ts` | PORT | Gates and performs service-worker registration on a fixed boolean ladder (production build or explicit test escape hatch, browser support, secure context); a registration failure is logged and swallowed, never breaks the app. Deterministic. |

## Views: chat

| File | Disposition | Note |
|---|---|---|
| `src/views/chat/ArtifactsPanel.tsx` | PORT | Extracts fenced code blocks from a message's own markdown with a fixed ```` ```lang\n...\n``` ```` regex (fixed markdown grammar, not natural-language guessing) and lists file/artifact attachments by their own typed fields. No classification of content meaning. |
| `src/views/chat/auto-title.test.ts` | PORT | Unit tests for `deriveChatTitle` (message-utils.ts): asserts the deterministic first-line/whitespace-collapse/word-boundary-clip behavior, not a generative or classifying decision. |
| `src/views/chat/ChatSearch.tsx` | PORT | Search panel over the operator's own typed query: renders two backend/local result sections. No content classification; `relativeTime` is exact arithmetic on a timestamp. |
| `src/views/chat/composer-attachments.test.ts` | PORT | Tests the drag/paste/file-type helpers below. |
| `src/views/chat/composer-attachments.ts` | PORT | Pure browser-API helpers (DragEvent/ClipboardEvent file extraction, MIME-type check, object-URL preview). Deterministic, no content interpretation. |
| `src/views/chat/Composer.dom.test.tsx` | PORT | DOM-level tests of the composer below. |
| `src/views/chat/Composer.tsx` | PORT | The message composer: model picker, slash-command menu (exact-prefix filter over the app's own fixed command list, same deterministic-typeahead reasoning as the command palette), drag/paste attachment wiring, and a press-and-hold steer affordance (a fixed 550 ms timer). No open-ended text classification. |
| `src/views/chat/index.ts` | PORT | One-line barrel re-exporting `ChatView`. |
| `src/views/chat/lineage.test.ts` | PORT | Tests `buildLineage`'s grouping below. |
| `src/views/chat/lineage.ts` | PORT | Honest-lineage view model: groups messages purely on the server-set `supersededAt`/`supersededReason`/`revisionOf` fields ("never a guess," per its own doc comment). Deterministic grouping over daemon-authoritative markers, not a classification of content. |
| `src/views/chat/MemoryProvenanceChip.test.tsx` | PORT | Tests the chip below. |
| `src/views/chat/MemoryProvenanceChip.tsx` | PORT | Displays memory-provenance record ids the daemon already attached to a turn (fetches each record's own fields lazily on expand). Pure view, no classification of its own (the knowledge/memory subsystem's own JEV work lives in the engine, per goodvibes-jev-intent.md). |
| `src/views/chat/MessageItem.tsx` | PORT | Renders one message: tone/delivery-state badges, inline edit, retry/regenerate, artifacts button, memory-provenance chip. All dispatch is on closed states (`tone`, `deliveryState`) computed deterministically in message-utils.ts. |
| `src/views/chat/MessageLineage.tsx` | PORT | The retained-history disclosure UI for a lineage.ts node; renders retained messages read-only. No guesswork. |
| `src/views/chat/MessageList.test.tsx` | PORT | Tests the message-list rendering below. |
| `src/views/chat/MessageList.tsx` | PORT | Renders the lineage-node list plus the live-streaming placeholder and running tool calls. Pure rendering/state wiring. |
| `src/views/chat/message-utils.test.ts` | PORT | Tests the helpers below. |
| `src/views/chat/message-utils.ts` | PORT | Wire-shape extraction helpers (`messageText`, `messageAttachments`, etc.), a closed-set `TURN_STATES` tuple, `messageTone`/`deliveryState` (fixed dispatch over the app's own small set of known role/state wire markers, not open-ended text), a fixed tool-name-to-label lookup table, and `deriveChatTitle` (a deterministic first-line/whitespace-collapse/word-boundary-clip truncation, explicitly not a generative decision, "there is deliberately no server auto-title verb," per its own doc comment, so this is mechanical text shortening, not the kind of natural-language guesswork Jev replaces). |
| `src/views/chat/QueuedMessagesPanel.test.tsx` | PORT | Tests the panel below. |
| `src/views/chat/QueuedMessagesPanel.tsx` | PORT | Lists/edits/deletes messages queued behind an in-flight turn via typed daemon verbs. No classification. |
| `src/views/chat/search-jump.test.ts` | PORT | Tests the scroll-target helpers below. |
| `src/views/chat/search-jump.ts` | PORT | Pure helpers turning a search result into a scroll target and checking readiness against the loaded lineage nodes; explicitly "never a guess," per its own doc comment (re-checked against real loaded state each render). |
| `src/views/chat/SessionHeader.test.tsx` | PORT | Tests the header below. |
| `src/views/chat/SessionHeader.tsx` | PORT | Renders the session title and a `<StatusBadge value={turnState} />` for the turn-state pill. Does not itself classify anything; `turnState` here is one of message-utils.ts's closed `TURN_STATES`. (`StatusBadge`'s underlying `classifyBadgeTone` heuristic is the actual decision point, recorded on `src/lib/presentation-bridge.ts` in a different batch, not duplicated here.) |
| `src/views/chat/ToolActivityGroup.test.tsx` | PORT | Tests the tool-activity fold below. |
| `src/views/chat/ToolActivityGroup.tsx` | PORT | Folds a completed turn's tool calls into its message; a real counted summary line ("3 tools · read×2, exec"), never an invented total. Pure rendering over client-observed stream events. |
| `src/views/chat/types.ts` | PORT | Type definitions only (`ChatMessage`, `ChatViewProps`). |
| `src/views/chat/useChatSearch.test.ts` | PORT | Tests the search hook below. |
| `src/views/chat/useChatSearch.ts` | PORT | Two search stages: a backend `sessions.search` call (id/title match) and a client-side `text.toLowerCase().includes(termLower)` substring match over the operator's own already-fetched messages, an ordinary find-in-page feature over the user's own typed query, not natural-language content classification. |
| `src/views/chat/useChatSend.test.ts` | PORT | Tests the send/edit/regenerate mutations below. |
| `src/views/chat/useChatSend.ts` | PORT | Send/edit/regenerate mutations. All error handling dispatches on typed error predicates (`isSessionNotFoundError`, `isAuthExpiredError`, `isSessionClosedError`, `isMethodUnavailableError`) - fixed structural error-type checks, not guesswork. |
| `src/views/chat/useChatStream.test.ts` | PORT | Tests the SSE stream wiring below. |
| `src/views/chat/useChatStream.ts` | PORT | SSE event-stream wiring: dispatches on exact, daemon-defined event-type strings (`turn.started`, `turn.delta`, `turn.tool_call`, `turn.completed`, etc.) and typed error predicates. Deterministic wire-protocol handling, no content classification. |

## Views: sessions

| File | Disposition | Note |
|---|---|---|
| `src/views/sessions/HostedSessionsView.test.tsx` | PORT | Follows HostedSessionsView.tsx. |
| `src/views/sessions/HostedSessionsView.tsx` | PORT | Daemon-hosted session list/attach/create/end/detach over sessions.hosted.* verbs, with tolerant reader helpers and honest capability/shape checks (isWellFormedListResponse, detach-policy labels read verbatim from the record). All structural dispatch on closed statuses and typed responses; no open-ended text guesswork, no WRFC/contract-tree state. |
| `src/views/sessions/HunkActionSheet.tsx` | PORT | Presentational touch-first action chooser for one reviewed diff hunk (approve/comment/reject), pure prop-driven sheet, no wire calls, no guesswork. |
| `src/views/sessions/HunkCommentSheet.test.tsx` | PORT | Follows HunkCommentSheet.tsx. |
| `src/views/sessions/HunkCommentSheet.tsx` | PORT | Presentational composer for a comment on one diff hunk; owns only draft text and composer-key handling, parent owns the steer/follow-up mutation. No guesswork. |
| `src/views/sessions/HunkRevertSheet.tsx` | PORT | Presentational reject/revert flow display (previewing/ready/conflict/applying/error phases handed in by the parent); renders the daemon's own preview stats and conflict string verbatim. No guesswork. |
| `src/views/sessions/SessionChanges.test.tsx` | PORT | Follows SessionChanges.tsx. |
| `src/views/sessions/SessionChanges.tsx` | PORT | The session's own live diff-review cockpit (sessions.changes.get, per-hunk approve/comment/revert via checkpoints.revertHunkPreview/revertHunk). This is the live coding session's own change-review UI, a different feature from the old WRFC controller's internal review loop; it displays no fleet/workstream/attempt-judgment state. All dispatch is on closed error/result shapes (isConflictError, isMethodUnavailableError, preview.applies/token). No guesswork. |
| `src/views/sessions/SessionRewind.test.tsx` | PORT | Follows SessionRewind.tsx. |
| `src/views/sessions/SessionRewind.tsx` | PORT | Session-detail rewind.plan/rewind.apply dry-run-then-confirm flow; renders the daemon's own plan/receipt fields verbatim (file/message counts, warnings). No guesswork. |
| `src/views/sessions/SessionsView.test.tsx` | JEV | Follows SessionsView.tsx. |
| `src/views/sessions/SessionsView.tsx` | JEV | The cross-surface session list/detail view. Marked JEV because its `PermissionModeControl` (lines 65-127) reads/sets a session's permission mode via `sdk.operator.sessions.permissionMode.get/set` and renders `PermissionModeSheet` (itself JEV elsewhere: permission mode becomes the gate presets sheet) and `permissionModeLabel` from `src/lib/permission-mode.ts` (also JEV elsewhere) - this view's wire calls and picker follow that contract as it becomes gate presets. No decision point of its own: the control only displays/sets a mode value handed to it, it does not itself classify or guess anything (the rest of the file - session list/filter/group, delete-capability tri-state probe, cost/context-usage chips, compaction-receipt rendering - is deterministic structural dispatch on closed statuses and server-supplied numbers). |
| `src/views/sessions/SteerComposer.test.tsx` | PORT | Follows SteerComposer.tsx. |
| `src/views/sessions/SteerComposer.tsx` | PORT | Mid-turn steer / follow-up composer over sessions.steer / sessions.followUp, fire-and-optimistic with local delivery-state tracking reconciled against the wire. No guesswork. |

## Views: memory

| File | Disposition | Note |
|---|---|---|
| `src/views/memory/AddMemoryForm.tsx` | PORT | The add-a-memory composer: a plain form over a fixed `MEMORY_CLASSES`/`MEMORY_SCOPES` enum, submits summary/detail/tags as typed fields. New records default to confidence 60 and reviewState 'fresh' on the daemon side; this form does not compute either. No guesswork. |
| `src/views/memory/ConsolidationReceipts.test.tsx` | PORT | Exercises ConsolidationReceipts's honest states (empty, 404 unavailable, 501 unavailable, 500 retryable, pending proposals, resolved runs); follows the source file's disposition. |
| `src/views/memory/ConsolidationReceipts.tsx` | PORT | Renders memory-consolidation proposals (contradiction / cross-scope-duplicate / stale-delete) already classified server-side by the engine's already-JEV knowledge/memory subsystem; this panel only formats `proposal.kind`/`reason`/`ids` via a fixed `PROPOSAL_KIND_LABEL` Record lookup over a closed union, and routes a "Review" click to the existing review queue by id. No client-side classification. |
| `src/views/memory/memory-helpers.test.ts` | PORT | Unit tests for memory-helpers.ts's pure formatting/predicate functions; follows the source file's disposition. |
| `src/views/memory/memory-helpers.ts` | PORT | Pure helpers: fixed enum tables (MEMORY_CLASSES/SCOPES/REVIEW_STATES), `isPersonaRecord` (exact cls+tag match), `reviewStateTone` (fixed switch over the closed `MemoryReviewState` union), `isBelowRecallFloor`/`formatConfidence` (arithmetic/formatting over a server-supplied confidence number and a server-supplied wire `recallFloor`, never a client-guessed threshold), `splitTags`, `formatProvenanceLink`, `formatTimestamp`. All deterministic; no open-ended text classification. |
| `src/views/memory/MemoryRecordDetail.test.tsx` | PORT | Exercises MemoryRecordDetail's field rendering and no-secret-render pin; follows the source file's disposition. |
| `src/views/memory/MemoryRecordDetail.tsx` | PORT | Renders a memory record's fields verbatim (type, scope, review-state, confidence, timestamps, tags, provenance); explicitly does no re-interpretation of any field. Deterministic display only. |
| `src/views/memory/MemoryRecordRow.tsx` | PORT | One record row: summary plus cls/scope/review-state/confidence badges and a delete button. Uses memory-helpers' fixed tone/format functions and a server-supplied `recallFloor`. No guesswork. |
| `src/views/memory/MemorySearchHonestyNote.test.tsx` | PORT | Exercises the honesty-note's exact wire-value labeling (limit, recallFloor); follows the source file's disposition. |
| `src/views/memory/MemorySearchHonestyNote.tsx` | PORT | Surfaces the recall-honesty contract fields (`indexUnavailableReason`, `caveat`, recall-filter exclusion counts, `recallFloor`) verbatim from the wire response; explicitly never paraphrases or hides them. Pure display of server-computed values. |
| `src/views/memory/MemoryView.test.tsx` | PORT | Component-state coverage for MemoryView's search/list/review-queue/consolidation/honest-degrade behavior against a stubbed sdk; follows the source file's disposition. |
| `src/views/memory/MemoryView.tsx` | PORT | The memory browse/search/add/review/delete view. Search filters (query text, semantic flag, scope, class, tags, recall) are typed fields passed straight to `sdk.operator.memory.search`; the recall-honesty contract, review-queue, and consolidation-proposal classification are all applied server-side by the engine's knowledge/memory subsystem (already JEV there) and rendered here verbatim. No client-side guesswork. |
| `src/views/memory/ReviewQueuePanel.tsx` | PORT | Renders the review queue; the operator edits reviewState/confidence/staleReason as a draft and explicitly commits via Save (`memory.records.update-review`) - a form input, not a classification the client performs. Uses memory-helpers' fixed tone/format functions. No guesswork. |

## Views: knowledge

| File | Disposition | Note |
|---|---|---|
| `src/views/knowledge/KnowledgeCandidates.test.tsx` | PORT | Follows KnowledgeCandidates.tsx. |
| `src/views/knowledge/KnowledgeCandidates.tsx` | PORT | Lists knowledge.candidates.list results and sends an explicit accept/reject/supersede decision per row via knowledge.candidate.decide, never auto-applied. Renders the server-computed `score` field with `toFixed(2)`, deterministic number formatting over a value the engine's knowledge subsystem (already JEV elsewhere) already computed; renders status via StatusBadge (its own decision point is recorded against src/lib/presentation-bridge.ts, not duplicated here). |
| `src/views/knowledge/KnowledgeJobsPeek.test.tsx` | PORT | Follows KnowledgeJobsPeek.tsx. |
| `src/views/knowledge/KnowledgeJobsPeek.tsx` | PORT | Lists knowledge.jobs.list / knowledge.job-runs.list results, sorted by requestedAt (numeric comparison) and mapped to job titles by exact id lookup. A truthiness fallback chain (mapped title -> jobId -> "Unknown job") over structured fields, not natural-language guesswork. Status rendered via StatusBadge (decision point recorded on presentation-bridge.ts). |
| `src/views/knowledge/KnowledgeMap.test.tsx` | PORT | Follows KnowledgeMap.tsx. |
| `src/views/knowledge/KnowledgeMap.tsx` | PORT | Renders the daemon's pre-rendered map `svg` string via an `<img data:>` URL (never dangerouslySetInnerHTML). `isRenderableSvg` is a fixed regex well-formedness gate over a machine format (`^<svg[\s>]/`, `</svg>\s*$/`), a structural document-shape check, not a decision point. The multiple named "honest empty state" branches (no knowledge indexed / jobs ran but 0 nodes / filtered to none / unfiltered still empty / map unavailable) are all deterministic comparisons of server-supplied counts (nodeCount, jobRunCount, overallNodeCount), not classification of open-ended text. |
| `src/views/knowledge/KnowledgePacket.test.tsx` | PORT | Follows KnowledgePacket.tsx. |
| `src/views/knowledge/KnowledgePacket.tsx` | PORT | Builds a knowledge.packet request from a free-text task field and renders the returned items, each with a server-computed relevance `score` formatted with `toFixed(2)` (deterministic display, not client classification) and an optional truncation disclosure gated on the daemon actually sending numeric `totalCandidates`/`droppedCount` fields (a type/presence check, not a guess). |

## Views: fleet, workstream and approvals

| File | Disposition | Note |
|---|---|---|
| `src/views/approvals/ApprovalCard.tsx` | PORT | The general gate-boundary approval card (per-hunk edit selection, approve/deny/claim/cancel, remember tiers, exec-prompt answer). Renders `judgmentVerdict`/`judgmentTone`/`judgmentLabel` from `src/lib/approvals.ts` labelled "proposed by the sandbox model-judgment tier: annotate-only, the human still decides" - a view of a value the engine's gate subsystem already computed, not a WRFC chain/review display. The intent document explicitly lists "approvals (including permission rules)" as PORT. |
| `src/views/approvals/ApprovalsTasksView.test.tsx` | PORT | Follows ApprovalsTasksView.tsx. |
| `src/views/approvals/ApprovalsTasksView.tsx` | PORT | Composes the Approvals section, PermissionRulesSection, and the Tasks section (submit/cancel/retry over `tasks.*`). `ApprovalClassMatrix` groups already-loaded records by `request.category`/`request.analysis.riskLevel`, a tally over daemon-supplied closed-ish fields, not a client classification. General gate/task UI, unrelated to WRFC chain/review state. |
| `src/views/approvals/PermissionRulesSection.tsx` | PORT | Lists/deletes durable approval rules (`permissions.rules.list/delete`). Pure display of daemon-recorded rules; distinct from the permission-MODE data model (a different, already-JEV file in another batch). |
| `src/views/fleet/AttemptComparison.test.tsx` | JEV | Follows AttemptComparison.tsx. |
| `src/views/fleet/AttemptComparison.tsx` | JEV | The best-of-N candidate-comparison and pick surface (`fleet.attempts.judge`/`fleet.attempts.pick`), explicitly UI-labelled "Model judgment... proposal only, a human still confirms." This is the intent's "candidate selection replacing the prompt-and-parse judge" / "best-of-N as candidate selection" that replaces WRFC's own attempt judging. The judging itself runs server-side (already covered as JEV in the engine inventory); this file is the contract-tree view over that judgment plus the manual-pick UI. No decision points of its own: no client-side keyword/score classification, only rendering the daemon's judgment result and dispatching the operator's pick. |
| `src/views/fleet/FleetApprovalInline.tsx` | PORT | "Approve from the tree": renders the same `ApprovalCard` inline in a fleet node's detail pane, correlated by `lib/fleet.ts`'s `approvalsForNode` (an exact sessionId/agentId match, not a guess). Same general gate-approval feature as ApprovalsTasksView, not a WRFC-chain/review display. |
| `src/views/fleet/FleetSessionActions.tsx` | PORT | Compact steer input and detach action for a fleet node with a live session ref, over the same `sessions.steer`/`sessions.detach` verbs SteerComposer uses. Deterministic wire dispatch; no judgment content. |
| `src/views/fleet/FleetView.test.tsx` | JEV | Follows FleetView.tsx. |
| `src/views/fleet/FleetView.tsx` | JEV | The live process/session tree over `fleet.snapshot()`. Its detail pane renders `NodeReviewSummary` (its own comment: "Only on a reviewed wrfc-chain / wrfc-subtask node"), opens `AttemptComparison` for ready best-of-N attempt groups, and renders `TaskGraphPanel` for workstream nodes - the contract-tree views established elsewhere in this inventory. The rest of the file (plain process browsing, archive/restore, steer/detach dispatch, `stateTone`'s closed-enum severity mapping over known process states) is ordinary deterministic UI, but because this file is the host surface for the WRFC-descended review/attempt-judgment features, it carries the same JEV disposition as those child views, per the owner ruling that such displays become contract-tree views rather than staying plain PORT. No decision points of its own (no open-ended text classification; `stateTone` and `KindBadge`'s "known kind" check are closed-set lookups over already-enumerated process states/kinds). |
| `src/views/workstream/WorkstreamView.test.tsx` | JEV | Follows WorkstreamView.tsx. |
| `src/views/workstream/WorkstreamView.tsx` | JEV | Explicitly the intent document's "the workstream view, which becomes the contract-tree view": renders `fleet.snapshot()` filtered to `workstream`/`phase`/`work-item` node kinds. No decision points (its `stateTone` mirrors FleetView's closed-enum mapping, and it reuses `NodeHeadline`/`NodeStallBadge` read-model helpers, which are deterministic field reads, not judgments). |

## Views: calendar, dates, check-in, checkpoints, CI, mail, phone, principals

| File | Disposition | Note |
|---|---|---|
| `src/views/calendar/CalendarEventPeek.tsx` | PORT | Reads `calendar.events.get` for the peek detail; plain query-state rendering, no classification. |
| `src/views/calendar/CalendarView.test.tsx` | PORT | Follows CalendarView.tsx. |
| `src/views/calendar/CalendarView.tsx` | PORT | Its own `unconfiguredNote` dispatches on typed error-predicate functions (`isCalendarUnconfiguredError`, `isMethodUnavailableError`, `isMethodNotInvokableError`, `isCalendarAuthFailedError`) in a fixed order, exactly mirroring `src/lib/mail-refusal.ts`'s already-PORT structural dispatch. Deterministic; not a decision point. |
| `src/views/checkin/CheckInView.tsx` | PORT | Proactive check-in config/receipts/run-now over `checkin.*`. `outcomeLabel`/`outcomeTone` are exact-match switches over the wire's own closed outcome enum (`delivered`/`quiet`/`skipped-disabled`/`skipped-quiet-hours`/`skipped`/`error`), not a guess. |
| `src/views/checkpoints/CheckpointsView.test.tsx` | PORT | Follows CheckpointsView.tsx. |
| `src/views/checkpoints/CheckpointsView.tsx` | PORT | Workspace checkpoints browser (list/diff/create/restore) over `checkpoints.*`. Destructive restore is gated behind an explicit confirm sheet naming a preview; all dispatch is on daemon-reported booleans/reasons, not client guesswork. |
| `src/views/ci/CiWatchesView.test.tsx` | PORT | Follows CiWatchesView.tsx. |
| `src/views/ci/CiWatchesView.tsx` | PORT | Standing CI watches and ad hoc status lookup over `ci.*`. `overallTone`/job-conclusion badges are exact-match switches over the daemon's own closed verdict vocabulary (`passed`/`failed`/`pending`, `success`/other), not a classification of free text. |
| `src/views/dates/DatesGiftHistoryPeek.tsx` | PORT | Read-only gift-history peek over `occasions.gifts`; renders daemon-supplied records verbatim. |
| `src/views/dates/DatesView.test.tsx` | PORT | Follows DatesView.tsx. |
| `src/views/dates/DatesView.tsx` | PORT | Occasions/plans panel over `occasions.*`. Its own header comment is explicit: "nothing here computes a proximity word, a lead-time adjustment, a nudge cadence, or a nudge date, every one of those stays server-side" - this view only calls the read/write verbs and renders their answers (including `proximityTone`, an exact-match switch over the wire's own closed `approaching`/`imminent`/`soon` enum). No client-side guesswork. |
| `src/views/mail/MailMessagePeek.tsx` | PORT | Full-message peek over `email.inbox.read`; deliberately never renders sender HTML and never fetches attachments (fixed policy, not a decision point). Uses `mailRefusalNote` (PORT, structural dispatch) for its own error state. |
| `src/views/mail/MailView.test.tsx` | PORT | Follows MailView.tsx. |
| `src/views/mail/MailView.tsx` | PORT | Inbox/reader/composer over `email.*`. All classification of refusal shapes is delegated to `mailRefusalNote` (`src/lib/mail-refusal.ts`, a different batch, already PORT: structural dispatch on typed error predicates). This file adds no guesswork of its own. |
| `src/views/phone/PhoneNodeView.tsx` | PORT | This browser acting as a paired device-capability node. `CAPABILITY_LABELS` is a fixed dictionary keyed by exact capability id strings (`device.camera.rear.capture` etc.), a closed-set lookup, not a guess. |
| `src/views/principals/PrincipalsView.tsx` | PORT | Admin over the principal registry (`principals.*`) and channel-profile bindings (`channels.profiles.*`). `identitiesFromDraft`'s one-"channel:value"-pair-per-line parsing is a fixed, documented encoding (split on the first colon), not natural-language interpretation. The `permissionMode` field here is a plain fixed-enum dropdown (`plan`/`normal`/`accept-edits`/`auto`) used to set one channel-profile default; a different concern from the permission-mode data model (`src/lib/permission-mode.ts`, a different batch, already JEV) and not itself a decision point. |

## Views: admin, chat, knowledge and providers wrappers

| File | Disposition | Note |
|---|---|---|
| `src/views/AdminView.tsx` | PORT | Composes the admin surface: daemon login form, explicit-token form, auth/daemon-status/local-auth data blocks, and the settings-panel launchers (notification, pairing tokens, power, memory diagnostics, owner profile, Tailscale, mail account). Every branch is a fixed query-state switch (pending/error/data) or a form submit; no free-text classification of its own. |
| `src/views/ChatView.tsx` | PORT | Composes the chat sub-view (SessionHeader, MessageList, Composer, ChatSearch, QueuedMessagesPanel) over `useChatStream`/`useChatSend`. Its client-side auto-title step calls `deriveChatTitle` (src/views/chat/message-utils.ts, a different batch) and only fires when the current title exactly equals one of a fixed set of placeholder strings (`''`, the session id, `'New Chat'`, the raw first-72-chars slice, or the derived title itself) - a closed set of exact-string comparisons, not a guess. Confirmed by reading message-utils.ts: `deriveChatTitle` itself is a deterministic mechanical transform (first non-empty line, collapse whitespace, truncate on a word boundary, strip trailing punctuation), not a natural-language judgment about the conversation's topic, so it stays PORT rather than becoming a Jev reading. |
| `src/views/ChatView.test.tsx` | PORT | Exercises ChatView's turn-lifecycle reset-on-session-switch behavior and the send-created-session race; follows ChatView.tsx's disposition. |
| `src/views/KnowledgeView.tsx` | PORT | Composes the knowledge ask/search bar, ingest-URL form, knowledge map, wiki-projection browser/render/materialize actions, and the sources/nodes/issues/refinement record panels. All fields rendered (`answerText`, `facts`, `gaps`, scores elsewhere) are values the daemon/engine's already-JEV knowledge subsystem computed; this file only does client-side pagination slicing and a fixed field-name fallback chain (`firstString`/`firstArray` over known key names), never a content classification of its own. |
| `src/views/KnowledgeView.test.tsx` | PORT | Pins the "never dump raw JSON when an honest empty/activity state is available" behavior of the Knowledge Map panel; follows KnowledgeView.tsx's disposition. |
| `src/views/ProvidersView.tsx` | PORT | Composes the provider list/detail, current-model panel, model grid, per-route auth freshness panel, and credential/accounts panels. Status pills render `deriveProviderStatus`/`providerHeaderLabel` (src/lib/provider-status.ts, a different batch) and route `.freshness` values already computed there; this file adds no classification of its own (only shallow-merging two daemon response shapes and exact-field lookups). |
| `src/views/ProvidersView.test.tsx` | PORT | Pins that provider status pills reflect real per-route freshness and that the header sources the real `configured`/`configuredVia` signal, including the worst-freshness rollup and the catalog-mismatch case; follows ProvidersView.tsx's disposition. |
