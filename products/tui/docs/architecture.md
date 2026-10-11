# Architecture

How the `goodvibes-tui` source is laid out, which directions imports may go, and the one place the TUI keeps the SDK's pane-era operator vocabulary.

## Source layout

| Directory | Holds |
| --- | --- |
| `src/main.ts`, `src/core/` | Terminal entrypoint, orchestrator, conversation and transcript state |
| `src/renderer/` | Raw ANSI compositor, overlays, modals, fullscreen workspaces, the modal kit (`surface-kit*.ts`) |
| `src/views/` | View content shown in modals: modal surfaces (`src/views/modals/`), the fleet read model and acts behind the Agents modal, the notification history feed, view drawing helpers (`polish*.ts`), and the operator API bridge (`view-panel-adapter.ts`) |
| `src/input/` | Slash commands, keybindings, composer, pickers, settings modals |
| `src/runtime/` | Bootstrap wiring, the typed runtime store, service composition, session recovery |
| `src/shell/` | Shell-level modal openers, blocking input, retry affordances |
| `src/test/` | The suite, mirroring the tree above (`src/test/views/` for `src/views/`) |

Every view opens as a modal over the conversation. There is no side-by-side layout and no persisted layout state: the runtime store has no slot for one, and a session saved by an older TUI that recorded one (`returnContext.openPanels` and an "Open panels: ..." line) loads without it. The SDK's session loader drops that legacy field, and every TUI save path writes the session back without it.

## Layer rules

`bun run architecture:check` (`scripts/check-architecture.ts`) enforces these import directions over `src/`. The layer of a file is its top-level directory under `src/`.

| Layer | Directories |
| --- | --- |
| 0 foundation | `config`, `providers`, `utils`, `permissions`, `tools`, `mcp`, `audio`, `export`, `verification`, `widget`, `scripts`, and the other leaf directories |
| 1 domain | `core` |
| 2 runtime | `runtime` (bootstrap files are composition roots and may import the UI layer) |
| 3 shell UI | `input`, `renderer`, `views` (they may import each other) |
| 4 entrypoint | `cli`, `daemon` |

Forbidden directions:

- `renderer`, `input` and `views` must not import `cli` or `daemon`.
- `config` and `providers` must not import `renderer`, `input`, `views`, `cli` or `daemon`.
- `channels` must not import `renderer`, `input` or `views`.
- `audio` must not import `renderer`, `input`, `views` or `cli`.
- `daemon` must not import `renderer`, `input` or `views`.

The same check also runs import-cycle detection, the source-file size gate, the raw hex color ratchet over `src/views/` and `src/renderer/`, the selected-index rule over `src/views/`, and the unused-export gate.

## The operator API bridge

The SDK's `IntegrationHelperService` serves the operator API verbs `panels.list` and `panels.open` (and their HTTP routes) from its `panelManager` option, typed `PanelManagerLike`. Remote clients, the web UI and the daemon already use those names, so they are an SDK and wire contract, not a TUI design choice, and the TUI does not rename them.

`src/views/view-panel-adapter.ts` (`createViewPanelAdapter`, wired in `src/runtime/services.ts`) is the only TUI module that implements that contract and the only place its vocabulary is kept:

- `panels.list` returns the views a remote client can open: Agents, Usage, Changes, Notifications and Sessions.
- `panels.open` opens the named view as its modal, through the opener the shell sets once the modal host exists.
- The contract's top and bottom lists of open items are always empty, because nothing is ever open outside a modal.

Other SDK names that belong to the same contract family and stay as they are: the notification router target `panel_only` (it now feeds the notification history), `Notification.panelId`, the notification action type `jump_to_panel`, and the daemon capability string `panels`.

The `/panel` slash command (`src/input/commands/legacy-panel-command.ts`) is a separate, deliberate alias: it takes the old view names people still type and opens the modal that holds that content now.

## Shared runtime ownership

### Policy commands

- The registered `/policy` and `/pol` handler calls public
  `@goodvibes-jev/engine/sdk/platform/gate/policy.runPolicyCommand`.
  The TUI [dispatcher adapter](../src/input/commands/policy-dispatch.ts) binds
  surface services and provides compatibility forwarding. Subcommand grammar,
  aliases, parsing, bundle lifecycle, simulation, lint, preflight, promotion,
  rollback, status and trend recording have one engine owner.
- Services remain lazy: opening the TUI policy modal or displaying usage requires
  no policy state, path, config or MCP access. The actual `openPolicyView`
  callback and the registration's modal-specific text stay in the TUI.
- Config reads use `configManager.getAll()` at invocation time. The bootstrap's
  `platform.config` is a cloned startup snapshot. Both the simulator and the
  dashboard receive the current `permissions.divergenceThreshold`, including
  zero; the default is 0.05.
- The optional product registry override and working-directory error are
  preserved. MCP preflight receives the existing security records through the
  engine's narrow context, using its public context types and signatures.
- Successful load/promote/rollback mutations are announced and notified before
  lint refresh. A refresh failure is reported separately and does not turn a
  successful mutation into a failed one. Late simulation results are fenced by
  active bundle and dashboard identity. Late lint/preflight results are fenced
  by bundle identity. Preflight refreshes the lint cache, publishing it only
  while its current/candidate bundle identities still match; a stale refresh
  cannot overwrite newer findings or notify stale findings.
- Awaited reader errors, including reader cancellation, reject without recording
  a successful simulation or preflight result. Cancelled preflight retains the
  prior lint cache and review. Clearing or replacing a simulation dashboard
  prevents a delayed result from restoring it. This boundary adds no
  cancellation API.
- The explicit `--force` grammar and warning are preserved. This command
  ownership boundary adds no approval prompt, human semantic decision loop,
  execution authority, provider, title, scheduler, credential or network
  behavior.

### Session titles

- `@goodvibes-jev/engine/sdk/platform/sessions` exports
  `createSessionTitleGenerator`, `SessionTitleGenerator`, `SessionTitleModel`
  and `sanitizeSessionTitle` through the existing sessions subpath.
- The engine owns extraction of the first nonempty user text (including text
  parts), the title prompt, the 2000-character input bound, the 24-token request,
  deterministic formatting and the 60-character output bound. The supplied
  model is the configured tool/helper model. This is text generation, not a Jev
  semantic reading or authorization decision.
- The generator claims its single attempt before awaiting the model. Missing
  user text consumes no attempt. Input snapshots are acquired lazily, so a
  consumed attempt never clones the history again on later turns. Rejection
  and empty responses return no title and still consume the attempt. There
  are no retries, new model selection or extra calls beyond this one attempt.
- TUI settings remain product-owned and off by default. The actual
  `wireSessionAmbience` caller delegates via the thin
  [auto-titler](../src/core/session-auto-titler.ts), retaining TURN_COMPLETED
  subscription, title application, notification and repaint. Live configuration
  is readable before each attempt. Disabling the setting prevents new attempts,
  but does not cancel the result of an already-started call that still belongs
  to the same live conversation.
- The TUI rechecks user-title ownership immediately before applying a result.
  Session ID, conversation replacement generation and terminal lifetime must
  still match. Unsubscribe closes delivery before removing the listener.
- The product conversation replacement generation advances only at `resetAll`
  and `fromJSON`, including `/clear`, `/reset`, import and same-ID resume. Normal
  message append does not invalidate the title. The SDK's private message-cache
  revision advances for ordinary message edits and cannot express this lifetime.
- Reset, reload, a late result or disposal never creates another generator or
  resets its single-attempt budget. The model interface has no cancellation
  signal; in-flight work may finish, but cannot write a title, notify or repaint
  after losing ownership. No shutdown wait is introduced.

### Error reading and recovery

- Meaning and recovery wording come from public
  `@goodvibes-jev/engine/sdk/platform/routing.readUserFacingError`.
  The [TUI error adapter](../src/core/format-user-error.ts) also re-exports
  `readUserFacingErrorLine`. It has no local status/word/substring regex
  classifier or subscription-session special case. Typed HTTP status and errno
  retain the engine's structural authority even when prose is deceptive;
  subscription-session wording also belongs to the public reader.
- A product-owned notice queue starts asynchronous readings concurrently and
  delivers in event order. Its 1.5-second deadline bounds narration latency.
  Reader rejection, missing reader or an unread result at the deadline is
  explicit unavailable interpretation with the original summarized error;
  it never fabricates a generic class or substitutes a regex. A successful
  error reading is retained if only related narration preparation times out.
  Queue timing is not a semantic routing decision or an approval prompt.
- Cancel/dispose synchronously clear timers and discard delivery closures. The
  public reader has no cancellation parameter, so its underlying request may
  finish, but its settled value cannot reach the closed product lifetime.
- Stream delivery rechecks submission generation, event turn ID, session ID,
  model selection, terminal lifetime and pending failover authority. New user
  submission, cancellation, completion and disposal invalidate prior work.
  Old terminal events cannot revoke a newer turn's notice.
- Existing optimizer selection/visited-provider behavior remains the routing
  owner. The asynchronous wording is not used to authorize or select failover.
  A deadline or unavailable wording therefore does not stop an otherwise
  permitted recovery, and is honestly named in that recovery's notice.
- A pending failover hold is acquired synchronously before reading. The
  one-turn notification owner preserves elapsed time from the original user
  submission, task and tally through synchronous and asynchronous retry
  submission, producing one end notice. Failed retry releases one terminal
  failure; cancellation/supersession drops the stale hold. The retry grace
  deadline independently revokes a retry that never starts.
- The complete failover notice is passed through retry rollback, so it is
  posted after rollback and before the retried prompt. The main caller rechecks
  turn authority after its memory-preparation await; a later cancellation or
  session switch cannot submit old work. The retained turn hold also revokes
  that post-memory authority when the retry grace expires.
- Esc/Ctrl+C invoke the real cancellation action with the pending recovery
  owner, even after the SDK has finalized the failed attempt and `isThinking`
  is false. Cancellation during either reading or memory preparation cannot
  start another attempt. A new composer submission supersedes old recovery
  before its own asynchronous intake, not just when it reaches dispatch.
- The recovery abort signal remains relayed through native SDK admission,
  which may await permit revalidation while `isThinking` is false. Cancellation
  during held revalidation must reject with `AbortError` and add no conversation
  messages. Actual TURN_SUBMITTED transfers ownership without aborting the new
  active turn. External model changes revoke pending admission. Session fork,
  named save, command resume and browser resume cancel pending recovery before
  replacing session identity/history; startup recovery stays unchanged.
- Process rejections use the same bounded owner, keep structural provider
  labeling, and cannot recursively report a reader failure as another unhandled
  rejection. Terminal restore cancels pending delivery before its first terminal
  write. Cascading critical rejections supersede queued individual notices.
  Listener cleanup and terminal teardown remain best-effort: one cleanup failure
  must not prevent independent cleanup or terminal restoration.

### Focused contract validation

These checks use controlled models/readings and fixture data, without live
credentials or provider calls. Run from the repository root through the shared
test wrapper, which holds the workspace lock; see
[Testing and validation](testing-and-validation.md). These are focused source
checks and do not certify type/API checks, independent review, full-workspace
checks, compiled applications, live providers, hosted CI or merge qualification.
Those require their own checks against the exact commit being qualified.

Policy tests cover the actual registration and modal route, grammar/aliases,
lazy services, default/non-default/zero thresholds, live config, registry
fallback/override, MCP security mapping, mutation/refresh separation, awaited
reads, cache publication and stale/cancelled outcomes:

```sh
bun packages/engine/scripts/test.ts test/gate-policy-command.test.ts \
  test/gate-policy-command-safety.test.ts \
  test/gate-policy-lint.test.ts \
  test/gate-policy-preflight.test.ts \
  test/gate-policy-registry.test.ts \
  test/gate-policy-simulation-scenarios.test.ts \
  test/gate-policy-diagnostics-panel.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/input/policy-engine-owner.test.ts \
  src/test/input/policy-record-trend-command.test.ts \
  src/test/views/modals/policy-modal.test.ts
```

Title tests cover the exact prompt/limits, text extraction, formatting,
missing-input/failed/empty/overlapping attempts, live opt-in and disabling,
user-title races, one call/notice/repaint, session switching, same-ID
reset/fromJSON and real stored-session resume, disposal, terminal restore and
ordinary append:

```sh
bun packages/engine/scripts/test.ts test/sessions/session-title.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/core/session-auto-titler.test.ts \
  src/test/runtime/session-ambience-title.test.ts
```

Error tests drive the public reader and actual stream, turn-notification and
cancellation owners. They cover typed evidence versus misleading prose,
subscription wording, rejection/never-settle behavior, ordered delivery,
lifetime fences, rollback, deferred retry authority, original turn duration,
grace expiry and cancellation during real native permit revalidation:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/tui src/test/core/format-user-error.test.ts \
  src/test/core/user-error-owner-adoption.test.ts \
  src/test/core/turn-notice-single-owner.test.ts \
  src/test/core/turn-cancellation-recovery.test.ts \
  src/test/runtime/process-lifecycle-rejection-labeling.test.ts
```

Related [failover](../src/test/core/failover-wiring.test.ts),
[effort remapping](../src/test/core/failover-effort-remap.test.ts),
[effort notices](../src/test/core/failover-effort-notice.test.ts),
[retry affordances](../src/test/shell/retry-affordance.test.ts) and
[stall](../src/test/core/stream-stall-watchdog.test.ts) tests retain their
behavioral assertions while awaiting asynchronous notices.
[Cleanup](../src/test/runtime/process-lifecycle-cleanup.test.ts),
[restore](../src/test/runtime/process-lifecycle-restore.test.ts) and
[exit](../src/test/runtime/process-lifecycle-exit-messaging.test.ts) tests cover
listener ownership and best-effort teardown independently of error reading.

## Canonical eval and provider-health consumers

Eval construction and provider-health presentation consume the public canonical
engine owners. Provider-health polling coalesces slow automatic reads, preserves
manual latest-wins refresh and discards results after closure. Browser-safe public
entries must not acquire external or Node runtime dependencies.

The public browser-consumer proof uses the existing bounded, reaped bundler
subprocess. Preserve source-condition resolution, emitted-function execution and
Node/Bun-import rejection; do not replace it with in-process bundling. Validate
compiled Node consumers against the public provider-health, gate-preset and
EvalRegistry exports, alongside focused eval commands, provider-health ownership,
settings-provider surfaces, modal liveness and provider repair behavior.
