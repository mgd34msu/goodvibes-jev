# Engine inventory: goodvibes-sdk to packages/engine

Every source file of goodvibes-sdk (`packages/*/src`, tests excluded) with its disposition, grouped by the intent's engine subsystems. Nothing is dropped unless it is specific to WRFC or QEMU; everything else uses Jev where judgment applies or is ported exactly. Jev is in place of WRFC: WRFC code is JEV in the contract runner, and docs/inventory/wrfc-to-jev.md maps each WRFC function to its Jev form. A JEV file lists each place it decides something by guesswork today and the battery or pattern from `packages/judgment` that replaces it. A PORT file with decision points keeps its code but its guesswork moves to the JEV subsystem the intent names (for providers, the new routing subsystem). HOIST applies to product modules moving into the engine and is recorded in the product inventories.

Files: 2371. PORT 1868, JEV 501, DROP 2. Decision points: 175.

| Subsystem | Files | PORT | JEV | DROP | Decision points |
|---|---|---|---|---|---|
| CI watch, power | 15 | 15 | 0 | 0 | 0 |
| automation, scheduler | 33 | 32 | 1 | 0 | 1 |
| batch | 3 | 3 | 0 | 0 | 0 |
| browser, devices | 25 | 25 | 0 | 0 | 4 |
| calendar | 22 | 22 | 0 | 0 | 0 |
| channels, adapters, channel profiles, channel sync | 76 | 76 | 0 | 0 | 2 |
| check-in | 9 | 1 | 8 | 0 | 1 |
| client auth | 12 | 12 | 0 | 0 | 0 |
| cloudflare, integrations | 22 | 22 | 0 | 0 | 0 |
| cluster | 31 | 31 | 0 | 0 | 0 |
| companion, push, pairing, relay, remote access | 48 | 48 | 0 | 0 | 0 |
| config | 88 | 88 | 0 | 0 | 0 |
| contract runner (Jev in place of WRFC) | 19 | 1 | 18 | 0 | 13 |
| contracts | 25 | 25 | 0 | 0 | 0 |
| control plane | 163 | 0 | 163 | 0 | 2 |
| core | 38 | 0 | 38 | 0 | 5 |
| daemon routes (daemon-sdk) | 34 | 34 | 0 | 0 | 0 |
| daemon server | 84 | 84 | 0 | 0 | 1 |
| discovery, mcp, plugins, acp | 29 | 29 | 0 | 0 | 0 |
| email, google | 102 | 102 | 0 | 0 | 9 |
| embed | 1 | 1 | 0 | 0 | 0 |
| error contract | 4 | 4 | 0 | 0 | 2 |
| events | 37 | 37 | 0 | 0 | 0 |
| gate (replaces permissions) | 58 | 0 | 58 | 0 | 8 |
| hooks, workflow, triggers, watchers | 36 | 36 | 0 | 0 | 0 |
| hosted sessions | 11 | 0 | 11 | 0 | 0 |
| intelligence, git, workspace | 40 | 40 | 0 | 0 | 1 |
| knowledge | 127 | 0 | 127 | 0 | 60 |
| observe (new) | 13 | 0 | 13 | 0 | 0 |
| observer | 1 | 1 | 0 | 0 | 0 |
| occasions | 19 | 0 | 19 | 0 | 2 |
| operator and peer clients | 9 | 9 | 0 | 0 | 0 |
| orchestration (workstreams, ported) | 23 | 21 | 2 | 0 | 2 |
| owner profile, personal capture | 17 | 17 | 0 | 0 | 0 |
| payments | 32 | 0 | 32 | 0 | 4 |
| presentation | 5 | 5 | 0 | 0 | 0 |
| principals | 4 | 0 | 4 | 0 | 1 |
| profiles, templates | 5 | 5 | 0 | 0 | 0 |
| providers | 89 | 89 | 0 | 0 | 19 |
| runtime | 484 | 484 | 0 | 0 | 11 |
| runtime sandbox (QEMU removed, intent lines 49 and 215) | 6 | 4 | 0 | 2 | 0 |
| sdk published entry points | 24 | 24 | 0 | 0 | 0 |
| security | 21 | 21 | 0 | 0 | 0 |
| sessions, bookmarks, rewind, export, artifacts | 24 | 24 | 0 | 0 | 0 |
| skills | 4 | 0 | 4 | 0 | 0 |
| state | 39 | 39 | 0 | 0 | 7 |
| sub-agents | 25 | 22 | 3 | 0 | 4 |
| terminal shell | 36 | 36 | 0 | 0 | 0 |
| toolchain | 30 | 30 | 0 | 0 | 0 |
| tools | 112 | 112 | 0 | 0 | 5 |
| transports | 37 | 37 | 0 | 0 | 0 |
| types, errors, utils, node | 43 | 43 | 0 | 0 | 8 |
| voice, multimodal, media | 65 | 65 | 0 | 0 | 3 |
| web search | 12 | 12 | 0 | 0 | 0 |

## CI watch, power

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/ci-watch/auto-watch.ts` | PORT | Mints a CI watch automatically when an exec tool call or a GitService push contains a git push or gh pr create, by parsing the command's tokens for the literal command shape (not natural-language interpretation) and resolving the GitHub repo slug and branch via git itself. Word scan hit found nothing on inspection beyond fixed-shape command-line parsing. |
| `sdk/src/platform/ci-watch/gh-source.ts` | PORT | ci-watch/gh-source.ts A CiStatusSource backed by the `gh` CLI. |
| `sdk/src/platform/ci-watch/index.ts` | PORT | ci-watch/, watch CI on a repo/PR with an honest, per-job verdict. |
| `sdk/src/platform/ci-watch/poller.ts` | PORT | ci-watch/poller.ts, the daemon polls registered CI watches. |
| `sdk/src/platform/ci-watch/report.ts` | PORT | ci-watch/report.ts Derives the overall CI verdict from the PER-JOB conclusions, the whole point of the doctrine. |
| `sdk/src/platform/ci-watch/service.ts` | PORT | ci-watch/service.ts The CI-watch service: the one-shot per-job status tool, plus the standing subscription mechanism. |
| `sdk/src/platform/ci-watch/subscriptions.ts` | PORT | ci-watch/subscriptions.ts Durable storage for standing CI watches, over the same PersistentStore snapshot pattern the other registries use. |
| `sdk/src/platform/ci-watch/types.ts` | PORT | ci-watch/types.ts Watching CI on a repo/PR with an honest, per-job verdict. |
| `sdk/src/platform/power/index.ts` | PORT | power/, sleep ownership: automatic work inhibition, sleep-edge honesty, and the owner's keep-awake toggle (see manager.ts for the ruling's shape). |
| `sdk/src/platform/power/keep-awake-remote.ts` | PORT | keep-awake-remote.ts, forward the owner keep-awake toggle to an adopted EXTERNAL daemon over the `power.keepAwake.set` gateway verb. |
| `sdk/src/platform/power/linux-logind.ts` | PORT | Linux logind power seam: holds sleep/idle inhibitors via systemd-inhibit, watches the PrepareForSleep signal via a long-lived dbus-monitor subscription, and reaps orphaned power children whose owning process died. All text matching is against this module's own fixed process-argv stamps and dbus-monitor's fixed wire format, not free-text meaning; no decision points. |
| `sdk/src/platform/power/manager.ts` | PORT | power/manager.ts, sleep ownership policy over the platform seam. |
| `sdk/src/platform/power/runtime-wiring.ts` | PORT | power/runtime-wiring.ts, one-call composition of sleep ownership for the runtime-services root: pick the platform seam (Linux logind on linux; the honest unavailable seam elsewhere until the macOS IOKit seam lands), star |
| `sdk/src/platform/power/types.ts` | PORT | power/types.ts, the platform sleep-inhibition seam. |
| `sdk/src/platform/power/work-signals.ts` | PORT | power/work-signals.ts, binds the runtime event bus to the PowerManager's work holds, so "real work" holds the sleep inhibitor automatically: - a running turn (TURN_SUBMITTED → terminal turn event), - an active agent/flee |

## automation, scheduler

| File | Disposition | Note |
|---|---|---|
| `daemon-sdk/src/automation.ts` | PORT | Daemon HTTP route dispatcher for the automation/jobs/runs/schedules/deliveries API family: matches path and method to handlers with fixed regexes over URL paths. Pure routing, no meaning judgment; the subsystem's JEV reading of failure transience applies to the delivery/retry model this dispatcher routes to (see sdk/src/platform/integrations/delivery.ts), not to this file. |
| `sdk/src/platform/automation/delivery-manager.ts` | PORT | Delivers a job run's result to its configured targets with retry. calculateRetryDelay is a deterministic backoff formula (fixed/linear/exponential). The retryable-vs-terminal call at line 243 (const retryable = classifyDeliveryError(error) === 'retryable') delegates to classifyDeliveryError in sdk/src/platform/integrations/delivery.ts, which is the file that actually guesses failure transience from the error message (outside this file list; flag for the coordinator if not already covered elsewhere). |
| `sdk/src/platform/automation/delivery.ts` | PORT | Type definitions for delivery mode, policy and attempt records; no logic. |
| `sdk/src/platform/automation/failures.ts` | PORT | Type definitions for the failure policy and failure record (action, retry policy, dead-letter route); no logic, config-shaped data only. |
| `sdk/src/platform/automation/index.ts` | PORT | Barrel export for the automation package; no logic. |
| `sdk/src/platform/automation/jobs.ts` | PORT | AutomationJob record type definition; no logic. |
| `sdk/src/platform/automation/manager-runtime-delivery.ts` | PORT | Schedules failure follow-up notices and delivers completed run results; target resolution and message building are deterministic, config-driven. |
| `sdk/src/platform/automation/manager-runtime-events.ts` | PORT | Emits automation lifecycle events onto the runtime bus; pure event construction, no decisions. |
| `sdk/src/platform/automation/manager-runtime-execution.ts` | PORT | Resolves and executes a job's run against a session target; branching is on explicit config fields (execution mode, target kind), not guessed meaning. |
| `sdk/src/platform/automation/manager-runtime-helpers.ts` | PORT | Job/run normalization and default-policy builders; deterministic field defaulting and provider/model id validation against the config-supplied model list. |
| `sdk/src/platform/automation/manager-runtime-job-mutations.ts` | PORT | Create/update/toggle operations on automation job records; deterministic field validation and persistence. |
| `sdk/src/platform/automation/manager-runtime-missed.ts` | PORT | Records a missed scheduled run; describeMissedRunReason formats a fixed time-delta message, not a meaning guess. |
| `sdk/src/platform/automation/manager-runtime-reconcile.ts` | PORT | Reconciles active runs against known agent/session terminal states on restart; matching is against a fixed set of status enums, not a guess. |
| `sdk/src/platform/automation/manager-runtime-scheduling.ts` | PORT | Timer-based job scheduling and heartbeat-wake queuing; deterministic timer/date arithmetic. |
| `sdk/src/platform/automation/manager-runtime-sync.ts` | PORT | Pushes job/run records onto the runtime dispatch snapshot; pure data forwarding. |
| `sdk/src/platform/automation/manager-runtime.ts` | PORT | AutomationManager: the scheduler/executor facade wiring the runtime-* modules together (jobs, runs, delivery, scheduling, reconcile); orchestration only, decisions live in the pieces it composes. |
| `sdk/src/platform/automation/manager.ts` | PORT | Thin re-export of the AutomationManager; no logic. |
| `sdk/src/platform/automation/routes.ts` | PORT | AutomationRouteBinding and AutomationRouteResolution type definitions (including a confidence/reason shape); no resolution logic in this file, the resolver itself is hoisted from the daemon per the intent's channels/adapters row. |
| `sdk/src/platform/automation/runs.ts` | PORT | AutomationRun and telemetry record type definitions; no logic. |
| `sdk/src/platform/automation/scheduler-capacity.ts` | PORT | Computes scheduler slot/queue-depth capacity counts from run records; pure arithmetic. |
| `sdk/src/platform/automation/schedules.ts` | PORT | Parses and validates at/every/cron schedule definitions with a fixed-syntax regex (EVERY_PATTERN) and cron field count; fixed-format parsing, not a meaning guess. |
| `sdk/src/platform/automation/service.ts` | PORT | Persistence-facing AutomationService wrapping job/run/route/source stores; CRUD only. |
| `sdk/src/platform/automation/session-targets.ts` | PORT | AutomationSessionTarget and AutomationExecutionPolicy type definitions; no logic. |
| `sdk/src/platform/automation/sources.ts` | PORT | AutomationSourceRecord and snapshot type definitions; no logic. |
| `sdk/src/platform/automation/store/jobs.ts` | PORT | Persistent JSON store for automation jobs, load and save a version-1 snapshot through a write queue to keep concurrent saves ordered. |
| `sdk/src/platform/automation/store/paths.ts` | PORT | Resolves the on-disk directory and filename for automation store files from the control-plane config dir. |
| `sdk/src/platform/automation/store/routes.ts` | PORT | Persistent JSON store for automation route bindings, load and save a version-1 snapshot through a write queue to keep concurrent saves ordered. |
| `sdk/src/platform/automation/store/runs.ts` | PORT | Persistent JSON store for automation run records, load and save a version-1 snapshot through a write queue so a run's completed state cannot be overwritten by a stale concurrent write. |
| `sdk/src/platform/automation/store/sources.ts` | PORT | Persistent JSON store for automation source records, load and save a version-1 snapshot through a write queue to keep concurrent saves ordered. |
| `sdk/src/platform/automation/types.ts` | PORT | Shared automation literal-set and policy type definitions (job/run status, trigger, execution/delivery/failure policy shapes); no logic. |
| `sdk/src/platform/integrations/delivery.ts` | JEV | Integration delivery queue with retry/backoff and a dead-letter queue. classifyDeliveryError (the known case) decides from error text whether a delivery failure is retryable or terminal before the queue retries, cools down, or dead-letters it; the intent names this exactly as 'a JEV reading of failure transience before retry, cooldown or dead-letter' for automation. The HTTP-status-code lookup (deterministic) and the backoff-timing/DLQ-size arithmetic stay as code. |
| `sdk/src/platform/scheduler/index.ts` | PORT | Barrel re-export of scheduler.ts. |
| `sdk/src/platform/scheduler/scheduler.ts` | PORT | TaskScheduler: cron parsing and next-run computation, task CRUD, execution via a spawnTask callback, missed-run detection on startup, and bounded run history. On a failed spawn or a missed run it just records a failed history entry and waits for the next cron tick; there is no retry, cooldown or dead-letter logic today for the intent's JEV failure-transience reading to replace, that reading is new behavior to add on top when ported. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/integrations/delivery.ts:61` | classifyDeliveryError() (after the deterministic HTTP-status lookup at line 55) lower-cases the error message and checks it for 'timeout'/'aborted'/'econnrefused'/'enotfound'/'network' to call the failure retryable, and otherwise defaults any unrecognized error to retryable (line 76) | coarsen pattern: classify the error text into {retryable, terminal} with confidence, banded so a low-confidence read defaults to retryable (matching today's safe default), replacing the keyword list |

## batch

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/batch/index.ts` | PORT | Barrel file re-exporting DaemonBatchManager and the batch job types. |
| `sdk/src/platform/batch/manager.ts` | PORT | DaemonBatchManager queues, submits, polls and completes provider batch jobs (OpenAI and Anthropic batch APIs), with config driven mode, fallback and queue backend. |
| `sdk/src/platform/batch/types.ts` | PORT | Type definitions for daemon batch jobs, job statuses and the batch runtime snapshot. |

## browser, devices

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/browser/browser-driver-archive.ts` | PORT | The tar reader browser-driver provisioning uses. |
| `sdk/src/platform/browser/browser-driver-remediation.ts` | PORT | What to tell someone whose browser driver is not there, matched to how they actually installed the product they are running. |
| `sdk/src/platform/browser/browser-engine-contract.ts` | PORT | browser-engine-contract.ts, the engine's option/target types, its error, and the two pure helpers that neither read nor hold engine state. |
| `sdk/src/platform/browser/browser-engine.ts` | PORT | The browser capability itself: provisioning, sessions, and every page operation, with no Agent-surface types in sight. |
| `sdk/src/platform/browser/browser-host-client.ts` | PORT | Talks to the Node-hosted browser process. |
| `sdk/src/platform/browser/browser-provisioning.ts` | PORT | Manages one-act browser (Playwright/Chromium) provisioning: resolves an install runtime, downloads/verifies the browser binary, self-heals a stale cache directory, and reports a plain-language problem/fix pair on any failure. |
| `sdk/src/platform/browser/browser-provision-io.ts` | PORT | The concrete node-side half of provisioning. |
| `sdk/src/platform/browser/browser-secret-fill.ts` | PORT | Types payment secrets into a page as a batch with a pre-resolved snapshot and refuses to run without a card-field guard installed; also refuses a page capture while card material is live. Deterministic guard checks, not guesswork; word scan hit found nothing on inspection. |
| `sdk/src/platform/browser/browser-sessions.ts` | PORT | Manages live browser sessions: launch (with a saved profile), attach to an existing browser over CDP, reuse/close rules, and per-session page tracking. |
| `sdk/src/platform/browser/browser-snapshot.ts` | PORT | Snapshot-and-ref addressing. |
| `sdk/src/platform/browser/browser-types.ts` | PORT | Shared types for the browser engine: provisioning results, session info, element refs, the card-field guard, and the untrusted-content port used to gate outward effects from page content. Deterministic contract types, not guesswork; word scan hit found nothing on inspection. |
| `sdk/src/platform/browser/index.ts` | PORT | Browser automation as a platform capability. |
| `sdk/src/platform/devices/device-capability-contract.ts` | PORT | device-capability-contract.ts, the paired-device capability contract. |
| `sdk/src/platform/devices/device-capability-service.ts` | PORT | device-capability-service.ts, the one path a paired device's camera, screen, location, clipboard, or device command is reached through. |
| `sdk/src/platform/devices/device-capture-artifacts.ts` | PORT | Retention store for paired-device camera/screen captures: content-hash validation, TTL and count-cap sweep, orphan/mismatch reaping. ARTIFACT_KINDS is a fixed enum; no guesswork. |
| `sdk/src/platform/devices/device-grants.ts` | PORT | device-grants.ts, durable "always allow" grants for paired-device capabilities. |
| `sdk/src/platform/devices/device-housekeeping.ts` | PORT | device-housekeeping.ts, recovery-time and periodic garbage collection for everything the paired-device feature persists. |
| `sdk/src/platform/devices/device-peer-work.ts` | PORT | device-peer-work.ts, the wire shape of one device capability request. |
| `sdk/src/platform/devices/device-phone-tool.ts` | PORT | The 'phone' tool exposing a paired phone's camera/screen/location/clipboard/commands to the agent. normalizeAction (line 94) maps a model-supplied free-text action argument through a fixed table of synonym aliases (e.g. 'picture'/'camera'/'take_photo' all mean photo) onto a closed set of canonical actions, a dispatch-over-a-closed-set decision a Jev dispatch pattern could replace. Flagged for the coordinator since the devices subsystem is PORT in the intent table. |
| `sdk/src/platform/devices/device-policy-source.ts` | PORT | device-policy-source.ts, how the device stores and the capability service take their policy. |
| `sdk/src/platform/devices/device-posture-config.ts` | PORT | device-posture-config.ts, the mapping from the `device.*` settings to the policy structs the device stores and the capability service enforce. |
| `sdk/src/platform/devices/device-posture-runtime.ts` | PORT | device-posture-runtime.ts, one call that stands the paired-device feature up inside whichever process hosts the daemon. |
| `sdk/src/platform/devices/index.ts` | PORT | platform/devices, paired-device capabilities as agent tools. |
| `sdk/src/platform/runtime/client/phone-tool.ts` | PORT | Registers the client-side 'phone' tool that forwards paired-device capability requests (camera, screen, location, clipboard) to the daemon's device runtime and renders its outcome; a declined capability is reported as a successful refusal, not an error. |
| `sdk/src/platform/browser/browser-host.mjs` | PORT | Node script the browser host client spawns to drive the browser over a child process; loaded from disk by browser-host-client.ts. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/browser/browser-provisioning.ts:76` | missingLibraryFrom() regex-matches a verify/install probe's combined stdout+stderr for 'error while loading shared libraries'/'cannot open shared object file' to name the missing shared library | coarsen pattern: classify the probe output into a failure-kind label (missing-library vs other) with confidence; extract the library name in code once that label wins |
| `sdk/src/platform/browser/browser-provisioning.ts:178` | isNetworkFailure() regex-matches the install output text for ENOTFOUND/EAI_AGAIN/ECONNREFUSED/ECONNRESET/ETIMEDOUT/'socket hang up'/getaddrinfo/network/certificate/'unable to verify'/proxy/timeout wording to decide a failed download was caused by network conditions | coarsen pattern: classify the failed-install output as network-blocked vs other-failure with confidence, replacing the keyword list |
| `sdk/src/platform/browser/browser-sessions.ts:121` | describeLaunchFailure() regex-matches a browser launch error message against four known phrasings (ProcessSingleton/profile-in-use, missing X server/no display, missing shared library, else generic) to choose which owner-facing explanation and fix to show | coarsen pattern: classify the launch-failure text into {profile-in-use, no-display, missing-library, other} with confidence, then look up the fix message in code from the label |
| `sdk/src/platform/devices/device-phone-tool.ts:94` | normalizeAction maps a model-supplied free-text action argument through a fixed table of synonym aliases (e.g. 'picture'/'camera'/'take_photo' all mean photo; 'where'/'gps' mean location; 'paste' means clipboard_read) onto one of fourteen canonical actions | a dispatch pattern: route the model's requested action to one of the fourteen canonical phone actions |

## calendar

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/calendar/caldav-gateway-config.ts` | PORT | caldav-gateway-config.ts, where the daemon's CalDAV connection comes from, and how a logical calendar id becomes a collection URL. |
| `sdk/src/platform/calendar/caldav-gateway-service.ts` | PORT | caldav-gateway-service.ts, the CalDAV-backed implementation of the daemon's `calendar.*` verbs. |
| `sdk/src/platform/calendar/caldav-gateway-wire.ts` | PORT | caldav-gateway-wire.ts, the CalDAV requests the gateway verbs make, and the one place their failures become honest statuses. |
| `sdk/src/platform/calendar/caldav-ics-generate.ts` | PORT | caldav-ics-generate.ts, RFC 5545 (iCalendar) writing for the CalDAV backend. |
| `sdk/src/platform/calendar/caldav-ics.ts` | PORT | caldav-ics.ts, RFC 5545 (iCalendar) reading for the CalDAV calendar backend. |
| `sdk/src/platform/calendar/calendar-api-shared.ts` | PORT | calendar-api-shared.ts, the bearer-auth HTTP helper and honest degraded-state mapping shared by the Google Calendar and Microsoft Graph clients. |
| `sdk/src/platform/calendar/calendar-connector.ts` | PORT | calendar-connector.ts, the high-level connector the agent drives. |
| `sdk/src/platform/calendar/google-calendar-api.ts` | PORT | google-calendar-api.ts, the Google Calendar API v3 client over an access token and the injected HttpFetch. |
| `sdk/src/platform/calendar/http-fetch-adapter.ts` | PORT | http-fetch-adapter.ts, a pure adapter turning a standard WHATWG `fetch` into the connector's injected HttpFetch boundary. |
| `sdk/src/platform/calendar/ics-parser.ts` | PORT | ics-parser.ts, a pure, dependency-free iCalendar (RFC 5545) reader. |
| `sdk/src/platform/calendar/index.ts` | PORT | Re-exports ./calendar-api-shared.js, ./calendar-connector.js, ./google-calendar-api.js, ./http-fetch-adapter.js, ./ics-parser.js, ./merged-calendar-model.js. |
| `sdk/src/platform/calendar/merged-calendar-model.ts` | PORT | merged-calendar-model.ts, normalization of provider (Google Calendar API v3, Microsoft Graph) events into the ONE merged event model shared with A9's .ics path: A9's CalendarEvent shape plus a source label and the provid |
| `sdk/src/platform/calendar/microsoft-graph-api.ts` | PORT | microsoft-graph-api.ts, the Microsoft Graph client over an access token and the injected HttpFetch. |
| `sdk/src/platform/calendar/oauth-client-config.ts` | PORT | oauth-client-config.ts, reading the operator's own OAuth app credentials out of config, so a flow runs on what THEY registered. |
| `sdk/src/platform/calendar/oauth-flow.ts` | PORT | oauth-flow.ts, the OAuth 2.0 machinery for calendar connectivity: the authorization-code flow with a loopback redirect and mandatory PKCE (the standard native-app pattern, RFC 8252/7636), and the device-code flow (RFC 86 |
| `sdk/src/platform/calendar/oauth-providers.ts` | PORT | oauth-providers.ts, the fixed provider profiles for Google Calendar and Microsoft Outlook (Graph), plus client-config resolution. |
| `sdk/src/platform/calendar/oauth-token-store.ts` | PORT | oauth-token-store.ts, token persistence + honest lifecycle over the injected secret store. |
| `sdk/src/platform/calendar/oauth-types.ts` | PORT | oauth-types.ts, the shared type surface for the calendar OAuth + API connector layer (see CHANGELOG 1.0.0, A10). |
| `sdk/src/platform/calendar/rrule.ts` | PORT | rrule.ts, a pure RRULE reader for an honest, deliberately-bounded subset. |
| `sdk/src/platform/calendar/subscription-store.ts` | PORT | Store of external iCalendar feed subscriptions: validates and adds a feed by fetching it, refreshes on a cadence with conditional fetch, derives honest health (ok/stale/unreachable/parse-error) from fixed time thresholds, and records untrusted ingest only on explicit reads. Thresholds are fixed constants, not guesswork. |
| `sdk/src/platform/calendar/types.ts` | PORT | types.ts, the shared type surface for the calendar-connectivity module. |
| `sdk/src/platform/calendar/untrusted-events.ts` | PORT | untrusted-events.ts, externally-sourced calendar event content is untrusted content, with the same shape mail already uses. |

## channels, adapters, channel profiles, channel sync

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/adapters/bluebubbles/index.ts` | PORT | BlueBubbles webhook adapter; parses fixed webhook fields and maps chat-guid/isGroup to a conversation kind by deterministic rule. |
| `sdk/src/platform/adapters/discord/index.ts` | PORT | Discord webhook, interaction and gateway-dispatch adapter; deterministic payload parsing and dispatch by fixed Discord event/interaction type. |
| `sdk/src/platform/adapters/github/index.ts` | PORT | GitHub automation webhook adapter; deterministic JSON parsing and event dispatch. |
| `sdk/src/platform/adapters/google-chat/index.ts` | PORT | Google Chat webhook adapter; deterministic payload field extraction. |
| `sdk/src/platform/adapters/helpers.ts` | PORT | Shared webhook helpers: constant-time string compare, bearer/header token read, JSON body parse, HMAC-SHA256 signature verify; all deterministic security/parsing utilities. |
| `sdk/src/platform/adapters/homeassistant/index.ts` | PORT | Home Assistant webhook adapter; secret-based auth check and deterministic conversation-kind mapping from fixed mode/thread/channel fields. |
| `sdk/src/platform/adapters/imessage/index.ts` | PORT | iMessage (BlueBubbles-relay) webhook adapter; deterministic payload field extraction. |
| `sdk/src/platform/adapters/inbound-dedup.ts` | PORT | TTL-based inbound message dedup cache keyed by surface/scope/messageId; exact-key matching, not similarity. |
| `sdk/src/platform/adapters/index.ts` | PORT | Barrel export for the adapters package; no logic. |
| `sdk/src/platform/adapters/matrix/index.ts` | PORT | Matrix webhook adapter; deterministic payload and thread-id field extraction. |
| `sdk/src/platform/adapters/mattermost/index.ts` | PORT | Mattermost webhook adapter; deterministic payload field extraction. |
| `sdk/src/platform/adapters/msteams/index.ts` | PORT | MS Teams webhook adapter; stripTeamsMarkup does fixed markup-tag stripping and conversation-kind mapping is a deterministic switch over the conversationType field, not a meaning guess. |
| `sdk/src/platform/adapters/ntfy/index.ts` | PORT | ntfy webhook adapter handling chat, remote-chat and agent-task payload kinds; dispatch is by fixed topic/payload-shape rules. |
| `sdk/src/platform/adapters/signal/index.ts` | PORT | Signal webhook adapter; deterministic payload field extraction. |
| `sdk/src/platform/adapters/slack/index.ts` | PORT | Slack webhook and interactive-payload adapter; deterministic signature verification and payload dispatch. |
| `sdk/src/platform/adapters/surface-credential.ts` | PORT | Resolves a surface's credential from config/service-registry/secret sources in priority order; deterministic lookup and fallback chain, not a meaning guess. |
| `sdk/src/platform/adapters/telegram/commands.ts` | PORT | Parses Telegram bot commands (/start, /help, /stop) with a fixed-syntax regex; a closed command grammar, not a natural-language guess. |
| `sdk/src/platform/adapters/telegram/index.ts` | PORT | Telegram update webhook adapter; deterministic payload extraction and conversation-kind mapping from the fixed chatType field. |
| `sdk/src/platform/adapters/telephony/index.ts` | PORT | Telephony (Twilio) webhook adapter; HMAC/signature verification and fixed form-body parsing, both deterministic. |
| `sdk/src/platform/adapters/types.ts` | PORT | Shared adapter context and payload type definitions; no logic. |
| `sdk/src/platform/adapters/webhook/index.ts` | PORT | Generic outbound webhook surface adapter; deterministic JSON parsing and signing. |
| `sdk/src/platform/adapters/whatsapp/index.ts` | PORT | WhatsApp webhook adapter; deterministic payload field extraction. |
| `sdk/src/platform/channel-profiles/index.ts` | PORT | channel-profiles/, per-channel profile bindings for channel intake. |
| `sdk/src/platform/channel-profiles/install-inbound-intake.ts` | PORT | channel-profiles/install-inbound-intake.ts Wires the inbound-intake enrichment substrate (buildInboundIntakeEnrichment) into the live session origination path WITHOUT every channel adapter having to call it by hand. |
| `sdk/src/platform/channel-profiles/intake.ts` | PORT | Bridges an inbound message to a session: resolves the sender to a named principal by exact identity lookup (falling back to the channel's own owner allowlist), resolves the channel's bound profile (model, provider, permission mode), and merges both into session metadata and spawn overrides without overriding caller-set values. Identity resolution and allowlist membership are exact lookups, not guesswork. |
| `sdk/src/platform/channel-profiles/registry.ts` | PORT | channel-profiles/registry.ts The channel→profile binding registry: CRUD over the bindings plus the one operation intake depends on, resolve(surfaceKind, channelId?), which returns the MOST SPECIFIC binding for an inbound |
| `sdk/src/platform/channel-profiles/store.ts` | PORT | channel-profiles/store.ts Durable JSON-snapshot persistence for channel profile bindings, following the same PersistentStore snapshot pattern the automation and principal stores use. |
| `sdk/src/platform/channel-profiles/types.ts` | PORT | channel-profiles/types.ts The per-channel profile binding model. |
| `sdk/src/platform/channels/builtin/account-actions.ts` | PORT | Authorizes an actor action against a built-in channel account by exact id/kind match, and runs named provider-API operations (runtime_status etc.) for Discord/ntfy/Slack. Operation and action ids are exact literal matches against a closed set, not guesswork. |
| `sdk/src/platform/channels/builtin/accounts.ts` | PORT | Builds the account record (configured state, credentials, actions) for a built-in channel surface from config, secrets and the service registry. |
| `sdk/src/platform/channels/builtin/contracts.ts` | PORT | Assembles the ChannelPlugin contract hooks (build account, resolve account, resolve target, observe runtime) for a built-in surface from the shared context. |
| `sdk/src/platform/channels/builtin/descriptors.ts` | PORT | Lists capability descriptors (ingress, tools, operator actions) for a built-in surface by checking membership in the surface's fixed raw capability list. |
| `sdk/src/platform/channels/builtin/directory-bindings.ts` | PORT | Builds channel directory entries from existing route bindings for conversations a surface has already exchanged messages with. |
| `sdk/src/platform/channels/builtin/health.ts` | PORT | Reports liveness for each built-in surface by its actual receive mechanism: Telegram's supervisor state, the provider runtime manager's connection state for Slack/Discord/ntfy, and an honest 'unknown' for webhook-only surfaces nothing here can observe. |
| `sdk/src/platform/channels/builtin/homeassistant.ts` | PORT | Home Assistant channel integration: client creation, webhook constants, listing and substring-filtering entity states, and the tool/operator action descriptors exposed to a session. The state query is a literal substring filter over id/state/attributes, not a meaning judgment. |
| `sdk/src/platform/channels/builtin/parsing.ts` | PORT | Type-guard readers that validate a raw input value against a fixed enum (lifecycle action, conversation kind, directory scope, secret scope) or coerce a string/string-list, returning null on no match. |
| `sdk/src/platform/channels/builtin/plugins.ts` | PORT | Registers the built-in ChannelPlugin for each surface, wiring its webhook handler, account builder, status snapshot and directory/tool descriptors into the plugin registry. |
| `sdk/src/platform/channels/builtin/presentation.ts` | PORT | Fixed per-surface render policy (reasoning visibility, format, thread support, chunk size limits) and the display label for each built-in surface, both plain switch statements over the closed surface enum. |
| `sdk/src/platform/channels/builtin/rendering.ts` | PORT | Renders a channel event for a built-in surface by delivering through the delivery router, resolving the route binding and running any tool calls the render requests. |
| `sdk/src/platform/channels/builtin-runtime.ts` | PORT | Composes the built-in channel runtime (accounts, health, plugins, rendering, targets, setup schema) into the single ChannelPlugin surface each built-in channel exposes. |
| `sdk/src/platform/channels/builtin/setup-schema.ts` | PORT | Returns the fixed setup-wizard schema (fields, secret targets, external steps) for each built-in surface, a switch statement over the closed surface enum. |
| `sdk/src/platform/channels/builtin/shared.ts` | PORT | Shared types and the dependency bag (config manager, secrets, service registry, policy manager, plugin registry, provider runtime manager, route manager, inbound mail supervisor) that every built-in channel module is composed from. |
| `sdk/src/platform/channels/builtin/surfaces.ts` | PORT | Maps a channel surface to its provider-runtime counterpart, checks managed-surface membership, and resolves bot tokens through a fixed fallback chain (service registry, then config secret, then environment variable). |
| `sdk/src/platform/channels/builtin/targets.ts` | PORT | Parses and resolves conversation target strings into a typed target (direct, channel, group, thread, service) using a fixed set of recognized prefixes (@, #, direct:, thread:, a URL scheme), and searches the surface directory by literal substring match. The prefix grammar is a fixed internal format, not natural-language interpretation. |
| `sdk/src/platform/channels/completion-report-prose.ts` | PORT | Strips an agent's prose completion-report boilerplate down to its summary/result before a reply reaches a channel. Decides whether text IS such a report by matching a fixed set of heading words and requiring at least two distinct ones plus a summary or result heading; this heading-count classification is guesswork worth flagging to the coordinator even though the intent keeps channels as PORT. |
| `sdk/src/platform/channels/delivery-router.ts` | PORT | Central router that picks and runs the per-surface delivery strategy (Slack, Discord, Telegram, webhook, bridge and enterprise surfaces) to actually send a reply. |
| `sdk/src/platform/channels/delivery/shared.ts` | PORT | Shared helpers for delivery strategies: resolving the delivery surface kind for a target, fetching with a timeout, reading a JSON or text response body, extracting a provider response id from a few known field shapes. |
| `sdk/src/platform/channels/delivery/strategies-agent.ts` | PORT | Delivery strategy that lands a message inside the agent's own conversation by calling back into a landing function the agent product registers, since the SDK cannot reach into that process itself. |
| `sdk/src/platform/channels/delivery/strategies-bridge.ts` | PORT | Delivery strategies for bridge-style surfaces (Signal, WhatsApp, iMessage, BlueBubbles, telephony) that post through a local bridge process's HTTP API. |
| `sdk/src/platform/channels/delivery/strategies-core.ts` | PORT | Delivery strategies for the core built-in surfaces (Discord, Slack, Telegram, ntfy, Home Assistant, generic webhook, the web control plane) that send directly through each provider's API or a validated webhook URL. |
| `sdk/src/platform/channels/delivery/strategies-enterprise.ts` | PORT | Delivery strategies for enterprise surfaces (Microsoft Teams, Mattermost), building the provider-specific conversation and thread addressing and posting through their APIs. |
| `sdk/src/platform/channels/delivery/types.ts` | PORT | Shared types for a channel delivery request, target, result and the per-surface delivery strategy contract. |
| `sdk/src/platform/channels/health.ts` | PORT | One rule turning an observed runtime state into a channel health state: configured is never health, and an unobservable surface reports honestly unknown rather than a default healthy. |
| `sdk/src/platform/channels/health-watcher.ts` | PORT | Sweeps the surface registry for health-state transitions and announces channel death and recovery to the owner on a different channel than the one that died, repeating on an interval while still down. |
| `sdk/src/platform/channels/index.ts` | PORT | Barrel file re-exporting the channel package's public types and entry points. |
| `sdk/src/platform/channels/ingress-alarm.ts` | PORT | Raises a loud, rate-limited owner alert when inbound processing on a channel fails and the poison update is skipped past, routed through the existing health-degraded mechanism rather than a parallel one. |
| `sdk/src/platform/channels/plugin-registry.ts` | PORT | Registry of ChannelPlugin implementations per surface; resolves a conversation target by trying a plugin's own resolver, then explicit-target parsing, then an exact directory lookup, and dispatches accounts, capabilities, rendering and lifecycle actions to the right plugin. Target resolution is exact id/kind lookups, not guesswork. |
| `sdk/src/platform/channels/policy-manager.ts` | PORT | Per-surface and per-group ingress policy store: mention requirements, DM/group/thread allow switches, and allowlists, evaluated by exact id and exact command-word matching against configured lists, with a debounced audit log. |
| `sdk/src/platform/channels/provider-runtime.ts` | PORT | Manages the long-lived provider connections (Slack socket mode, Discord gateway, ntfy subscription) for managed surfaces: connect, reconnect, status and dispatch of incoming payloads to the adapter layer. |
| `sdk/src/platform/channels/render-audience.ts` | PORT | Fixed lookup deciding which render-event kinds are owner-facing versus operator-only telemetry, deny-by-default for any new or unstamped kind so a diagnostic cannot leak to the owner by omission. |
| `sdk/src/platform/channels/reply-delta.ts` | PORT | Tracks which render events have already been delivered by event id (a bounded set), so a progress update sends only what is new. |
| `sdk/src/platform/channels/reply-pipeline.ts` | PORT | Turns a runtime event stream into buffered, rate-limited channel reply deliveries: batches undelivered events, renders them through reply-render, and sends through the route binding on a progress interval plus a final flush. |
| `sdk/src/platform/channels/reply-policy.ts` | PORT | Fixed default render policy table (max chars, threading, reasoning visibility) per built-in surface, overridable by a plugin's own policy. |
| `sdk/src/platform/channels/reply-render.ts` | PORT | Renders runtime events into the text body sent to a channel: applies the audience gate, the reasoning-visibility policy, workstream labels, strips prose completion reports, and formats the in-progress status line. |
| `sdk/src/platform/channels/route-manager.ts` | PORT | Manages route bindings (which external conversation an automation or reply targets), backed by the automation route store and the runtime store's domain dispatch, emitting binding lifecycle events. |
| `sdk/src/platform/channels/surface-registry.ts` | PORT | Registry of known surfaces (web bindings, feature-gated availability) backed by the runtime store, feeding the plugin registry which surfaces are active. |
| `sdk/src/platform/channels/telegram/api.ts` | PORT | Thin client for the slice of the Telegram Bot API the daemon calls (getUpdates, webhook management, sendMessage), surfacing the HTTP error code on every failure so callers can branch on it. |
| `sdk/src/platform/channels/telegram/conflict-policy.ts` | PORT | Pure decision of what a Telegram 409 conflict means (a registered webhook versus a competing consumer of the same bot token) and what the poller should do about it, escalating to an owner-visible message after a fixed retry count. getWebhookInfo evidence is the stated authority, but the function still runs a regex, /webhook/i.test(description), over Telegram's freeform error description as a corroborating signal when no webhook is proven; that remains a guess at what freeform text means, worth the coordinator's attention even though channels stays PORT. |
| `sdk/src/platform/channels/telegram/ingress.ts` | PORT | Supervises Telegram inbound delivery: runs the poll loop or webhook registration per the configured mode, persists the getUpdates offset, classifies poll failures (409 via conflict-policy, 401 as a terminal revoked-token reason by HTTP status) and reports honest ingress status. The 401 terminal check is a deterministic status-code check; the 409 path delegates to conflict-policy.ts's description regex, noted there. |
| `sdk/src/platform/channels/telegram/offset-store.ts` | PORT | Persists the Telegram getUpdates offset across restarts as a bounded, content-validated single-record file, refusing to load anything oversized or malformed rather than guessing a resume point. |
| `sdk/src/platform/channels/types.ts` | PORT | Shared type contracts for the channels package: surfaces, capabilities, directory entries, target resolution, policy records, render events and status snapshots. |
| `sdk/src/platform/channels/workstream-labels.ts` | PORT | Derives a human-readable, non-identifying label for a workstream from its task text (first clause, character-capped) and disambiguates concurrent workstreams that produce the same label by assigned place-in-words. Mechanical truncation, not a meaning judgment. |
| `sdk/src/platform/channel-sync/index.ts` | PORT | platform/channel-sync, the two channel tables a daemon mirrors so a surface draws the same screen on a second device. |
| `sdk/src/platform/channel-sync/registry.ts` | PORT | channel-sync/registry.ts, the routing table and the draft mirror. |
| `sdk/src/platform/channel-sync/store.ts` | PORT | channel-sync/store.ts Durable JSON-snapshot persistence for the two mirrored channel tables, following the same PersistentStore snapshot pattern the channel-profile, automation and principal stores use. |
| `sdk/src/platform/channel-sync/types.ts` | PORT | channel-sync/types.ts, the two tables a daemon mirrors on behalf of the surfaces that talk to channels. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/channels/completion-report-prose.ts:55` | findReportShape (line 115) decides whether a block of agent prose IS a boilerplate completion report by counting how many distinct known section headings (from the fixed REPORT_HEADINGS set) appear in it, requiring at least MIN_REPORT_HEADINGS (2) plus one of the ANSWER_HEADINGS (summary or result); text with only one matching heading is treated as an ordinary reply instead | a yes/no question over the message text: is this a filled-in completion-report template rather than a normal conversational reply |
| `sdk/src/platform/channels/telegram/conflict-policy.ts:96` | classifyTelegramConflict runs descriptionBlamesWebhook = /webhook/i.test(detail), a regex over Telegram's freeform 409 error description, as a corroborating signal for whether the conflict is webhook-related when getWebhookInfo has not proven a webhook either way | a yes/no question over the freeform description text: does Telegram's error description blame a webhook, used only as corroboration alongside the getWebhookInfo evidence |

## check-in

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/automation/checkin-execution.ts` | PORT | Records the terminal AutomationRun for a check-in job from whatever outcome the attached AutomationCheckinEvaluator returns. The worth-interrupting judgment itself (the intent's check-in battery) lives in the evaluator implementation, not in this file; this module only persists and emits the result. |
| `sdk/src/platform/checkin/briefing.ts` | JEV | Pure formatting: turns a CheckinStateSnapshot into a one-line summary and a compact prose briefing string handed to the judge. No decision of its own. |
| `sdk/src/platform/checkin/index.ts` | JEV | Barrel file re-exporting the check-in service, receipt store, briefing helpers, quiet-hours helpers and judge. |
| `sdk/src/platform/checkin/judge.ts` | JEV | The judgment seam: builds a free-text system prompt asking the current model whether anything warrants contacting the owner, then parses the reply text with a regex plus JSON.parse into {contact, reason, message}; on any parse failure it defaults to staying quiet. |
| `sdk/src/platform/checkin/quiet-hours.ts` | JEV | Deterministic parsing and evaluation of a fixed 'HH:MM-HH:MM' quiet-hours window, including the midnight-wrap case; a fixed-format parser, not a decision point. |
| `sdk/src/platform/checkin/receipts.ts` | JEV | PersistentStore-backed receipt log: appends a capped, ordered history of every check-in run outcome and lists it newest-first. |
| `sdk/src/platform/checkin/service.ts` | JEV | The orchestrating service: gates on enabled and quiet hours, assembles the briefing, calls the judge, delivers on a yes, and always writes a receipt; also syncs a kind:'checkin' automation job to the configured cadence. Delegates the actual judgment to CheckinJudge (judge.ts) rather than deciding anything itself. |
| `sdk/src/platform/checkin/state-reader.ts` | JEV | Builds the live CheckinStateSnapshot from injected session and run views; classifies a session as channel vs product surface by a hardcoded closed set of known product surface kinds (tui, web, webui, agent, companion-chat, companion-task), which is a deterministic membership check over structured data, not free-text guesswork. |
| `sdk/src/platform/checkin/types.ts` | JEV | Type definitions and config keys for the check-in feature: config shape, state snapshot, decision, receipt outcome, and the judge/deliverer/state-reader interfaces. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/checkin/judge.ts:20` | a hand-written system prompt telling the model to decide contact:boolean, reason and message freely and return one JSON object, with parseCheckinDecision (line 34) pulling the object out of the raw text via a regex match and JSON.parse, defaulting to a quiet decision on any parse failure | the check-in worth-interrupting battery: a noul (yes/no) reading over the assembled briefing, with act/confirm/escalate bands scaled to stakes and silence as the default outcome on an unclear or failed reading; the typed reading replaces both the free-text prompt and the ad hoc regex/JSON parse, and the short message to send (when the reading says yes) stays a plain code-composed string |

## client auth

| File | Disposition | Note |
|---|---|---|
| `sdk/src/client-auth/android-keystore-token-store.ts` | PORT | Token store for a React Native app on Android, backed by the Android Keystore through react-native-keychain (optional peer dependency). |
| `sdk/src/client-auth/auto-refresh-middleware.ts` | PORT | Transport middleware that retries a request once after an auto-refresh; control flow only, no meaning guesses. |
| `sdk/src/client-auth/auto-refresh.ts` | PORT | AutoRefreshCoordinator: tracks token expiry and refreshes it; is401Error checks a numeric status code, a deterministic check not a guess. |
| `sdk/src/client-auth/control-plane-auth-snapshot.ts` | PORT | Type definitions for the control-plane auth snapshot (mode, principal, scopes, roles); no logic. |
| `sdk/src/client-auth/expo-secure-token-store.ts` | PORT | Token store for an Expo app, backed by expo-secure-store (optional peer dependency). |
| `sdk/src/client-auth/index.ts` | PORT | Barrel export for the client-auth package; its exports for the dropped mobile token stores go away with them. |
| `sdk/src/client-auth/ios-keychain-token-store.ts` | PORT | Token store for a React Native app on iOS, backed by the iOS Keychain through react-native-keychain (optional peer dependency). |
| `sdk/src/client-auth/oauth-types.ts` | PORT | OAuth start-state and token-payload type definitions; no logic. |
| `sdk/src/client-auth/permission-resolver.ts` | PORT | PermissionResolver reads role/scope membership from the auth snapshot with exact-match set checks (hasRole, hasScope); deterministic membership tests, not guesses. |
| `sdk/src/client-auth/session-manager.ts` | PORT | SessionManager wraps operator login/current-auth calls and the token store; no decision logic. |
| `sdk/src/client-auth/token-store.ts` | PORT | Thin wrapper class over a GoodVibesTokenStore implementation; get/set/clear only. |
| `sdk/src/client-auth/types.ts` | PORT | Type definitions for the token store interfaces and login options; no logic. |

## cloudflare, integrations

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/cloudflare/client.ts` | PORT | Exports createCloudflareApiClient. |
| `sdk/src/platform/cloudflare/cloudflare-token-resolvers.ts` | PORT | Exports TokenResolverContext, resolveAccountId, resolveWorkerName, resolveApiToken, resolveOperatorToken, resolveWorkerClientToken, and more. |
| `sdk/src/platform/cloudflare/config.ts` | PORT | Exports readCloudflareConfig. |
| `sdk/src/platform/cloudflare/constants.ts` | PORT | Exports DEFAULT_WORKER_NAME, DEFAULT_QUEUE_NAME, DEFAULT_DLQ_NAME, DEFAULT_WORKER_CRON, DEFAULT_TUNNEL_NAME, DEFAULT_KV_NAMESPACE_NAME, and more. |
| `sdk/src/platform/cloudflare/discovery.ts` | PORT | Exports discoverZones, selectDiscoveredZone, resolveZone, tryDiscover. |
| `sdk/src/platform/cloudflare/hostnames.ts` | PORT | Exports normalizeProvisionHostnames. |
| `sdk/src/platform/cloudflare/index.ts` | PORT | Re-exports ./client.js, ./manager.js, ./types.js, ./worker-source.js. |
| `sdk/src/platform/cloudflare/manager.ts` | PORT | Exports CloudflareControlPlaneManager. |
| `sdk/src/platform/cloudflare/resources.ts` | PORT | Idempotent find-or-create provisioning for Cloudflare resources (queues, KV namespaces, R2 buckets, secrets store, tunnel, zero-trust access app, DNS records, queue consumers), matching existing resources by exact name/id and detecting a specific known Cloudflare error code string on create-race failures. |
| `sdk/src/platform/cloudflare/status.ts` | PORT | Exports BuildCloudflareStatusInput, buildCloudflareControlPlaneStatus. |
| `sdk/src/platform/cloudflare/types.ts` | PORT | Exports CloudflareProvisionStepStatus, CloudflareProvisionStep, CloudflareComponent, CloudflareComponentSelection, CloudflareControlPlaneConfig, CloudflareControlPlaneStatus, and more. |
| `sdk/src/platform/cloudflare/utils.ts` | PORT | Exports resolveComponents, buildTokenRequirements, selectPermissionGroups, resolvePermissionGroupIds, resolvePermissionGroups, buildTokenPolicies, and more. |
| `sdk/src/platform/cloudflare/worker-settings.ts` | PORT | Cloudflare Worker provisioning: uploads the worker script, resolves Durable Object class migrations, and configures the workers.dev subdomain and cron schedule. isDurableObjectAlreadyMigratedError() matches a specific documented Cloudflare API error code (10074) and two fixed phrase pairs; this is fixed-format API error-code detection, not ambiguous meaning, so it is not listed as a decision point. |
| `sdk/src/platform/cloudflare/worker-source.ts` | PORT | The literal JavaScript source of the Cloudflare Worker deployed to proxy batch requests to the daemon, including its own deterministic private/loopback-host IP range check before allowing a daemon URL. |
| `sdk/src/platform/integrations/discord.ts` | PORT | Discord gateway/bot client. DiscordGatewayIntent is the Discord API's own gateway-intents bitmask (which events to subscribe to), not a natural-language intent guess. |
| `sdk/src/platform/integrations/github.ts` | PORT | Converts a GitHub webhook event into an agent prompt. eventToPrompt dispatches on the webhook's own type/action fields, a closed set GitHub defines, which is deterministic. The one soft spot: the issue_comment case only acts when the comment body contains the literal substring '@bot' or '@goodvibes' (line 194), a minimal fixed-mention gate rather than a meaning classification; noted for the coordinator though it is weak. |
| `sdk/src/platform/integrations/homeassistant.ts` | PORT | Exports HomeAssistantStateRecord, HomeAssistantServiceRecord, HomeAssistantClientOptions, HomeAssistantGoodVibesEvent, HomeAssistantIntegration, normalizeHomeAssistantBaseUrl. |
| `sdk/src/platform/integrations/index.ts` | PORT | Re-exports ./delivery.js, ./discord.js, ./github.js, ./homeassistant.js, ./notifier.js, ./ntfy.js. |
| `sdk/src/platform/integrations/notifier.ts` | PORT | Notifier, unified notification dispatcher. |
| `sdk/src/platform/integrations/ntfy.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/integrations/slack.ts` | PORT | The socket closed on its own, not because `stop()` was called. |
| `sdk/src/platform/integrations/webhooks.ts` | PORT | WebhookNotifier, sends HTTP POST notifications to configured webhook URLs. |

## cluster

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/cluster/clock.ts` | PORT | The real wall/monotonic clock the election runs on, plus a deterministic fake clock used only by tests. |
| `sdk/src/platform/cluster/config-read.ts` | PORT | Reads the cluster.* config category out of the ConfigManager into resolved ClusterSettings, defaulting on any read failure. |
| `sdk/src/platform/cluster/config-replication-policy.ts` | PORT | Classifies which daemon-owned config paths and secrets may replicate across the group versus stay node-local, by a fixed domain and key allowlist plus a structural port check, fail-closed. |
| `sdk/src/platform/cluster/config-replication.ts` | PORT | The config replication service: the elected master issues revisions and snapshots, other nodes forward edits as proposals, secrets travel sealed per member. |
| `sdk/src/platform/cluster/config-replica.ts` | PORT | The replicated settings document type, with revision-and-origin based merge and tombstones for deletions, bounded and swept. |
| `sdk/src/platform/cluster/consumer-conflict-backoff.ts` | PORT | Computes a doubling backoff delay before re-contesting a surface after a provider reports another consumer already holds the credential. |
| `sdk/src/platform/cluster/coordinator.ts` | PORT | The single composition-root object a process wires up: registers inbound consumer gates per surface and starts/stops per-surface elections, or runs every gate ungated when clustering is off. |
| `sdk/src/platform/cluster/election-node.ts` | PORT | One node's socket, peer table and suspend watchdog; decodes inbound datagrams, records holdings, and routes each to its per-surface election. |
| `sdk/src/platform/cluster/election.ts` | PORT | The leader-election state machine for one inbound surface: probing, claiming, becoming master, yielding, and reconciling a split-brain, all by deterministic version/holdings/hash ranking. |
| `sdk/src/platform/cluster/group-admissions.ts` | PORT | The JOIN and REJOIN wire exchange: admits other machines per the membership rule, and requests this machine's own admission or return. |
| `sdk/src/platform/cluster/group-crypto.ts` | PORT | Pure cryptographic primitives for the group: join-key derivation, group id and key generation, identity and agreement key pairs, sealing and signing. |
| `sdk/src/platform/cluster/group-membership.ts` | PORT | The admission rule (decideAdmission) deciding whether a machine may join or rejoin, plus encoding and checking join-class and identity-class datagrams. |
| `sdk/src/platform/cluster/group-operations.ts` | PORT | The operator-facing group verbs (status, create, join, key, nodes, forget, rotate, leave, rename) returning structured results the CLI, TUI and web UI each render. |
| `sdk/src/platform/cluster/group-runtime.ts` | PORT | The live per-daemon group runtime: beacons, roster gossip, admissions wiring, scheduled and revocation key rotation, and config replication housekeeping. |
| `sdk/src/platform/cluster/group-settings.ts` | PORT | Resolves the cluster.* group-layer settings (key rotation hours, beacon and gossip intervals) from raw config, clamped rather than rejected. |
| `sdk/src/platform/cluster/group-state.ts` | PORT | The replicated membership document (members and tombstones) and its deterministic, generation-based merge of two copies after a partition heals. |
| `sdk/src/platform/cluster/group-store.ts` | PORT | Persistence for group key material in the encrypted secrets store and the public roster file on disk, both content-validated and bounded on load. |
| `sdk/src/platform/cluster/group-transport.ts` | PORT | Routes one shared socket between two tenants: wraps and unwraps per-surface election datagrams inside the signed group envelope, and hands group-owned message types (beacon, roster, rekey, config) to the group runtime. |
| `sdk/src/platform/cluster/holdings.ts` | PORT | Tracks which node currently holds, or can serve as a candidate for, each surface, derived purely from observed heartbeat and candidacy traffic. |
| `sdk/src/platform/cluster/identity.ts` | PORT | Reads this install's persisted node id file, or mints and writes a new one when it is missing or malformed. |
| `sdk/src/platform/cluster/index.ts` | PORT | The public export barrel for the cluster package. |
| `sdk/src/platform/cluster/memory-transport.ts` | PORT | An in-process stand-in for the multicast socket, used by tests and by any composition that wants to prove its wiring without a real socket. |
| `sdk/src/platform/cluster/protocol-envelope.ts` | PORT | The signed group envelope format shared by every datagram type, including the dual-generation acceptance window used during a key rotation cutover. |
| `sdk/src/platform/cluster/protocol.ts` | PORT | The original per-surface datagram encoding, decoding and optional HMAC signature check. |
| `sdk/src/platform/cluster/ranking.ts` | PORT | Deterministic total orderings (by version, then holdings count, then a stable per-surface hash) that decide which node should hold a surface and when a holder should voluntarily yield it. |
| `sdk/src/platform/cluster/settings.ts` | PORT | Resolves the base cluster.* settings (enabled, heartbeat/timeout seconds, port, multicast group, secret, peers) from raw config, clamped rather than rejected. |
| `sdk/src/platform/cluster/surface-id.ts` | PORT | Derives a stable digest identity for an inbound surface (Telegram bot, ntfy topic, inbox account) so the plaintext topic or bot id never travels on the wire. |
| `sdk/src/platform/cluster/surface-registry.ts` | PORT | Tracks which inbound surfaces this node can actually serve right now, based on registered working consumers, and starts/stops their gates in order. |
| `sdk/src/platform/cluster/timing.ts` | PORT | Derives every protocol timing interval proportionally from the few operator-facing settings, so shortening the timeouts shortens the whole protocol coherently. |
| `sdk/src/platform/cluster/types.ts` | PORT | The shared type and contract surface for LAN leader election: roles, messages, transport and clock interfaces, and status shapes. |
| `sdk/src/platform/cluster/udp-transport.ts` | PORT | The real UDP multicast transport, with loopback enabled for same-host coordination and an additive static-peer list as a fallback where multicast is unavailable. |

## companion, push, pairing, relay, remote access

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/companion/companion-chat-attachments.ts` | PORT | Resolves companion chat message attachments from the artifact store, and inlines small text or image attachments into the provider prompt by fixed mime-type and size checks. |
| `sdk/src/platform/companion/companion-chat-branching.ts` | PORT | The honest-lineage core for regenerating a response and editing-and-branching an earlier message: supersedes rather than deletes history. |
| `sdk/src/platform/companion/companion-chat-broker-bridge.ts` | PORT | The structural interface CompanionChatManager uses to register companion sessions into the shared SharedSessionBroker store. |
| `sdk/src/platform/companion/companion-chat-broker-sync.ts` | PORT | Chains and best-effort mirrors companion session register/close/delete operations into the shared session broker, one op at a time per session. |
| `sdk/src/platform/companion/companion-chat-gc.ts` | PORT | Pure GC-sweep policy for companion sessions: idle-close, in-memory eviction after a grace period, and persistent deletion only under an explicit finite retention window, all by fixed age thresholds. |
| `sdk/src/platform/companion/companion-chat-manager.ts` | PORT | The disk-backed manager for companion chat sessions: runs LLM turns, tool-call rounds, the pending-turn queue, cancel/steer, regenerate/edit, and the GC sweep. |
| `sdk/src/platform/companion/companion-chat-persistence.ts` | PORT | Disk-backed store for companion chat sessions: one JSON file per session, written atomically via tmp-file plus rename. |
| `sdk/src/platform/companion/companion-chat-rate-limiter.ts` | PORT | Token-bucket rate limiter enforcing a fixed per-client and per-session messages-per-minute count, with LRU-bounded bucket maps. |
| `sdk/src/platform/companion/companion-chat-routes.ts` | PORT | HTTP route handlers for the companion-app chat-mode API: sessions, messages, cancel, steer, regenerate, edit, and the SSE event stream. |
| `sdk/src/platform/companion/companion-chat-route-types.ts` | PORT | The context interface injected into companion chat route handlers (chat manager, JSON body parsers, SSE stream opener). |
| `sdk/src/platform/companion/companion-chat-turn-control.ts` | PORT | Turn-lifecycle control for companion chat: the per-turn abort scope, cancel finalization, and the pending-turn queue backing queued sends and the steer verb. |
| `sdk/src/platform/companion/companion-chat-turn-execution.ts` | PORT | The tool-exhaustion finalizer turn and tool-call execution helper used by the companion turn loop, running calls through the permission boundary. |
| `sdk/src/platform/companion/companion-chat-types.ts` | PORT | Types for companion-app chat-mode sessions, messages, HTTP I/O shapes and SSE turn event payloads. |
| `sdk/src/platform/companion/index.ts` | PORT | Public export barrel for the companion package. |
| `sdk/src/platform/pairing/companion-token.ts` | PORT | What was done with an operator-token file that could not be read. |
| `sdk/src/platform/pairing/connection-info.ts` | PORT | Format a human-readable connection block for stdout display in daemon standalone mode. |
| `sdk/src/platform/pairing/device-lines.ts` | PORT | device-lines.ts, the one rendering of a paired-device list. |
| `sdk/src/platform/pairing/handoff-mint.ts` | PORT | handoff-mint.ts, the one place a pairing producer mints a link. |
| `sdk/src/platform/pairing/index.ts` | PORT | Re-exports ./companion-token.js, ./connection-info.js, ./device-lines.js, ./handoff-mint.js, ./offer-copy.js, ./origin-posture.js. |
| `sdk/src/platform/pairing/offer-copy.ts` | PORT | offer-copy.ts, plain-language copy for the pairing offer set, the one honest LAN-posture line, and the labeled browser-capability list. |
| `sdk/src/platform/pairing/origin-posture.ts` | PORT | pairing/origin-posture.ts The honest TLS/capability posture of a web origin, served over the pairing contract so every surface renders the SAME truth instead of dead buttons: - Plain http on a PRIVATE-NETWORK origin (LAN |
| `sdk/src/platform/pairing/pairing-handoff.ts` | PORT | pairing/pairing-handoff.ts One pairing exchange, carrying an OFFER SET so a freshly-paired surface can complete several set-up steps in a single pass, each independently declinable: - notifications, register this device  |
| `sdk/src/platform/pairing/pairing-token-store.ts` | PORT | pairing/pairing-token-store.ts Per-pairing operator tokens: every device/browser that pairs mints its OWN named, individually-revocable token, instead of everyone sharing the one operator token. |
| `sdk/src/platform/pairing/qr-generator.ts` | PORT | QR Code generation using the vendored Nayuki QR Code generator (MIT license). |
| `sdk/src/platform/pairing/stable-host.ts` | PORT | stable-host.ts, a stable name for printed/QR pairing links. |
| `sdk/src/platform/pairing/vendor/qrcodegen.ts` | PORT | Exports QrCode, QrSegment, Ecc, Mode. |
| `sdk/src/platform/pairing/web-origin.ts` | PORT | web-origin.ts, the web-app origin a pairing deep link points at, and the one-time write of `web.publicBaseUrl` from the stable-name resolution. |
| `sdk/src/platform/push/delivery.ts` | PORT | push/delivery.ts The single place a push message is actually encrypted and sent. |
| `sdk/src/platform/push/encryption.ts` | PORT | push/encryption.ts Browser-push payload encryption, implemented with Node's built-in crypto (node:crypto), no third-party web-push dependency. |
| `sdk/src/platform/push/index.ts` | PORT | push/index.ts, the browser-push module barrel (VAPID custody, subscription store, RFC 8291 encryption, and the delivery path). |
| `sdk/src/platform/push/service.ts` | PORT | Web push subscription, delivery and escalation service: tracks blocked approvals and needs-input notices, and schedules follow-up pushes on fixed timers and thresholds. |
| `sdk/src/platform/push/subscription-housekeeping.ts` | PORT | push/subscription-housekeeping.ts, recovery-time and periodic garbage collection for the browser-push subscription store. |
| `sdk/src/platform/push/subscription-store.ts` | PORT | push/subscription-store.ts The on-disk record of which devices an operator has registered for browser push. |
| `sdk/src/platform/push/subscription-validation.ts` | PORT | push/subscription-validation.ts The ONE place a push subscription's endpoint and key material are judged well-formed. |
| `sdk/src/platform/push/types.ts` | PORT | push/types.ts Shared shapes for the browser-push subscription lifecycle and delivery path. |
| `sdk/src/platform/push/vapid-subject.ts` | PORT | push/vapid-subject.ts The VAPID `sub` contact, its fallback, its validity rule, and its wording. |
| `sdk/src/platform/push/vapid.ts` | PORT | push/vapid.ts VAPID (RFC 8292) key custody and request signing for browser push. |
| `sdk/src/platform/relay/daemon-wiring.ts` | PORT | Wrap a dispatch so mutating relay calls are gated by the WebAuthn step-up policy. |
| `sdk/src/platform/relay/index.ts` | PORT | Re-exports ./daemon-wiring.js, ./reachability.js, ./step-up-policy.js, ./step-up-service.js. |
| `sdk/src/platform/relay/reachability.ts` | PORT | Durable custody of the daemon's relay identity (adapter over SecretsManager). |
| `sdk/src/platform/relay/step-up-policy.ts` | PORT | Header carrying an opaque WebAuthn step-up assertion on a tunneled request. |
| `sdk/src/platform/relay/step-up-service.ts` | PORT | User-verification requirement for the ceremony. |
| `sdk/src/platform/relay/step-up-webauthn.ts` | PORT | A stored step-up credential: what the daemon persists per registered passkey. |
| `sdk/src/platform/remote-access/tailscale.ts` | PORT | remote-access/tailscale.ts Tailscale as the recommended path to https without the daemon ever minting a certificate (self-provisioned CAs are ruled out; `tailscale serve` terminates TLS with tailscale's own certificates, |
| `sdk/src/platform/runtime/remote/distributed-runtime-contract-schemas.ts` | PORT | JSON schema definitions for the distributed-runtime wire contract: peer kind/status, work priority/status, pairing and audit record shapes. |
| `sdk/src/platform/runtime/remote/distributed-runtime-store.ts` | PORT | Persistent store operations for the distributed runtime's peers, pending work, pair requests, and audit records, with normalize/sanitize helpers over structured records. |
| `sdk/src/platform/runtime/remote/reconnect.ts` | PORT | Reconnect engine driving the transport state machine (disconnected -> connected -> degraded -> reconnecting -> terminal_failure) with handshake tokens, epoch tracking, replay-from-offset, and idempotent command resubmission. |
| `sdk/src/platform/runtime/remote/types.ts` | PORT | Core types for the remote substrate: durable identity, handshake tokens, typed transport messages, and replay configuration. |

## config

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/config/api-keys.ts` | PORT | Resolves each provider's API key through a three-tier lookup, environment variable then SecretsManager then skip, using a fixed table of provider names to known env var names and alternate spellings. |
| `sdk/src/platform/config/atomic-write.ts` | PORT | The one write primitive every config store uses: write to a sibling temp file, fsync it, rename into place, fsync the parent directory. |
| `sdk/src/platform/config/config-file-watcher.ts` | PORT | Poll-based watcher over settings files using statSync baselines, and a reload-and-diff helper that notifies subscribers only for keys whose value actually changed. |
| `sdk/src/platform/config/config-ownership.ts` | PORT | Decides which runtime, daemon, client or user, owns a config key, by matching the key against fixed, explicitly declared prefix and key lists rather than guessing from free text. |
| `sdk/src/platform/config/connector-config-sections.ts` | PORT | Seeds default email, calendar and google config sections when absent; now mostly a no-op backstop since those sections are schema-registered. |
| `sdk/src/platform/config/control-plane-base-url.ts` | PORT | Derives the daemon's control-plane base URL from its actual host/port/TLS bind instead of storing a copy that can drift, and compares a stored or observed URL against the derived one. |
| `sdk/src/platform/config/credential-availability.ts` | PORT | Folds a credentials.get wire call's outcome into an honest available or unavailable status for a client reading credential status through an adopted external daemon, mapping a small set of known error codes to fixed reasons. |
| `sdk/src/platform/config/credential-scope-registry.ts` | PORT | Declares, for every credential this platform stores, whether the daemon needs it or it is surface-local, by an explicit exact-key or prefix table, plus provider credential names derived from the provider catalog. |
| `sdk/src/platform/config/credential-status.ts` | PORT | Wraps SecretsManager as a secret-free credential status provider for the daemon's credentials.get route, reporting configured and usable booleans for stored keys plus known provider env-var names. |
| `sdk/src/platform/config/daemon-config-migration-io.ts` | PORT | Disk primitives and the disclosure-marker shape for the one-time move of daemon-owned config keys into the daemon's own store. discloseValue redacts a disclosed value only when the key's last path segment matches a token/secret/password/passphrase/apikey/credential regex (SECRETISH_LEAF); flagging this per the brief's rule for PORT files, though it reads as a security redaction guard rather than a meaning judgment. |
| `sdk/src/platform/config/daemon-config-migration.ts` | PORT | Runs the one-time move of daemon-owned keys into the daemon's own settings file, picking the winning value on conflict by a fixed precedence, existing daemon value, then the primary surface, then alphabetical order, and disclosing every discarded value. |
| `sdk/src/platform/config/daemon-config-read.ts` | PORT | Routes a config read to the daemon's live snapshot or the local config manager depending on key ownership and daemon reachability, batching daemon-owned reads into one snapshot fetch. |
| `sdk/src/platform/config/daemon-config-route.ts` | PORT | Routes a config write to the daemon (discovering its endpoint and checking it answers) or to the local store, and defines the daemon-unreachable and daemon-rejected transport error types. |
| `sdk/src/platform/config/daemon-config-tier.ts` | PORT | Reads, writes and overlays the daemon-owned subset of keys inside the daemon's own settings file. |
| `sdk/src/platform/config/daemon-credential-migration.ts` | PORT | Migrates daemon-needed credentials out of surface-local secret stores into the daemon tier, using the credential-scope-registry's declared scopes to decide which stored keys are stranded. |
| `sdk/src/platform/config/daemon-secret-keys.ts` | PORT | Derives the daemon-owned secret-store key name for a given daemon-owned config path. |
| `sdk/src/platform/config/daemon-tier-paths.ts` | PORT | Resolves or creates the nested object slot inside the daemon tier for a daemon-owned config path. |
| `sdk/src/platform/config/goodvibes-home.ts` | PORT | Resolves the GoodVibes home directory and daemon home directory from environment variable overrides, and reports whether an override is active. |
| `sdk/src/platform/config/helper-model.ts` | PORT | Routes named internal helper tasks, cache strategy planning, compaction, intent classification and others, to a configured cheap helper model and tracks token usage; this module dispatches to whichever model is configured, it does not itself classify anything. |
| `sdk/src/platform/config/index.ts` | PORT | Small typed read helpers over ConfigManager: snapshot, configured model/provider id, auto-approve and danger-mode resolution, daemon-enabled and connected-host-dial resolution, working directory and system prompt. |
| `sdk/src/platform/config/manager-bootstrap.ts` | PORT | Builds the default config snapshot, sanitizes the config shape, validates that an owned path override is absolute, and coerces a raw settings value to match its schema type. |
| `sdk/src/platform/config/manager-category-io.ts` | PORT | Persists a config category patch or single-key removal to the raw settings file and marks daemon-owned keys as present or absent. |
| `sdk/src/platform/config/manager-ingestion.ts` | PORT | Runs raw settings JSON through the manager's load-time migrations and turns a parse failure into a typed ConfigError for the ingestion notice sink. |
| `sdk/src/platform/config/manager-key-source.ts` | PORT | Describes which tier, daemon, shared, project, global or default, a resolved config key's current value actually came from. |
| `sdk/src/platform/config/manager-migration-passes.ts` | PORT | The individual load-time migration passes the manager runs in sequence: danger/daemon alias, legacy settings, fleet max-size rename, control-plane base URL removal, daemon embed-in-process removal, daemon connected-host split, payments budget renames, occasions final-stretch removal. |
| `sdk/src/platform/config/manager.ts` | PORT | The central ConfigManager class: get/set/save/load/reset, tier resolution (global, shared, daemon, project), change subscriptions, file watching and category merges. |
| `sdk/src/platform/config/migrations.ts` | PORT | The individual config migration functions the manager runs at load: danger/daemon alias, legacy toggle-key renames, fleet size rename, control-plane URL removal, daemon embed removal, connected-host split, payments budget key renames, occasions key removal; each is a deterministic key rename or removal, not judged content. |
| `sdk/src/platform/config/money-value.ts` | PORT | Validates and parses a money amount against fixed regexes and a two-decimal-place cap; money arithmetic and fixed-format parsing, explicitly not judged per the intent. |
| `sdk/src/platform/config/oauth-local-listener.ts` | PORT | A local HTTP listener that waits for an OAuth redirect's authorization code and serves a fixed success/error page. |
| `sdk/src/platform/config/openai-codex-auth.ts` | PORT | OpenAI Codex OAuth constants and the login-start, code-exchange and token-refresh calls. |
| `sdk/src/platform/config/plaintext-credential-sweep.ts` | PORT | Finds a plaintext credential value still sitting in config, moves it into the secrets store, and replaces the config value with a reference. |
| `sdk/src/platform/config/profile-fallback.ts` | PORT | Resolves a config value from a named profile's default when the surface itself has not set the key. |
| `sdk/src/platform/config/read-versioned.ts` | PORT | Reads a versioned JSON file, runs registered per-version migrations up to the current version, and quarantines a file that does not parse or match a known version, plus a quarantine-reaping helper. |
| `sdk/src/platform/config/schema-domain-at-rest.ts` | PORT | Config schema and defaults for at-rest retention settings. |
| `sdk/src/platform/config/schema-domain-cluster.ts` | PORT | Config schema and defaults for LAN cluster settings: heartbeat, timeouts, port, multicast group, peers, key rotation. |
| `sdk/src/platform/config/schema-domain-connectors.ts` | PORT | Config schema and defaults for the email, calendar and google connector sections. |
| `sdk/src/platform/config/schema-domain-conversation-gate.ts` | PORT | Config schema and defaults for the conversation gate: mode, proposal TTL, max pending proposals, gated surfaces. |
| `sdk/src/platform/config/schema-domain-core.ts` | PORT | The large core config schema and defaults (model, provider, permissions and related settings), split into head and tail definition lists to stay under the file's line cap. |
| `sdk/src/platform/config/schema-domain-daemon-location.ts` | PORT | Config schema for daemon location and binding settings. |
| `sdk/src/platform/config/schema-domain-daemon-mailbox.ts` | PORT | Config schema and defaults for the daemon's mailbox settings. |
| `sdk/src/platform/config/schema-domain-device.ts` | PORT | Config schema and defaults for device capabilities, location, clipboard, capture, grants and paired nodes. |
| `sdk/src/platform/config/schema-domain-feature-controls.ts` | PORT | Config schema of individual feature-flag toggles. |
| `sdk/src/platform/config/schema-domain-features.ts` | PORT | Config schema and defaults for fetch sanitize mode and host lists, token audit, integration delivery, plugin policy, and agent guard settings (context window guard, turn caps). |
| `sdk/src/platform/config/schema-domain-fleet.ts` | PORT | Config schema and defaults for the fleet's maximum size. |
| `sdk/src/platform/config/schema-domain-hosted-sessions.ts` | PORT | Config schema for daemon-hosted sessions: detach policy, session limits, attachment TTL, inbound and own-turn routing toggles. |
| `sdk/src/platform/config/schema-domain-learning.ts` | PORT | Config schema for idle-time memory consolidation: interval, idle floor, merge/decay/proposal caps and confidence thresholds. |
| `sdk/src/platform/config/schema-domain-memory.ts` | PORT | Config schema for the MemoryGovernor: RSS budget, elevated/high/critical percent tiers, leak tripwire rate and hard limit percent. |
| `sdk/src/platform/config/schema-domain-occasions.ts` | PORT | Config schema for the proactive occasions feature: lead days, active hours, nudge channel, cadence and sweep interval. |
| `sdk/src/platform/config/schema-domain-owner-profile.ts` | PORT | Config schema for the owner profile: enable, autonomous writes, disclosure toggles, tier injection and reload throttle. |
| `sdk/src/platform/config/schema-domain-payments.ts` | PORT | Config schema for the payment capability: budgets, shipping tier, addresses, veto/approval windows and retailer allow lists. |
| `sdk/src/platform/config/schema-domain-power.ts` | PORT | Config schema for sleep ownership: keep-awake toggle, work-inhibit toggle and its max-minutes cap. |
| `sdk/src/platform/config/schema-domain-pricing.ts` | PORT | Config schema for user-set manual model prices keyed provider:model, validated against a fixed shape. |
| `sdk/src/platform/config/schema-domain-push.ts` | PORT | Config schema for browser push subscription custody: VAPID subject, per-principal warn threshold, failure threshold and sweep interval. |
| `sdk/src/platform/config/schema-domain-runtime.ts` | PORT | Config schema and defaults for runtime services: automation, control plane, web/http listeners, watchers, batch, cloudflare, relay and network settings. |
| `sdk/src/platform/config/schema-domain-surfaces.ts` | PORT | Config schema and defaults for every channel surface adapter (Slack, Discord, ntfy, webhook, Telegram, WhatsApp, telephony, iMessage, Teams, Matrix, etc). |
| `sdk/src/platform/config/schema-domain-triggers.ts` | PORT | Config schema for the trigger family: stream, condition and on-exit watcher supervision, backoff ladder, breaker strikes and retention bounds. |
| `sdk/src/platform/config/schema-domain-update.ts` | PORT | Config schema for daemon self-update: auto toggle, check interval, releases URL and rollback/alert thresholds. |
| `sdk/src/platform/config/schema-domain-voice-local.ts` | PORT | Config schema for local voice engines: STT and TTS engine, binary and model path settings, filled in by managed setup. |
| `sdk/src/platform/config/schema-domain-voice-wake.ts` | PORT | Config schema for wake-word detection: enablement, models, threshold, VAD, capture device and command, surfaces and restart supervision. |
| `sdk/src/platform/config/schema-shared.ts` | PORT | Shared ConfigSettingDefinition type plus range and port validator helpers used across every schema-domain file. |
| `sdk/src/platform/config/schema.ts` | PORT | Assembles DEFAULT_CONFIG and CONFIG_SCHEMA by importing and concatenating every schema-domain module's defaults and settings. |
| `sdk/src/platform/config/schema-types-connectors.ts` | PORT | Type definitions for the email, calendar and google connector config domains, plus their dot-path key union and value map. |
| `sdk/src/platform/config/schema-types-daemon.ts` | PORT | Type definitions for daemon-side service config: notifications, TTS, automation, watchers, OS service integration and the daemon process itself. |
| `sdk/src/platform/config/schema-types-network.ts` | PORT | Type definitions for listener and reachability config: control plane, HTTP listener, web surface, outbound TLS and the outbound relay. |
| `sdk/src/platform/config/schema-types-occasions.ts` | PORT | Type definitions for the occasions config domain: shape, dot-path key union and key-to-value map. |
| `sdk/src/platform/config/schema-types-owner-profile.ts` | PORT | Type definitions for the owner profile config domain: shape, dot-path key union and key-to-value map. |
| `sdk/src/platform/config/schema-types-payments.ts` | PORT | Type definitions for the payments config domain: budgets, windows, addresses and the full key-to-value map, deliberately excluding card material. |
| `sdk/src/platform/config/schema-types-permissions.ts` | PORT | Type definitions for the permission layer's config surface: permission mode, per-tool action matrix and background-agent mode. |
| `sdk/src/platform/config/schema-types-platform.ts` | PORT | Type definitions for platform-service config: batch mode, the Cloudflare edge estate, telemetry export and at-rest redaction and retention. |
| `sdk/src/platform/config/schema-types-surfaces.ts` | PORT | Type definitions for every channel-surface config interface and the aggregate SurfacesConfig, including the daemon's own mailbox and calendar. |
| `sdk/src/platform/config/schema-types.ts` | PORT | The root GoodVibesConfig interface and the full ConfigKey dot-path union, folding in every domain's key types. |
| `sdk/src/platform/config/schema-types-values.ts` | PORT | The ConfigKey to value-type conditional map consulted by ConfigManager.get and set. |
| `sdk/src/platform/config/secret-bearing-config-keys.ts` | PORT | Declared list of every config key whose value is credential material, plus a name-pattern backstop for undeclared keys; this is the deterministic security boundary and stays code. |
| `sdk/src/platform/config/secret-ref-refusal.ts` | PORT | Distinguishes a malformed secret reference from a literal secret by URI scheme shape, and refuses to use an unparseable reference as a credential. |
| `sdk/src/platform/config/secret-refs.ts` | PORT | Parses and resolves secret references (env, goodvibes store, file, exec, 1Password, Bitwarden, Bitwarden Secrets Manager) from a JSON object or one of several fixed URI schemes, then runs the matching provider CLI or reads the matching source. Parsing is against fixed, known reference formats, not natural-language guesswork. |
| `sdk/src/platform/config/secrets-keyfile.ts` | PORT | Keyfile lifecycle and envelope crypto for SecretsManager: exclusive generation, pre-write revalidation and key fingerprints. |
| `sdk/src/platform/config/secrets-migration-view.ts` | PORT | The one cross-surface view of secret stores, used only to migrate a credential left in another surface's silo. |
| `sdk/src/platform/config/secrets-store-paths.ts` | PORT | Resolves where a secret physically lives per scope (project, user, daemon) and medium (secure, plaintext), and the read/write order across tiers. |
| `sdk/src/platform/config/secrets.ts` | PORT | SecretsManager: hierarchy-aware secret resolution, encrypted and plaintext store read/write, and daemon-ownership-aware write routing. |
| `sdk/src/platform/config/service-registry.ts` | PORT | ServiceRegistry resolves named service credentials from services.json and builds the matching HTTP auth headers (bearer, basic, api-key, oauth). |
| `sdk/src/platform/config/settings-ingestion.ts` | PORT | Decides whether a settings value the reader cannot ingest is skipped (falls back to default) or refused (would open a safety gate), against a declared list of safety-gate key prefixes and schema validation. |
| `sdk/src/platform/config/settings-io.ts` | PORT | Raw settings-file read, dot-path write and delete, and frozen-default stripping for whole-config dumps. |
| `sdk/src/platform/config/settings-reader-floor.ts` | PORT | Records and checks the minimum reader version a settings file needs, via a version-number comparison, so an old reader refuses cleanly instead of failing on an unrecognized key. |
| `sdk/src/platform/config/shared-config-tier.ts` | PORT | The surface-root-independent config tier for keys that must resolve the same on every surface (voice and TTS settings), with its own read/write/reset helpers. |
| `sdk/src/platform/config/subscription-auth.ts` | PORT | Resolves a stored provider subscription access token and recovers an OpenAI subscription after a token rejection, branching only on HTTP status code ranges and expiry timestamps. |
| `sdk/src/platform/config/subscription-providers.ts` | PORT | Registry of built-in OAuth subscription providers (currently OpenAI Codex) and lookup of available providers from service config. |
| `sdk/src/platform/config/subscriptions.ts` | PORT | SubscriptionManager: OAuth login, token exchange, refresh and persistence for provider subscriptions in the shared settings tier. |
| `sdk/src/platform/config/tool-llm.ts` | PORT | Resolves the provider and model used for tool-internal LLM calls (semantic diff, auto-heal, commit messages) from config or the current registry selection, and runs a single chat call. |

## contract runner (Jev in place of WRFC)

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/agents/wrfc-chain-answer.ts` | JEV | The answer a person receives comes from the last worker agent, with review and commit outcome wording. |
| `sdk/src/platform/agents/wrfc-config.ts` | JEV | Settings: score threshold, fix attempts, auto-commit, commit scope, gates, heartbeat timeout, transport retry; become contract runner settings (score threshold and fix attempts become Jev band and nudge settings). |
| `sdk/src/platform/agents/wrfc-controller-test-support.ts` | JEV | Test construction seam; carried with the contract runner tests. |
| `sdk/src/platform/agents/wrfc-controller.ts` | JEV | Chain lifecycle carried into the contract runner: active-chain cap and queue, resume and zombie reaping after restart, agent-silence watchdog, bounded transport retry, cancel narration, usage and tool-call roll-up onto the owner, answer versus status separation, work-plan and execution-plan sync, scoped auto-commit from the edit ledger, compound deliverables with integration. |
| `sdk/src/platform/agents/wrfc-external-adapter.ts` | JEV | Seam for partner surfaces to dispatch, poll, cancel and read externally owned work. |
| `sdk/src/platform/agents/wrfc-gate-runtime.ts` | JEV | Runs the configured gate commands and emits gate results. |
| `sdk/src/platform/agents/wrfc-gates.ts` | JEV | Gate command runner: package scripts, skip detection, command execution with a 120 s timeout. |
| `sdk/src/platform/agents/wrfc-planned-fix.ts` | JEV | Helpers for the planned-fix path; becomes nudge handling (unmet constraints synthesized as findings). |
| `sdk/src/platform/agents/wrfc-plan-sync.ts` | JEV | Marks execution-plan items complete when an agent finishes. |
| `sdk/src/platform/agents/wrfc-prompt-addenda.ts` | JEV | Constraint enumeration, verification and preservation instructions for agents. |
| `sdk/src/platform/agents/wrfc-reporting.ts` | JEV | Claim verification on disk and git, completion report parsing and review briefs; the review prompt content informs the criteria Jev judges. |
| `sdk/src/platform/agents/wrfc-runtime-events.ts` | JEV | Workflow and orchestration event wrappers; become contract events. |
| `sdk/src/platform/agents/wrfc-types.ts` | JEV | Chain, subtask, owner decision and quality gate types; become contract-tree types. |
| `sdk/src/platform/agents/wrfc-workmap.ts` | JEV | Append-only JSONL journal of chain events per session. |
| `sdk/src/platform/core/wrfc-routing.ts` | JEV | Suggests starting a chain for work requests, honours an explicit no-delegation instruction, and detects when an authoritative chain was started. |
| `sdk/src/platform/orchestration/controller-compat.ts` | JEV | engineerReviewPhases (the standard phase template) and fromChainSpec (one task to a workstream spec). |
| `sdk/src/platform/orchestration/fix-workstream-runner.ts` | JEV | Runs a workstream cycle and reports a structured outcome (merged, cycle, orphaned, tasks-failed, timeout). |
| `sdk/src/platform/runtime/fleet/adapters/wrfc.ts` | PORT | Turns chains and subtasks into fleet view nodes (derived kill detection, cost roll-up with provenance, model descriptor, owner repricing, review summary with the acceptance checklist); becomes the contract-tree view. |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts` | JEV | Sub-agent batch-spawn policy: keeps review/test/verify roles from becoming separate root agents, preserves the authoritative user ask against narrowing, restores write and exec tools for implementation work, and decides independent fan-out or one owner. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/agents/wrfc-controller.ts:955` | a reviewer agent is spawned to review the work after the engineer finishes, then a fix loop | Jev judge pattern reads each acceptance criterion as the sub-agent works; real-time nudges replace the review and fix loops |
| `sdk/src/platform/agents/wrfc-controller.ts:1022` | pass decided from the reviewer score against a threshold | judge aggregate verdict (pass, fail, uncertain) with bands |
| `sdk/src/platform/agents/wrfc-reporting.ts:27` | extractScoreFromText: regexes read a review score out of reviewer prose | judge pattern (per-criterion yes/no, aggregate verdict); no prose score |
| `sdk/src/platform/agents/wrfc-reporting.ts:63` | extractPassedFromText: fail and pass words read from prose | judge pattern verdict |
| `sdk/src/platform/agents/wrfc-reporting.ts:76` | extractIssuesFromText: severity words read from prose lines | judge unmet criteria with a severity score per criterion |
| `sdk/src/platform/core/wrfc-routing.ts:4` | isWrfcWorkflowRequest: regexes read whether a message asks for chain work | intake intent-to-handler dispatch (converse, answer, contract work) |
| `sdk/src/platform/core/wrfc-routing.ts:39` | DELEGATION_PROHIBITION_PATTERNS: 11 regexes read whether the user forbade spawning or delegating | yes/no: does the user forbid delegating this work to sub-agents? |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:17` | ROLE_PREFIX_RE and ROLE_ACTION_RE read task prose as a review, test or verification role | choice: implement, review, test, verify, design only |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:23` | IMPLEMENTATION_ACTION_RE reads task prose as implementation work | same choice battery (implement vs design only vs review) |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:29` | NO_WRITE_RE reads a no-write or read-only instruction from prose | yes/no: does the ask forbid writing files? |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:None` | looksLikeScopeNarrowing decides a proposed child task narrows the authoritative ask | yes/no: does the proposed task drop or narrow anything the authoritative ask requires? |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:None` | PARALLEL_FANOUT_REQUEST_RE reads an explicit request for separate parallel agents | yes/no: does the user ask for separate agents in parallel or one per unit? |
| `sdk/src/platform/tools/agent/wrfc-batch-policy.ts:None` | FANOUT_SHAPE_CONSTRAINT_RE reads a constraint as depending on agent topology | yes/no per constraint: can it only be met by a particular number or arrangement of agents? |

## contracts

| File | Disposition | Note |
|---|---|---|
| `contracts/src/core-verbs.ts` | PORT | Canonical operator-method verb vocabulary (CORE_VERBS, BANNED_VERBS, EXEMPT_VERB_CATEGORIES) plus classifyVerb, a closed-set lookup over dotted method-id verb tails, not natural-language guesswork. |
| `contracts/src/generated/foundation-client-types.ts` | PORT | Generated TypeScript type maps for every operator method input, output and event payload plus peer endpoint input/output; pure type declarations, no runtime logic. |
| `contracts/src/generated/foundation-metadata.ts` | PORT | Generated constant object with product id, version and method/event counts. |
| `contracts/src/generated/mock-daemon-fixtures.ts` | PORT | Generated schema-valid sample response literal per cataloged operator method, used for Playwright and Home Assistant test fixtures. |
| `contracts/src/generated/operator-contract.ts` | PORT | Generated OPERATOR_CONTRACT manifest: the full operator method catalog (507 methods) with request/response JSON Schemas, auth and transport metadata. Pure data literal, no functions. |
| `contracts/src/generated/operator-method-ids.ts` | PORT | Generated flat list of every operator method id string plus the OperatorMethodId type. |
| `contracts/src/generated/peer-contract.ts` | PORT | Generated PEER_CONTRACT manifest: peer endpoint catalog with request/response JSON Schemas. Pure data literal, no functions. |
| `contracts/src/generated/peer-endpoint-ids.ts` | PORT | Generated flat list of the 6 peer endpoint ids plus the PeerEndpointId type. |
| `contracts/src/generated/runtime-event-domains.ts` | PORT | Generated list of runtime event domain names plus a closed-set membership check isRuntimeEventDomain. |
| `contracts/src/generated/webui-facade.ts` | PORT | Generated mechanical transport layer for the webui facade: REST route table and schema-valid input/output samples per operator method. Pure data literal, no functions. |
| `contracts/src/index.ts` | PORT | Contracts package entrypoint: re-exports the generated manifests, verb vocabulary and zod schemas, plus lookup helpers (getOperatorContract, isOperatorMethodId, etc). |
| `contracts/src/node.ts` | PORT | Resolves and validates the filesystem paths to the bundled operator/peer contract JSON artifacts for Node consumers. |
| `contracts/src/testing/conformance.ts` | PORT | Descriptor/handler drift gate: asserts every registered gateway method descriptor has an attached handler, shared across consuming front-ends. |
| `contracts/src/testing/index.ts` | PORT | Testing-kit barrel export combining the conformance gate and the mock-daemon fixture generator. |
| `contracts/src/testing/mock-daemon.ts` | PORT | Generates deterministic, schema-valid sample responses from a method's JSON Schema output shape, and a tiny in-memory mock daemon over them. |
| `contracts/src/typed-io-keys.ts` | PORT | Type-level key-manipulation helpers (NamedProps, OmitNamed, RequiredNamedKeys) that correctly Omit/require keys on open-envelope operator method input types. |
| `contracts/src/types.ts` | PORT | Shared TypeScript interfaces describing the operator and peer contract manifest shapes (JsonSchema, OperatorMethodContract, PeerContractManifest, etc). |
| `contracts/src/zod-schemas/accounts.ts` | PORT | Zod schema for the accounts.snapshot operator method response. |
| `contracts/src/zod-schemas/auth.ts` | PORT | Zod schemas for the control.auth.login and control.auth.current operator method responses. |
| `contracts/src/zod-schemas/events.ts` | PORT | Zod schemas for the SSE/WebSocket serialized runtime event envelope, plain and typed variants. |
| `contracts/src/zod-schemas/index.ts` | PORT | Barrel re-export of every zod-schemas module (auth, accounts, events, session, providers). |
| `contracts/src/zod-schemas/providers.ts` | PORT | Zod schemas for the model catalog and global model-selection HTTP API (list models, get/patch current model). |
| `contracts/src/zod-schemas/session.ts` | PORT | Zod schemas for the control.status and local_auth.status operator method responses. |
| `daemon-sdk/src/gateway-rest-routes.ts` | PORT | Maps REST paths to method IDs using regex built from fixed route patterns, not natural-language interpretation. |
| `contracts/src/zod-schemas/README.md` | PORT | Explains the hand-written zod schemas that sit beside the generated contract types. |

## control plane

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/control-plane/approval-broker-raise.ts` | JEV | Raises an approval ask through the shared broker as a free function, coalescing an identical in-flight ask onto the first record's pending decision. |
| `sdk/src/platform/control-plane/approval-broker.ts` | JEV | The shared approval broker: persists, claims, resolves, expires, sweeps and publishes approval records. The approve/deny decision itself is supplied already-made by the caller (a local prompt handler or a wire call), this file does not read free text. |
| `sdk/src/platform/control-plane/approval-hunk-apply.ts` | JEV | Deterministic per-hunk selection math for edit-tool approvals (filters request.args.edits to the selected indices), shared by every surface. |
| `sdk/src/platform/control-plane/client-compatibility.ts` | JEV | Compares a client's build against the daemon's published minimum-version floor by numeric segment comparison. |
| `sdk/src/platform/control-plane/control-plane-store-paths.ts` | JEV | The one path resolver every control-plane store file goes through, requiring an explicit surface segment so a store never writes to the unscoped orphan directory. |
| `sdk/src/platform/control-plane/conversation-message.ts` | JEV | Shared envelope types for conversation messages flowing through the control-plane gateway (message source tags, attachments, metadata). |
| `sdk/src/platform/control-plane/daemon-compatibility.ts` | JEV | Compares a daemon's reported version against a client's declared minimum floor, the reverse check of client-compatibility.ts. |
| `sdk/src/platform/control-plane/gateway-disabled-response.ts` | JEV | The actionable response body returned by the gateway's streaming endpoints when the controlPlane.gateway setting is turned off. |
| `sdk/src/platform/control-plane/gateway-scope-enforcement.ts` | JEV | Per-client scope and runtime-domain filters for the event fan-out, both fixed lookup tables (channel to required scope, event to domain tag), not a judged classification. |
| `sdk/src/platform/control-plane/gateway.ts` | JEV | The control-plane gateway: client registry, event publish and fan-out, SSE and WebSocket streams, and the replay ring buffer. |
| `sdk/src/platform/control-plane/gateway-utils.ts` | JEV | Shared gateway helpers: default runtime domains, session-scoped delivery, replay-window resolution from a Last-Event-ID, and client descriptor mapping. |
| `sdk/src/platform/control-plane/gateway-web-ui.ts` | JEV | Renders the control-plane gateway's built-in HTML/JS operator dashboard as a static Response. |
| `sdk/src/platform/control-plane/index.ts` | JEV | Public export barrel for the control-plane package. |
| `sdk/src/platform/control-plane/invoke-input-validation.ts` | JEV | Structural JSON-schema validation gate for gateway verb invocations: checks a call's params against the method catalog's fixed inputSchema shape, not a judged classification. |
| `sdk/src/platform/control-plane/media-contract-schemas.ts` | JEV | Fixed JSON schema definitions for the media, voice and multimodal operator contract requests and artifacts. |
| `sdk/src/platform/control-plane/method-catalog-acp.ts` | JEV | Method catalog descriptors for Agent Client Protocol methods: discovering installed third-party coding agents and spawning them as hosted daemon sessions. |
| `sdk/src/platform/control-plane/method-catalog-admin.ts` | JEV | Method catalog descriptors for administrative operator methods. |
| `sdk/src/platform/control-plane/method-catalog-browser.ts` | JEV | Method catalog descriptors for the browser automation methods, plus small schema-builder helpers for page result and page input shapes. |
| `sdk/src/platform/control-plane/method-catalog-calendar.ts` | JEV | Method catalog descriptors for calendar read and subscription methods. |
| `sdk/src/platform/control-plane/method-catalog-channel-profiles.ts` | JEV | Method catalog descriptors for channel profile binding methods. |
| `sdk/src/platform/control-plane/method-catalog-channels-test.ts` | JEV | Method catalog descriptors for channel test/diagnostic methods. |
| `sdk/src/platform/control-plane/method-catalog-channels.ts` | JEV | Method catalog descriptors for channel account, target, directory and lifecycle methods. |
| `sdk/src/platform/control-plane/method-catalog-checkin.ts` | JEV | Method catalog descriptors for proactive check-in methods. |
| `sdk/src/platform/control-plane/method-catalog-ci.ts` | JEV | Method catalog descriptors for CI watch methods. |
| `sdk/src/platform/control-plane/method-catalog-control-automation.ts` | JEV | Method catalog descriptors for automation job/route/run methods, plus a schema-builder helper for the automation schedule input shape. |
| `sdk/src/platform/control-plane/method-catalog-control-companion.ts` | JEV | Method catalog descriptors for the companion chat surface, plus a schema-builder helper for a companion chat message input shape. |
| `sdk/src/platform/control-plane/method-catalog-control-core.ts` | JEV | Method catalog descriptors for the core control verbs: tasks, approvals and related control-plane primitives. |
| `sdk/src/platform/control-plane/method-catalog-control-live-turn.ts` | JEV | Method catalog descriptors for live-turn control methods (steering an in-progress conversation turn). |
| `sdk/src/platform/control-plane/method-catalog-control.ts` | JEV | Aggregates the control-verb method catalogs (core, automation, companion, live-turn) into one exported list. |
| `sdk/src/platform/control-plane/method-catalog-cost.ts` | JEV | Method catalog descriptors for cost and usage-tracking methods. |
| `sdk/src/platform/control-plane/method-catalog-devices.ts` | JEV | Method catalog descriptors for paired-device methods. |
| `sdk/src/platform/control-plane/method-catalog-email.ts` | JEV | Method catalog descriptors for email methods. |
| `sdk/src/platform/control-plane/method-catalog-events.ts` | JEV | Method catalog descriptors for the runtime event-domain subscriptions exposed over the gateway. |
| `sdk/src/platform/control-plane/method-catalog-flags.ts` | JEV | Method catalog descriptors for feature-flag read/write methods. |
| `sdk/src/platform/control-plane/method-catalog-fleet.ts` | JEV | Method catalog descriptors for fleet and checkpoint methods. |
| `sdk/src/platform/control-plane/method-catalog-homegraph.ts` | JEV | Method catalog descriptors for Home Graph methods, plus schema-builder helpers for a Home Graph descriptor shape and a device-link request body. |
| `sdk/src/platform/control-plane/method-catalog-hosted-sessions.ts` | JEV | Method catalog descriptors for creating and managing daemon-hosted conversation sessions. |
| `sdk/src/platform/control-plane/method-catalog-knowledge.ts` | JEV | Method catalog descriptors for knowledge ingestion, query and projection methods. |
| `sdk/src/platform/control-plane/method-catalog-media.ts` | JEV | Method catalog descriptors for media generation and encoding methods. |
| `sdk/src/platform/control-plane/method-catalog-memory.ts` | JEV | Method catalog descriptors for memory record and projection methods. |
| `sdk/src/platform/control-plane/method-catalog-models.ts` | JEV | Method catalog descriptors for the model catalog and provider configuration methods. |
| `sdk/src/platform/control-plane/method-catalog-occasions.ts` | JEV | Method catalog descriptors for dated-occasion methods. |
| `sdk/src/platform/control-plane/method-catalog-owner-profile.ts` | JEV | Method catalog descriptors for the owner profile read/write methods. |
| `sdk/src/platform/control-plane/method-catalog-pairing.ts` | JEV | Method catalog descriptors for device pairing methods. |
| `sdk/src/platform/control-plane/method-catalog-payments.ts` | JEV | Method catalog descriptors for payment card and checkout methods. |
| `sdk/src/platform/control-plane/method-catalog-permission-rules.ts` | JEV | Method catalog descriptors for permission rule methods. |
| `sdk/src/platform/control-plane/method-catalog-power.ts` | JEV | Method catalog descriptors for sleep/power and keep-awake methods. |
| `sdk/src/platform/control-plane/method-catalog-principals.ts` | JEV | Method catalog descriptors for principal identity methods. |
| `sdk/src/platform/control-plane/method-catalog-push.ts` | JEV | Method catalog descriptors for browser push notification methods. |
| `sdk/src/platform/control-plane/method-catalog-relay.ts` | JEV | Method catalog descriptors for relay/remote-access methods. |
| `sdk/src/platform/control-plane/method-catalog-rewind.ts` | JEV | Method catalog descriptors for conversation rewind methods. |
| `sdk/src/platform/control-plane/method-catalog-route-reconcile.ts` | JEV | Deterministic self-check that reconciles every method descriptor's advertised HTTP binding against the real dispatch table, probing the route dispatcher with synthetic requests and flagging any descriptor advertised as live but unbacked by a route or handler. |
| `sdk/src/platform/control-plane/method-catalog-runtime-mcp.ts` | JEV | Method catalog descriptors for the runtime MCP client/session methods. |
| `sdk/src/platform/control-plane/method-catalog-runtime.ts` | JEV | Method catalog descriptors for runtime store, settings and provider-usage methods. |
| `sdk/src/platform/control-plane/method-catalog-shared.ts` | JEV | Shared types and schema-builder helpers (objectSchema, arraySchema, methodDescriptor and the primitive schema constants) every method-catalog file is built from. |
| `sdk/src/platform/control-plane/method-catalog-skills.ts` | JEV | Method catalog descriptors for skill document CRUD methods. |
| `sdk/src/platform/control-plane/method-catalog-stepup.ts` | JEV | Method catalog descriptors for step-up authorization methods. |
| `sdk/src/platform/control-plane/method-catalog-tailscale.ts` | JEV | Method catalog descriptors for Tailscale serve methods. |
| `sdk/src/platform/control-plane/method-catalog.ts` | JEV | Aggregates every method-catalog family into the single builtin method/event descriptor list and provides the small registry class (register/unregister) the gateway serves methods from. |
| `sdk/src/platform/control-plane/method-catalog-update.ts` | JEV | Method catalog descriptors for update-check methods. |
| `sdk/src/platform/control-plane/method-catalog-voice-setup.ts` | JEV | Method catalog descriptors for voice provisioning and wake-word setup methods; schema field names like 'classifier' refer to a wake-word model artifact file, not a text classification decision. |
| `sdk/src/platform/control-plane/method-catalog-workspaces.ts` | JEV | Method catalog descriptors for workspace methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-admin.ts` | JEV | Request/response JSON-schema definitions for admin, local-auth and config methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-approvals.ts` | JEV | Request/response JSON-schema definitions for approval record methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-channels.ts` | JEV | Request/response JSON-schema definitions for channel account, target and directory methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-channel-sync.ts` | JEV | Request/response JSON-schema definitions for channel sync/mirror methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-control.ts` | JEV | Request/response JSON-schema definitions for the core control verbs (tasks, auth, control frames). |
| `sdk/src/platform/control-plane/operator-contract-schemas-domains.ts` | JEV | Barrel file re-exporting the event-domain schema modules. |
| `sdk/src/platform/control-plane/operator-contract-schemas-flags.ts` | JEV | Request/response JSON-schema definitions for feature-flag methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-fleet.ts` | JEV | Request/response JSON-schema definitions for fleet and checkpoint methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-homegraph.ts` | JEV | Request/response JSON-schema definitions for Home Graph methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-knowledge-map.ts` | JEV | Request/response JSON-schema definitions for the knowledge map view. |
| `sdk/src/platform/control-plane/operator-contract-schemas-knowledge.ts` | JEV | Request/response JSON-schema definitions for knowledge ingestion, query and projection methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-media.ts` | JEV | Request/response JSON-schema definitions for media generation and encoding methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-memory-projection.ts` | JEV | Request/response JSON-schema definitions for the memory projection view. |
| `sdk/src/platform/control-plane/operator-contract-schemas-payments.ts` | JEV | Request/response JSON-schema definitions for payment card and checkout methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-permissions.ts` | JEV | Request/response JSON-schema definitions for permission rule methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-project-planning.ts` | JEV | Request/response JSON-schema definitions for project-planning methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-remote.ts` | JEV | Request/response JSON-schema definitions for remote-access methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-rewind.ts` | JEV | Request/response JSON-schema definitions for conversation rewind methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-runtime.ts` | JEV | Request/response JSON-schema definitions for runtime store, settings and provider-usage methods. |
| `sdk/src/platform/control-plane/operator-contract-schemas-shared.ts` | JEV | Shared schema-builder helpers (enumSchema, nullableSchema, recordSchema) re-exporting the method-catalog-shared primitives that every operator-contract-schemas file is built from. |
| `sdk/src/platform/control-plane/operator-contract-schemas-telemetry.ts` | JEV | Request/response JSON-schema definitions for telemetry methods, plus a small helper building a paginated telemetry-list response shape. |
| `sdk/src/platform/control-plane/operator-contract-schemas.ts` | JEV | Barrel file re-exporting every operator-contract-schemas module. |
| `sdk/src/platform/control-plane/operator-contract-schemas-workspaces.ts` | JEV | Request/response JSON-schema definitions for workspace methods. |
| `sdk/src/platform/control-plane/operator-contract.ts` | JEV | Assembles the versioned operator contract manifest (method catalog, event catalog, schema and event coverage stats, well-known paths) that the operator client, peer client and web UI are generated from. |
| `sdk/src/platform/control-plane/pre-split-control-plane-sweep.ts` | JEV | Boot-time migration that resolves the legacy unscoped control-plane state directory into the surface-scoped one: folds the old session store into the broker's store, adopts files with no scoped counterpart, and retires the rest, one fixed rule per file kind. |
| `sdk/src/platform/control-plane/routes/acp.ts` | JEV | Gateway handlers for acp.agents.list and acp.sessions.create: read-only discovery of installed third-party coding agents and the one-act spawn that hosts one as a daemon session. |
| `sdk/src/platform/control-plane/routes/api-router.ts` | JEV | One-line re-export of dispatchDaemonApiRoutes from the daemon-sdk package. |
| `sdk/src/platform/control-plane/routes/approvals-raise.ts` | JEV | Handler for approvals.raise, letting any surface (not just the in-process broker caller) create a pending approval record and optionally wait briefly for a decision. |
| `sdk/src/platform/control-plane/routes/attribution-ingest.ts` | JEV | Wires runtime-bus provider and turn events (LLM usage, metered voice usage, rate-limit headers, stream retries) into the cost-attribution ledger and quota-window tracker. |
| `sdk/src/platform/control-plane/routes/browser-composition.ts` | JEV | Builds the daemon's own browser engine and session manager on first use, plus the payments checkout page-driver seam and its untrusted-content ledger wiring. |
| `sdk/src/platform/control-plane/routes/browser.ts` | JEV | Thin verb handlers for browser.* gateway methods, mapping wire arguments onto a BrowserGatewayService and translating engine errors to honest wire statuses. |
| `sdk/src/platform/control-plane/routes/calendar-composition.ts` | JEV | Builds the daemon's calendar connection, choosing a configured CalDAV server over a connected Google account when both are present. |
| `sdk/src/platform/control-plane/routes/calendar.ts` | JEV | Thin verb handlers for calendar.events.* and calendar.ics.* over a CalendarGatewayService, enforcing confirm:true on writes. |
| `sdk/src/platform/control-plane/routes/channel-profiles.ts` | JEV | Thin verb handlers for channels.profiles.* over the ChannelProfileRegistry. |
| `sdk/src/platform/control-plane/routes/channel-sync.ts` | JEV | Thin verb handlers for channels.routing.* and channels.drafts.* over the ChannelSyncRegistry. |
| `sdk/src/platform/control-plane/routes/channel-test.ts` | JEV | Handler for channels.test.send, a live per-channel test-message probe over the daemon's delivery router. |
| `sdk/src/platform/control-plane/routes/checkin.ts` | JEV | Thin verb handlers for checkin.* (config get/set, receipts list, manual run) over the CheckinService. |
| `sdk/src/platform/control-plane/routes/checkpoint-restore-tokens.ts` | JEV | In-memory, single-use, short-lived confirmation token store backing the checkpoints restore and hunk-revert confirmation gates. |
| `sdk/src/platform/control-plane/routes/checkpoints.ts` | JEV | Handlers for checkpoints.* and sessions.changes.get over the WorkspaceCheckpointManager, including the confirm/token-gated restore, restore preview, and per-hunk revert flows. |
| `sdk/src/platform/control-plane/routes/ci.ts` | JEV | Thin verb handlers for ci.* over the CiWatchService, mapping CiWatchError to honest wire statuses. |
| `sdk/src/platform/control-plane/routes/ci-watch-composition.ts` | JEV | Builds the CI-watch verb group: the gh-CLI source, the watch store, the completion notifier, the fix-session offer routed through the approval broker, the starter, the auto-minter and the recurring poller. |
| `sdk/src/platform/control-plane/routes/cost.ts` | JEV | Handlers for cost.attribution.get, quota.fanout.get and quota.snapshot.get over the cost attribution service and the quota window tracker. |
| `sdk/src/platform/control-plane/routes/credentials-write.ts` | JEV | Handlers for credentials.set/.delete: writes a credential into the daemon secret store at the resolved scope, reads it back to verify, and leaves only a secret reference in config; never returns the value. |
| `sdk/src/platform/control-plane/routes/devices.ts` | JEV | Handlers for the paired-device verbs (node list, capability request, capture artifacts, grants, housekeeping) over the live device capability service; re-decides nothing the runtime already decided. |
| `sdk/src/platform/control-plane/routes/email-composition.ts` | JEV | Builds the daemon's own mailbox gateway over the platform EmailService, with error-to-status translation and operator-facing operational logging (digested addresses only). |
| `sdk/src/platform/control-plane/routes/email-expectations.ts` | JEV | Handlers for email.expectation.open/list/cancel: registers an inbound-mail expectation an already-authorized workstream may later satisfy. |
| `sdk/src/platform/control-plane/routes/email-inbound-status.ts` | JEV | Read-only handler for email.inbound.status, disclosing the inbound mail watcher's live snapshot. |
| `sdk/src/platform/control-plane/routes/email.ts` | JEV | Thin verb handlers for email.* over an EmailGatewayService; enforces confirm:true on send and refuses a send whose recipient, subject or body derives from previously-read untrusted content. |
| `sdk/src/platform/control-plane/routes/explicit-user-request.ts` | JEV | refuseNonUserRequest: refuses a write whose caller explicitly declared context.metadata.explicitUserRequest === false; absent or true proceeds. |
| `sdk/src/platform/control-plane/routes/flags-graduation.ts` | JEV | Handler for flags.graduation.report, building the feature-flag graduation report from the static flag registry plus any supplied divergence-evidence provider. |
| `sdk/src/platform/control-plane/routes/fleet.ts` | JEV | Handlers for fleet.snapshot/list/observed.steer/archive/attempts/conflicts/graph over the ProcessRegistry, including best-of-N held-merge pick/judge and merge-conflict resolution routing. |
| `sdk/src/platform/control-plane/routes/gateway-verb-error.ts` | JEV | GatewayVerbError, a structured error class (code, status, field) plus readGatewayVerbRefusal, a shape-based reader that recognizes a wire refusal thrown by any handler, not only ones built with this class. |
| `sdk/src/platform/control-plane/routes/hosted-sessions.ts` | JEV | Handlers for sessions.hosted.* over a HostedSessionVerbService, mapping each of the engine's four distinct refusal kinds to its own wire status. |
| `sdk/src/platform/control-plane/routes/index.ts` | JEV | Barrel re-export of dispatchDaemonApiRoutes from api-router.ts. |
| `sdk/src/platform/control-plane/routes/invocation-params.ts` | JEV | readInvocationParams: merges an invocation's query object (fallback) and body object (wins) into one params record for handler-registered verbs. |
| `sdk/src/platform/control-plane/routes/memory-projections.ts` | JEV | Handlers for memory.projections.list/get, a read-only live projection of standing memory records to their markdown form. |
| `sdk/src/platform/control-plane/routes/memory.ts` | JEV | Handler for ops.memory.get, a snapshot of the live MemoryGovernor. |
| `sdk/src/platform/control-plane/routes/occasions-composition.ts` | JEV | Builds the occasions service over the owner-profile store, wires nudge delivery through the channel delivery router, and arms the repeating sweep ticker. |
| `sdk/src/platform/control-plane/routes/occasions.ts` | JEV | Thin verb handlers for occasions.* over OccasionsService; validates enum-like fields (surface, answer, ack source, authority) against fixed closed sets, decides nothing about meaning itself. |
| `sdk/src/platform/control-plane/routes/owner-profile-composition.ts` | JEV | Builds the one owner-profile store, attaches the profile.* verb handlers, wires the config-fallback and open-tier consumers, and installs the occasions loop over the same store. |
| `sdk/src/platform/control-plane/routes/owner-profile-policy.ts` | JEV | Wraps the owner-profile gateway service so the owner's autonomousWrites/discloseWrites/discloseClosedTierReads switches actually govern reads and writes, read live per call. |
| `sdk/src/platform/control-plane/routes/owner-profile.ts` | JEV | Handlers for profile.* over OwnerProfileStore: field/person read, set/append/forget/undo writes, each requiring an explicit authority tier and running refuseNonUserRequest before the store's own trust gate. |
| `sdk/src/platform/control-plane/routes/pairing-handoff.ts` | JEV | Handlers for pairing.handoff.create/complete and pairing.posture.get: mints a per-device pairing token with an offer set (notifications, relay, passkey) and applies each offer's accept/decline in one pass. |
| `sdk/src/platform/control-plane/routes/pairing.ts` | JEV | Handlers for pairing.tokens.* over the PairingTokenManager (list, mint, migrate, rename, revoke, revoke-shared). |
| `sdk/src/platform/control-plane/routes/payments.ts` | JEV | Handlers for payments.* (budget status, card CRUD, checkout begin/fillCard, purchases list); shapes and sanitizes wire input/output only, every judgement about meaning (amounts, cart match, budget) is left to the service. |
| `sdk/src/platform/control-plane/routes/permission-rules.ts` | JEV | Handlers for permissions.rules.list/delete over the durable user-origin permission rule store; rules are read/deleted only, never minted through the wire. |
| `sdk/src/platform/control-plane/routes/power.ts` | JEV | Handlers for power.status.get and power.keepAwake.set over the live PowerManager. |
| `sdk/src/platform/control-plane/routes/principals.ts` | JEV | Handlers for principals.* over the PrincipalRegistry (list/get/create/update/delete/resolve), mapping PrincipalRegistryError to honest wire statuses. |
| `sdk/src/platform/control-plane/routes/push-composition.ts` | JEV | Builds the daemon's one PushService: VAPID key custody, the subscription store with housekeeping, and every delivery/escalation policy read live from config. |
| `sdk/src/platform/control-plane/routes/push.ts` | JEV | Handlers for push.* (vapid key, subscribe, reconcile, list, delete, verify), validating endpoint and key material by content and scoping every write to the authenticated principal. |
| `sdk/src/platform/control-plane/routes/register-fleet-checkpoints-search.ts` | JEV | Composite entry point that registers the fleet.*, checkpoints.* and sessions.search verb groups in one call. |
| `sdk/src/platform/control-plane/routes/register-gateway-verb-groups.ts` | JEV | The composition root that attaches every handler-registered gateway verb group (push, pairing, tailscale, acp, skills, principals, owner profile, channel profiles/sync, CI-watch, check-in, session-runtime, browser, calendar, email, cost, credentials, rewind, and more) to the catalog. |
| `sdk/src/platform/control-plane/routes/relay.ts` | JEV | Handlers for relay.reachability.get and relay.pairing.mint over an accessor to the relay controller; absence is reported as an honest 'disabled' status. |
| `sdk/src/platform/control-plane/routes/rewind-conversation-hosts.ts` | JEV | Handlers for rewind.conversation.host.* and rewind.conversation.requests.*, the surface side of conversation-scope rewind: a session-hosting surface offers its live conversation and answers the daemon's bounded questions. |
| `sdk/src/platform/control-plane/routes/rewind.ts` | JEV | Handlers for rewind.plan and rewind.apply over the UnifiedRewindService, following the checkpoints.restore confirm/token idiom. |
| `sdk/src/platform/control-plane/routes/runtime-metrics.ts` | JEV | Handler for runtime.metrics.get, a snapshot of the process-wide RuntimeMeter and per-model tool-format telemetry. |
| `sdk/src/platform/control-plane/routes/seeded-sessions.ts` | JEV | The one seeded-session recipe (an at-now, delete-after-run automation job pinned to a fresh session) and its two producers, the CI fix session and the merge-conflict resolution session. |
| `sdk/src/platform/control-plane/routes/session-runtime.ts` | JEV | Handlers for the session-scoped permission-mode get/set, context-usage read, tool-call cancel and queued-message verbs over the live local runtime only; any other session id is an honest 404. |
| `sdk/src/platform/control-plane/routes/session-search.ts` | JEV | Handler for sessions.search: an in-memory filtered/sorted/paginated query over the SharedSessionBroker's session list, with a lowercase substring match on id+title for the free-text query field. |
| `sdk/src/platform/control-plane/routes/skills.ts` | JEV | Handlers for skills.* over the SkillService (list/get/create/update/delete), mapping SkillServiceError to honest wire statuses. |
| `sdk/src/platform/control-plane/routes/stepup.ts` | JEV | Handlers for stepup.credentials.register and stepup.challenge.mint over the shared relay StepUpService (WebAuthn step-up ceremony). |
| `sdk/src/platform/control-plane/routes/tailscale.ts` | JEV | Handlers for tailscale.get (read-only detection) and tailscale.serve.run (the one state-changing command), recording an honest receipt and updating web.publicBaseUrl on success. |
| `sdk/src/platform/control-plane/routes/update.ts` | JEV | Handlers for update.status and update.check, exposing the self-update loop's already-kept state over the wire. |
| `sdk/src/platform/control-plane/routes/voice-setup.ts` | JEV | Handlers for the managed local-voice provisioning verbs (status/install) and the wake-word artifact verbs (status/provision/chunked model read) over a live provisioner. |
| `sdk/src/platform/control-plane/routes/workspaces.ts` | JEV | Handlers for the registered-workspace registry verbs (list/add/remove/resolve) over WorkspaceRegistrationStore, mapping WorkspaceRegistrationError to a 400. |
| `sdk/src/platform/control-plane/routes/worktree-setup.ts` | JEV | Handlers for worktrees.setup.run (rerun cold-start setup on a live worktree) and worktrees.discard, recording the outcome onto the worktree registry. |
| `sdk/src/platform/control-plane/session-broker-gc.ts` | JEV | Garbage collection for shared sessions: closes idle sessions past fixed time thresholds (empty vs. with content) and deletes closed sessions past a configured retention age, trimming their in-memory message/input maps to match. |
| `sdk/src/platform/control-plane/session-broker-helpers.ts` | JEV | Small shared types and a helper deduplicating a session's participant surface kinds for the shared-session broker. |
| `sdk/src/platform/control-plane/session-broker-inputs.ts` | JEV | Records and updates queued shared-session inputs (steer/follow-up/submit) in the input store, keeping the session's pending-input count and last-activity timestamp in sync. |
| `sdk/src/platform/control-plane/session-broker-intent.ts` | JEV | Handles one inbound shared-session message end to end: validates a route binding's session hint and rolls the conversation over to a fresh session when the bound one is unusable, appends the message, queues the input, and decides whether to hand it to a running agent, queue it for a live surface, reject it, or spawn new work. The caller-supplied intent (submit/steer/follow-up) and the session/binding state it branches on are explicit structured values, not text interpreted for meaning. |
| `sdk/src/platform/control-plane/session-broker-messages.ts` | JEV | Appends a message to a shared session's message list and its persisted record, assigning ids and timestamps. |
| `sdk/src/platform/control-plane/session-broker-runtime-bus.ts` | JEV | Bridges the shared session broker to the runtime event bus, resolving which session an agent event belongs to and forwarding agent completions into the broker exactly once. |
| `sdk/src/platform/control-plane/session-broker-sessions.ts` | JEV | Session lifecycle helpers for the shared-session broker: creating and registering sessions, deriving the origin surface kind, attaching participants and routes, and deciding by a fixed freshness window whether a steer/follow-up should route to a live surface participant instead of the executor path. |
| `sdk/src/platform/control-plane/session-broker-state.ts` | JEV | Persistence and snapshot (de)serialization for the shared-session broker's in-memory maps: validates every record's shape and enum fields against the known set on load, and builds the durable snapshot on save. |
| `sdk/src/platform/control-plane/session-broker.ts` | JEV | The SharedSessionBroker class: the composed session/message/input state, wiring together creation, routing, GC, persistence, the runtime-bus bridge and surface-reply binding into the one object the daemon's control plane drives. |
| `sdk/src/platform/control-plane/session-intents.ts` | JEV | Type definitions for a shared session's input intent (submit/steer/follow-up), its lifecycle states, and the routing-intent and continuation-request shapes, all closed enums or structured fields, not free text. |
| `sdk/src/platform/control-plane/session-store-importer.ts` | JEV | Boot-time, idempotent merge of every pre-existing session store (companion chat files, per-project broker snapshots, the stale agent-fork store) into the one home-scoped durable broker store, keyed by session id with newer-updatedAt-wins semantics; corrupt files are logged and skipped. |
| `sdk/src/platform/control-plane/session-types.ts` | JEV | Type definitions for a shared session record, its participants, messages and submission/registration inputs. |
| `sdk/src/platform/control-plane/sse-timing.ts` | JEV | One derived constant and function for server-sent-events keep-alive timing, deriving the server idle timeout from the heartbeat interval so the two numbers can never drift apart. |
| `sdk/src/platform/control-plane/types.ts` | JEV | Shared gateway and control-plane contract types: streaming mode, client surface enum, and related wire shapes. |
| `sdk/src/platform/daemon/approval-reply.ts` | JEV | Reads a paired channel owner's reply on the shared ingress path and resolves a pending approval ask through the ApprovalBroker; parses the reply text into approve/deny plus an optional steering note. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/control-plane/routes/attribution-ingest.ts:78` | isRateLimitReason lowercases a STREAM_RETRY event's reason string and checks it with .includes for 'rate', 'quota', '429', 'limit', 'overloaded' to decide whether a retry was caused by a rate limit before recording it against the quota window | coarsen pattern: classify the retry reason to a parent label (rate-limited vs other), or a yes/no failure-transience reading, in place of the phrase-list match |
| `sdk/src/platform/daemon/approval-reply.ts:25` | a regex matches the trimmed reply text against a fixed list of verb words (approve, approved, allow, yes, deny, denied, reject, no) to decide whether the owner approved or denied, and treats everything after the verb as free-text steering guidance | reply pattern: read the human's reply as approve, reject, amend or unclear, carrying any trailing text as steering guidance on the resolution |

## core

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/core/adaptive-planner.ts` | JEV | AdaptivePlanner: scores and selects an execution strategy (single/cohort/background/remote) from risk score, latency budget and task-shape inputs, with a user-override and audit history. |
| `sdk/src/platform/core/circuit-breaker.ts` | JEV | ConsecutiveErrorBreaker: a plain counter of consecutive all-failed turns with two fixed numeric thresholds (warn at 5, break at 10); a deterministic counter, not a text-meaning judgment. |
| `sdk/src/platform/core/compaction-sections.ts` | JEV | Rule-based section builders for the compaction handoff (handoff header, reinjected instructions, session memories, current task, running/completed agents, agent activity table, plan progress, session lineage) plus the prompt text for the four LLM-assisted extraction calls the compactor sends. |
| `sdk/src/platform/core/compaction-types.ts` | JEV | Shared types, default budgets and the token-estimate helper for the compaction engine; the CompactionReceipt record every automatic compaction emits. |
| `sdk/src/platform/core/context-compaction.ts` | JEV | Structured compaction engine: assembles rule-based sections, runs four parallel LLM extraction calls (conversation filter, tool results, older-agent summary, resolved problems), assembles and structurally validates the compacted output. |
| `sdk/src/platform/core/conversation-compaction.ts` | JEV | Orchestrates one compaction pass: picks structured vs distiller strategy, scores the result through the shared quality scorer, falls back to structured on low quality or no reduction, and commits or rejects the compaction with an honest receipt. |
| `sdk/src/platform/core/conversation-diff.ts` | JEV | Deterministic unified-diff parsing (parseDiffForApply) and single-occurrence find-and-replace application (applyDiffContent) for the model's proposed file edits. |
| `sdk/src/platform/core/conversation-follow-ups.ts` | JEV | Normalizes and de-duplicates background-milestone follow-up items and builds the prompt asking the model to acknowledge them in 1-2 sentences. |
| `sdk/src/platform/core/conversation.ts` | JEV | ConversationManager: the message store (add/undo/redo/branch/merge, streaming block, LLM-message projection) plus isRedeliveredAssistantMessage, a strict field-equality check against only the immediately preceding message that drops an exact-duplicate replay. |
| `sdk/src/platform/core/conversation-utils.ts` | JEV | Message cloning/branch-map helpers, ProviderMessage-to-internal-message conversion, and deriveConversationTitle, a deterministic truncate-at-word-boundary title derivation. |
| `sdk/src/platform/core/deterministic-replay.ts` | JEV | DeterministicReplayEngine: folds a recorded ledger over an initial snapshot to replay a run step by step, and diffs replayed frames against the recording by structural key/type/value comparison, classifying each divergence into a fixed mismatch taxonomy. |
| `sdk/src/platform/core/distiller-compaction.ts` | JEV | The fresh-context distiller compaction strategy: one model call distills the conversation into a four-section continuation brief, which the caller scores and may fall back from; assembly and instruction re-injection mirror the structured strategy. |
| `sdk/src/platform/core/event-replay.ts` | JEV | EventReplayQueue: holds significant runtime events (agent/workflow completion) for a grace period and replays unacknowledged ones as system messages, with a bounded replay count and fixed urgency-label thresholds. |
| `sdk/src/platform/core/execution-plan.ts` | JEV | ExecutionPlanManager: JSON-backed CRUD, status derivation and markdown rendering/parsing for the multi-step execution plan, including a fixed-grammar markdown parser (checkbox/status-label/dependency syntax) for plans the model writes back. |
| `sdk/src/platform/core/index.ts` | JEV | Barrel re-export of every core module. |
| `sdk/src/platform/core/intent-classifier.ts` | JEV | classifyIntent: a pure heuristic (no LLM) classifier of a user message into chat/task/project, entirely by regex phrase-list matches that each add fixed points to a project/chat score, then fixed thresholds pick the intent and a formula fabricates a confidence number. |
| `sdk/src/platform/core/orchestrator-context-runtime.ts` | JEV | Context-window preflight and post-turn maintenance: reads the auto-compact percentage/safety-buffer decision, drives the pre/post compact hooks, and reports context-overflow with larger-context model alternatives. |
| `sdk/src/platform/core/orchestrator-follow-up-runtime.ts` | JEV | OrchestratorFollowUpRuntime: batches and de-duplicates background-milestone follow-up items on a fixed TTL, then asks a low-token model call to acknowledge them once the turn is idle. |
| `sdk/src/platform/core/orchestrator-live-turn.ts` | JEV | ToolCallAbortRegistry (per-call AbortController map) and the queued mid-turn message list/edit/delete helpers. |
| `sdk/src/platform/core/orchestrator-runtime.ts` | JEV | Shared Orchestrator core-services types and small deterministic helpers: usage normalization, fresh-turn input-token estimation, and service getters/requirers. |
| `sdk/src/platform/core/orchestrator-tool-runtime.ts` | JEV | executeToolCalls: runs the permission check and hook lifecycle around each tool call, handles per-call cancellation, and reconcileUnresolvedToolCalls/autoSpawnPendingItems for plan-item auto-spawn under the orchestration spawn policy. |
| `sdk/src/platform/core/orchestrator.ts` | JEV | Orchestrator: the turn-lifecycle contract runner class, owns idempotency fencing, thinking/streaming state, the delegate tool, queued-message and per-call cancellation, and delegates to the preflight/stream/reconcile phase helpers. |
| `sdk/src/platform/core/orchestrator-turn-flags.ts` | JEV | The three per-turn capability-gate reads (tool-result reconciliation, passive knowledge injection, passive code injection) with their differing on/off-by-default rules, gathered in one place. |
| `sdk/src/platform/core/orchestrator-turn-helpers.ts` | JEV | maybeEmitAdaptivePlannerDecision (feeds classifyIntent's result into the adaptive planner), prepareConversationForTurn (plan injection, image-capability guard, project-mode priming from classifyIntent's signals), and the tool-response/final-response turn outcome handlers (plan auto-spawn, WRFC chain hand-off messaging). |
| `sdk/src/platform/core/orchestrator-turn-loop.ts` | JEV | executeOrchestratorTurnLoop: the per-iteration LLM call loop, streaming, context-overflow retry-once, per-turn passive knowledge/code injection budget and composition, and the consecutive-tool-failure circuit breaker. |
| `sdk/src/platform/core/orchestrator-usage.ts` | JEV | OrchestratorUsageTotals, the named shape of the running input/output/cache token totals an Orchestrator accumulates. |
| `sdk/src/platform/core/plan-command-handler.ts` | JEV | handlePlanCommand: dispatches the /plan slash-command subcommands (mode, explain, override, clear, status) onto the AdaptivePlanner, over a fixed subcommand and strategy-name vocabulary. |
| `sdk/src/platform/core/plan-decomposition.ts` | JEV | decomposeGoal: drives a bounded read-only planning agent to decompose a goal into work items, strictly structurally validates its JSON output (schema shape, not meaning), repairs once on validation failure, and falls back to the honest single-item proposal with a recorded reason on any failure. |
| `sdk/src/platform/core/plan-proposal.ts` | JEV | Pure, I/O-free plan proposal types and assembler: turns a raw decomposition into a validated PlanProposal (phase/dependency resolution, cycle detection), plus the single-item fallback and the two persistence/approval adapters. |
| `sdk/src/platform/core/replay-command-handler.ts` | JEV | handleReplayCommand: dispatches the /replay slash-command subcommands (load, step, seek, diff, export) onto a DeterministicReplayEngine and an optional ledger reader. |
| `sdk/src/platform/core/session-lineage.ts` | JEV | SessionLineageTracker: an append-only, session-scoped micro-log of the original task and one line per compaction; idempotent task set, entries never modified or removed. |
| `sdk/src/platform/core/session-memory.ts` | JEV | SessionMemoryStore: an in-memory, session-scoped pinned-note store (add/remove/list/format/estimateTokens) with monotonic ids that survive clear(). |
| `sdk/src/platform/core/tokenizer.ts` | JEV | InputTokenizer: a terminal input-stream parser recognizing bracketed paste, ANSI/CSI/SS3 escape sequences and the Kitty keyboard protocol into typed key/mouse/focus/text tokens, over fixed byte-code tables. |
| `sdk/src/platform/core/tool-reconciliation.ts` | JEV | Types and helpers (buildSyntheticResult, detectUnresolvedToolCalls) for synthesizing an honest error result for a tool call a turn never resolved, by set-difference over call ids. |
| `sdk/src/platform/core/transcript-events/classify.ts` | JEV | classifyTranscriptMessages: projects a conversation snapshot into typed transcript events for rendering (user input, assistant output, tool call/result, and a system-message sub-classification by bracketed tag). |
| `sdk/src/platform/core/transcript-events/grouping.ts` | JEV | groupTranscriptEvents: groups a flat transcript-event list by their already-assigned groupKey into displayable event groups. |
| `sdk/src/platform/core/transcript-events/index.ts` | JEV | buildTranscriptEventIndex: composes classifyTranscriptMessages and groupTranscriptEvents into one call, and re-exports both plus their types. |
| `sdk/src/platform/core/transcript-events/types.ts` | JEV | TranscriptEventKind union and the TranscriptEvent record shape shared by the classifier and grouper. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/core/adaptive-planner.ts:168` | scoreStrategy adds hand-picked point values to a base score per strategy from fixed thresholds (riskScore > 0.7 adds/blocks, latencyBudgetMs < 5000 adds 20, isMultiStep, remoteAvailable, backgroundEligible) to rank single/cohort/background/remote and pick the reason code | risk-family battery: score-on-rubric scoring the task's risk and its fit for parallel/background/remote execution, banded to strategy selection, in place of the hand-tuned point additions and fixed thresholds |
| `sdk/src/platform/core/context-compaction.ts:579` | after the resolved-problems LLM extraction call, the response text is lowercased and checked with === 'empty' or .includes('no resolved problems') to decide whether the model reported nothing worth keeping, before the section is included | reply pattern: read the model's free-text answer as a yes/no, did it report any resolved problems, in place of the fixed-phrase match |
| `sdk/src/platform/core/intent-classifier.ts:22` | nine regex phrase lists (ACTION_VERBS, QUESTION_WORDS, SPEC_PLAN_WORDS, PARALLELISM_WORDS, FILE_REFERENCES, DELIVERABLE_SEPARATORS, MULTI_SENTENCE, RETROSPECTIVE_DOCUMENTATION_REQUEST, CONCRETE_IMPLEMENTATION_ACTION) tested against the raw message text, each match adding a hand-picked point value to a projectScore or chatScore | choice pattern: a single battery question classifying the message's intent as chat, task or project, in place of the keyword/regex scoring |
| `sdk/src/platform/core/intent-classifier.ts:118` | classifyIntent picks the final intent from fixed score thresholds (chatScore >= 2, projectScore >= 3, projectScore >= 1) and computes a confidence number from a hand-picked linear formula (0.50 + score*0.08, etc.) | choice pattern's own confidence/band output, replacing the fixed thresholds and the fabricated confidence formula |
| `sdk/src/platform/core/transcript-events/classify.ts:16` | for a system message carrying the '[Approval]' tag, a regex over the message text (/(allowed/approved/denied/rejected/granted)/i) decides whether to classify it as an approval_resolution or an approval_request | reply pattern: read the system message as a yes/no, does it report a resolved approval decision, in place of the fixed-word regex |

## daemon routes (daemon-sdk)

| File | Disposition | Note |
|---|---|---|
| `daemon-sdk/src/api-router.ts` | PORT | Optional extension dispatchers injected alongside the standard route set. |
| `daemon-sdk/src/auth-helpers.ts` | PORT | Guard helper: returns the admin-denied response if the caller lacks admin privileges, otherwise calls `next()` and returns its result. |
| `daemon-sdk/src/channel-routes.ts` | PORT | Exports createDaemonChannelRouteHandlers. |
| `daemon-sdk/src/channel-route-types.ts` | PORT | Inbound mail's health entry, mirrored structurally the way this package mirrors every SDK type it routes. |
| `daemon-sdk/src/context.ts` | PORT | Defines the DaemonOperatorRouteHandlers context interface; the approve/deny/claim/cancel actions are a closed enum dispatched by URL segment, not a free-text guess. |
| `daemon-sdk/src/control-routes.ts` | PORT | The PLATFORM build this daemon is composed from, the SDK's own version. |
| `daemon-sdk/src/http-policy.ts` | PORT | The kind of authenticated principal making a daemon request. |
| `daemon-sdk/src/index.ts` | PORT | Re-exports ./api-router.js, ./artifact-upload.js, ./automation.js, ./channel-routes.js, ./control-routes.js, ./error-response.js. |
| `daemon-sdk/src/integration-routes.ts` | PORT | Handle GET /api/sessions. |
| `daemon-sdk/src/integration-route-types.ts` | PORT | Interface definitions for integration route context (memory registry, provider snapshots, user auth manager); no logic. |
| `daemon-sdk/src/knowledge-refinement-routes.ts` | PORT | Exports createDaemonKnowledgeRefinementRouteHandlers. |
| `daemon-sdk/src/knowledge-routes.ts` | PORT | Daemon HTTP routes for knowledge ingest, search, ask, packets, review and schedules; all field parsing is fixed-format (booleans, enums, query strings), forwarding to the engine knowledge subsystem which carries the actual judgment. |
| `daemon-sdk/src/knowledge-route-types.ts` | PORT | Exports AutomationScheduleDefinition, KnowledgeProjectionTargetKind, KnowledgeUsageKind, KnowledgeCandidateStatus, KnowledgeSourceType, KnowledgePacketDetail, and more. |
| `daemon-sdk/src/media-routes.ts` | PORT | Exports createDaemonMediaRouteHandlers. |
| `daemon-sdk/src/media-route-types.ts` | PORT | Exports ArtifactKind, FetchExtractMode, MediaArtifact, MultimodalAnalysisResult, MultimodalDetail, VoiceAudioArtifact, and more. |
| `daemon-sdk/src/memory-record-body.ts` | PORT | Parses memory record request bodies (add, filter, update, review, link, bundle import) into typed inputs; fixed-shape field reads only. |
| `daemon-sdk/src/otlp-protobuf.ts` | PORT | Return uint64 fields as string (via BigInt) to preserve nanosecond precision. |
| `daemon-sdk/src/pagination.ts` | PORT | Cursor-based pagination utilities for daemon route handlers. |
| `daemon-sdk/src/relay-registration.ts` | PORT | Structural client WebSocket the daemon uses to dial the relay. |
| `daemon-sdk/src/relay-server-entry.ts` | PORT | Options for { |
| `daemon-sdk/src/relay-server.ts` | PORT | The subset of a WebSocket the hub needs. |
| `daemon-sdk/src/remote-routes.ts` | PORT | The auth object the remote route handlers carry through untouched. |
| `daemon-sdk/src/remote.ts` | PORT | Dispatches remote pairing routes; the approve/reject action comes directly from a fixed URL path segment, not a guessed reading of text. |
| `daemon-sdk/src/route-helpers.ts` | PORT | A plain JSON object (record of string keys to unknown values). |
| `daemon-sdk/src/runtime-automation-routes.ts` | PORT | Handle GET /api/automation/jobs. |
| `daemon-sdk/src/runtime-routes.ts` | PORT | Exports createDaemonRuntimeRouteHandlers. |
| `daemon-sdk/src/runtime-route-types.ts` | PORT | Type definitions for the runtime route context (session broker, automation manager, routing intent shape); no decision logic. |
| `daemon-sdk/src/runtime-session-lifecycle-routes.ts` | PORT | runtime-session-lifecycle-routes.ts Shared-session lifecycle route handlers (get / close / reopen / detach / delete). |
| `daemon-sdk/src/runtime-session-register.ts` | PORT | Handle POST /api/sessions/register, the idempotent registration + heartbeat upsert keyed on a caller-supplied `sessionId`. |
| `daemon-sdk/src/runtime-session-routes.ts` | PORT | Daemon HTTP routes for shared sessions, tasks and routing intent; parses closed-set fields (session kind, status, reasoning effort) supplied explicitly by the caller, not inferred from prose. |
| `daemon-sdk/src/system-routes.ts` | PORT | Daemon routes for watchers and approvals; approve/deny/claim/cancel actions and watcher kinds come from fixed enums and URL segments, not guesswork. |
| `daemon-sdk/src/system-route-types.ts` | PORT | Absolute path of the settings file this manager writes to. |
| `daemon-sdk/src/tasks.ts` | PORT | Thin task-route dispatcher forwarding fixed HTTP verbs to task handlers. |
| `daemon-sdk/src/telemetry-routes.ts` | PORT | Daemon telemetry routes and OTLP ingest; filters and permission checks are deterministic (scopes, timestamps, severities). |

## daemon server

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/daemon/auto-updater.ts` | PORT | DaemonAutoUpdater, the daemon's self-update loop. |
| `sdk/src/platform/daemon/boot-rollback.ts` | PORT | Crash-loop auto-rollback: the safety net under the self-update loop. |
| `sdk/src/platform/daemon/boot.ts` | PORT | Thin public factory that composes a full DaemonServer instance from a home/working dir and starts it; pure composition wiring, no decision logic. |
| `sdk/src/platform/daemon/cli-paths.ts` | PORT | cli-paths.ts, where a daemon process reads and writes, resolved once. |
| `sdk/src/platform/daemon/cli.ts` | PORT | The one-command service install: `goodvibes-daemon --install-service` writes the service unit (with the survival contract) and reports the follow-up commands, no raw HTTP call, no admin-token juggling. |
| `sdk/src/platform/daemon/control-plane.ts` | PORT | Per-pairing token authenticator. |
| `sdk/src/platform/daemon/daemon-exec-invocation.ts` | PORT | daemon/daemon-exec-invocation.ts How the daemon's supervised-service ExecStart should be written depends on how THIS process was actually started, not on whether a `dist/` build happens to sit next to the working directo |
| `sdk/src/platform/daemon/daemon-session-store-boot.ts` | PORT | daemon-session-store-boot.ts, the two things the daemon does to its session store before the broker serves: fold every legacy store forward, then sweep the pre-split one aside. |
| `sdk/src/platform/daemon/facade-boot-guarantees.ts` | PORT | facade-boot-guarantees, the things the daemon must not depend on its host to have remembered. |
| `sdk/src/platform/daemon/facade-builtin-channels.ts` | PORT | facade-builtin-channels.ts, the builtin channel runtime and the inbound surfaces it owns. |
| `sdk/src/platform/daemon/facade-channel-health.ts` | PORT | Watches channel health and announces a dead or recovered channel over another surface that still works. DELIVERABLE_ALERT_SURFACES is a fixed set of known surface-kind identifiers (push vs pull surfaces), not a guess about text meaning. |
| `sdk/src/platform/daemon/facade-cluster-sockets.ts` | PORT | facade-cluster-sockets.ts, contesting a socket surface under its REAL name. |
| `sdk/src/platform/daemon/facade-cluster.ts` | PORT | facade-cluster.ts, leadership gating for the daemon's INBOUND consumers, one gate per surface. |
| `sdk/src/platform/daemon/facade-composition.ts` | PORT | Composes the daemon's runtime graph (control-plane gateway, hosted sessions, channel reply pipeline, companion chat adapter) and wires the shared-session continuation runner. No guesswork of its own; it calls into surface-conversation-gate.ts, which calls the real classifier. |
| `sdk/src/platform/daemon/facade-gmail-reader.ts` | PORT | facade-gmail-reader.ts, where the daemon's Google credential meets inbound mail. |
| `sdk/src/platform/daemon/facade-inbound-mail.ts` | PORT | facade-inbound-mail.ts, assembling the inbound-mail graph for the daemon. |
| `sdk/src/platform/daemon/facade-lifecycle.ts` | PORT | DaemonLifecycleRuntime, the daemon facade's lifecycle sidecar: the clean-shutdown marker (crash detection), the persisted receipt store ("updated from X to Y at HH:MM", "restarted after a crash at HH:MM"), and the hourly |
| `sdk/src/platform/daemon/facade.ts` | PORT | The DaemonServer class: HTTP bootstrap, start/stop lifecycle, websocket upgrade, approval-action handling, agent spawn. The one string check found (message.includes('capacity reached')) tests an internal error message this codebase itself produces, to pick an HTTP status, not natural-language content. |
| `sdk/src/platform/daemon/facade-types.ts` | PORT | Pure type definitions for the daemon facade's resolved runtime and collaborators; no logic. |
| `sdk/src/platform/daemon/fatal-boot-report.ts` | PORT | fatal-boot-report.ts, saying why, on a stream, before the process stops. |
| `sdk/src/platform/daemon/gateway-self-dispatch.ts` | PORT | gateway-self-dispatch.ts Guards the one way a gateway method can be dispatched into itself forever. |
| `sdk/src/platform/daemon/helpers.ts` | PORT | Read a response body to text with a hard byte ceiling. |
| `sdk/src/platform/daemon/homeassistant-chat.ts` | PORT | Bridges a Home Assistant conversation turn into the companion chat manager and route bindings. No guesswork found. |
| `sdk/src/platform/daemon/hosted-sessions-composition.ts` | PORT | hosted-sessions-composition.ts, wiring the hosted-session engine into a daemon. |
| `sdk/src/platform/daemon/host-mode-watcher.ts` | PORT | host-mode-watcher.ts Shared helper that creates a config-key watcher for host-mode restart logic. |
| `sdk/src/platform/daemon/host-resolver.ts` | PORT | host-resolver.ts, the ONE truth for daemon bind-address + port resolution. |
| `sdk/src/platform/daemon/http/batch-routes.ts` | PORT | Exports DaemonBatchRouteContext, dispatchBatchRoutes. |
| `sdk/src/platform/daemon/http/channel-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/channel-route-types.ts` | PORT | Module channel-route-types.ts. |
| `sdk/src/platform/daemon/http/cloudflare-routes.ts` | PORT | Exports DaemonCloudflareRouteContext, dispatchCloudflareRoutes. |
| `sdk/src/platform/daemon/http/cluster-group-routes.ts` | PORT | cluster-group-routes.ts, the daemon verbs for LAN group membership. |
| `sdk/src/platform/daemon/http/control-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/error-response.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/homeassistant-routes.ts` | PORT | HTTP route handling for the Home Assistant conversation submit/poll endpoints. The one flagged string check (posted.error.toLowerCase().includes('timed out')) inspects an internal timeout error message this codebase produces itself, to choose an HTTP status code, not a natural-language classification. |
| `sdk/src/platform/daemon/http/home-graph-routes.ts` | PORT | Exports HomeGraphRoutes. |
| `sdk/src/platform/daemon/http/integration-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/integration-route-types.ts` | PORT | Exports IntegrationRuntimeStoreLike. |
| `sdk/src/platform/daemon/http/knowledge-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/knowledge-route-types.ts` | PORT | Exports KnowledgeUsageKind, KnowledgeCandidateStatus, KnowledgeSourceType. |
| `sdk/src/platform/daemon/http-listener.ts` | PORT | Parses forwarded-for headers and Cloudflare IP ranges to resolve the real client IP for TLS/proxy trust. Deterministic network/CIDR logic, not natural-language content. |
| `sdk/src/platform/daemon/http/mcp-routes.ts` | PORT | The same server record with its `env` VALUES included. |
| `sdk/src/platform/daemon/http/media-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/media-route-types.ts` | PORT | Exports ConfigManagerLike, ArtifactStoreLike. |
| `sdk/src/platform/daemon/http/model-routes.ts` | PORT | model-routes.ts HTTP route handlers for model catalog discovery and global model selection. |
| `sdk/src/platform/daemon/http/openai-compatible-routes.ts` | PORT | Exports OpenAICompatibleRouteContext, dispatchOpenAICompatibleRoutes. |
| `sdk/src/platform/daemon/http-policy.ts` | PORT | Exports AuthenticatedPrincipalKind, AuthenticatedPrincipal, resolveAuthenticatedPrincipal, buildMissingScopeBody, resolvePrivateHostFetchOptions. |
| `sdk/src/platform/daemon/http/project-planning-routes.ts` | PORT | Exports ProjectPlanningRoutes. |
| `sdk/src/platform/daemon/http/rate-limiter.ts` | PORT | Entries older than this are eligible for TTL eviction. |
| `sdk/src/platform/daemon/http/remote-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/route-helpers.ts` | PORT | Exports toSerializableJson, serializableJsonResponse. |
| `sdk/src/platform/daemon/http/router-knowledge-context.ts` | PORT | router-knowledge-context.ts, the knowledge route context, built once. |
| `sdk/src/platform/daemon/http/router-request-body.ts` | PORT | Exports parseDaemonJsonBody, parseOptionalDaemonJsonBody, parseDaemonJsonText. |
| `sdk/src/platform/daemon/http/router-route-contexts.ts` | PORT | The optional providers the daemon facade hands the router for /status. |
| `sdk/src/platform/daemon/http/router-session-broker-adapter.ts` | PORT | router-session-broker-adapter.ts Adapts the real `SharedSessionBroker` to the narrow structural shape `createDaemonRuntimeRouteHandlers` (runtime-routes.ts) expects on its `sessionBroker` context field. |
| `sdk/src/platform/daemon/http/router.ts` | PORT | Inbound mail's health. |
| `sdk/src/platform/daemon/http/runtime-automation-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/runtime-routes.ts` | PORT | HTTP routes for runtime/session actions. isExecutionIntent is a deterministic type guard over a fixed literal union (ExecutionIntent), not a natural-language guess. |
| `sdk/src/platform/daemon/http/runtime-route-types.ts` | PORT | Type definitions for the runtime routes (ExecutionIntent, SharedSessionRoutingIntent); no logic. |
| `sdk/src/platform/daemon/http/runtime-session-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/session-event-stream.ts` | PORT | session-event-stream.ts, opening the SSE stream a client renders a turn from when the loop is running in THIS daemon rather than in the client. |
| `sdk/src/platform/daemon/http/system-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/system-route-types.ts` | PORT | Exports IntegrationApprovalSnapshotSourceLike, RouteBindingRecordInput, RouteBindingPatchInput, WatcherSourceRecord, WatcherRecord. |
| `sdk/src/platform/daemon/http/telemetry-routes.ts` | PORT | Re-exports @pellux/goodvibes-daemon-sdk. |
| `sdk/src/platform/daemon/http/webui-serving.ts` | PORT | webui-serving.ts Two opt-in capabilities that let a browser-hosted web UI reach the daemon: 1. |
| `sdk/src/platform/daemon/index.ts` | PORT | Re-exports ./boot.js, ./fatal-boot-report.js, ./host-resolver.js, ./hosted-sessions-composition.js, ./http-listener.js, ./http-policy.js. |
| `sdk/src/platform/daemon/lifecycle-marker.ts` | PORT | Clean-shutdown marker + failed-start counter: one small persisted file the daemon writes at three moments. |
| `sdk/src/platform/daemon/owner-alert.ts` | PORT | owner-alert.ts, reaching the owner when the thing that broke is a channel. |
| `sdk/src/platform/daemon/port-check.ts` | PORT | Check if a TCP port is available before attempting to bind. |
| `sdk/src/platform/daemon/receipts.ts` | PORT | Daemon receipts: one-line, human-readable records of daemon-side events that happened while no surface was watching ("updated from X to Y at HH:MM", "restarted after a crash at HH:MM"). |
| `sdk/src/platform/daemon/safe-serve.ts` | PORT | safe-serve.ts, a port-conflict-honest `Bun.serve` wrapper. |
| `sdk/src/platform/daemon/server.ts` | PORT | Re-exports ./facade.js. |
| `sdk/src/platform/daemon/service-manager.ts` | PORT | The resolved service name (`service.serviceName` config, else the built-in default), so a CLI/consumer never has to hardcode it. |
| `sdk/src/platform/daemon/surface-actions.ts` | PORT | Builds the surface adapter context and handles surface control commands (status/cancel/retry) and interactive card actions (gv:approval:..., gv:run:...). All parsing is a fixed command grammar over known verbs and ids, not natural-language guesswork. |
| `sdk/src/platform/daemon/surface-approval-delivery.ts` | PORT | Delivers approval notices over Slack, Discord and ntfy. No guesswork found. |
| `sdk/src/platform/daemon/surface-card-gate.ts` | PORT | Refuses card-shaped (payment instrument) content arriving over any remote messaging channel before it can be logged or persisted. This is exactly the card-shape scanner the brief marks deterministic, not a decision point. |
| `sdk/src/platform/daemon/surface-conversation-gate.ts` | PORT | The conversation-first spawn gate: at line 107 it calls classifyInboundIntent(inboundText) (defined in agents/conversation-gate.js, not in this file list) to decide whether an inbound message is a work request or plain conversation, then either spawns a conversational turn or proposes a workstream over the channel. That classification is real guesswork and matches the core subsystem's 'intent is a choice' JEV treatment; the intent table places this specific file under daemon server (PORT), so flagging the call site here for the coordinator rather than reclassifying it myself. |
| `sdk/src/platform/daemon/surface-delivery.ts` | PORT | Delivery ledger and dispatch for surface replies: webhook signing, queueing, polling pending replies. No guesswork found. |
| `sdk/src/platform/daemon/surface-direct-delivery.ts` | PORT | surface-direct-delivery.ts, sending straight to one surface's own API, bypassing the channel render path. |
| `sdk/src/platform/daemon/surface-homeassistant-reply.ts` | PORT | surface-homeassistant-reply.ts, the Home Assistant half of the daemon's surface actions: run a chat turn for an inbound HA message and publish the assistant's reply back as a Home Assistant event. |
| `sdk/src/platform/daemon/surface-policy.ts` | PORT | Exports isSurfaceDeliveryEnabled. |
| `sdk/src/platform/daemon/transport-events.ts` | PORT | Exports DaemonTransportEventsHelper. |
| `sdk/src/platform/daemon/types.ts` | PORT | Absolute path to the daemon home directory (`daemon.homeDir`). |
| `sdk/src/platform/daemon/update-status.ts` | PORT | update-status.ts, what a daemon can say about updating itself. |
| `sdk/src/platform/daemon/work-proposal-reply.ts` | PORT | Channel-reply resolution of pending work proposals. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/daemon/surface-conversation-gate.ts:107` | gateSurfaceSpawn calls classifyInboundIntent(inboundText) (implemented in agents/conversation-gate.js, not this file) on the raw inbound message text to decide whether it is a work request or plain conversation; needsAgreement and the whole propose-vs-spawn branch turn on that classification's kind | a dispatch pattern: route the inbound message to 'work' or 'conversation' before deciding whether to propose a workstream or reply conversationally |

## discovery, mcp, plugins, acp

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/acp/agent.ts` | PORT | ACP agent-side protocol adapter over the embedded session API; permission and stop-reason mapping are deterministic switches over fixed protocol enums, not free-text reading. |
| `sdk/src/platform/acp/connection.ts` | PORT | AcpConnection, Per-subagent ACP connection. |
| `sdk/src/platform/acp/host.ts` | PORT | acp/host.ts, HOSTING third-party coding agents over the Agent Client Protocol. |
| `sdk/src/platform/acp/index.ts` | PORT | Re-exports ./agent.js, ./connection.js, ./host.js, ./manager.js. |
| `sdk/src/platform/acp/manager.ts` | PORT | AcpManager, Manages the lifecycle of all subagent ACP connections. |
| `sdk/src/platform/acp/optional-sdk.ts` | PORT | optional-sdk.ts, the one place ` |
| `sdk/src/platform/acp/protocol.ts` | PORT | ACP Protocol Types Re-exports SDK types and defines local types for subagent management. |
| `sdk/src/platform/discovery/index.ts` | PORT | Re-exports ./mcp-scanner.js, ./scanner.js. |
| `sdk/src/platform/discovery/mcp-scanner.ts` | PORT | mcp-scanner.ts MCP server auto-discovery: scans common locations for MCP server definitions that are not already registered in the active config. |
| `sdk/src/platform/mcp/client.ts` | PORT | Low-level MCP client: spawns and talks to one MCP server process over JSON-RPC, caches tool schemas, pings and restarts on crash. The flagged word 'intentionalClose' is a boolean flag name, not a meaning judgment. |
| `sdk/src/platform/mcp/client-types.ts` | PORT | Public option and observation types for McpClient. |
| `sdk/src/platform/mcp/config.ts` | PORT | MCP server configuration, scans multiple locations in precedence order. |
| `sdk/src/platform/mcp/elicitation.ts` | PORT | Turns an MCP server's elicitation/create request into a permission prompt, and maps the broker's already-computed approve/deny decision to accept/decline. No free text is read here; the yes/no was decided upstream by the approval broker. |
| `sdk/src/platform/mcp/http-connection.ts` | PORT | Streamable HTTP connection for the MCP client. |
| `sdk/src/platform/mcp/http-headers.ts` | PORT | Streamable HTTP request-metadata headers (revision 2026-07-28). |
| `sdk/src/platform/mcp/index.ts` | PORT | Re-exports ./client.js, ./config.js, ./mcp-api.js, ./registry.js. |
| `sdk/src/platform/mcp/jsonrpc.ts` | PORT | JSON-RPC 2.0 message shapes and guards shared by the MCP client's stdio and HTTP transports. |
| `sdk/src/platform/mcp/mcp-api.ts` | PORT | Exports McpServerRecord, McpServerSecurityRecord, McpSandboxBindingRecord, McpApi, McpApiRegistry, createMcpApi. |
| `sdk/src/platform/mcp/protocol.ts` | PORT | MCP protocol revision knowledge shared by the stdio and HTTP transports. |
| `sdk/src/platform/mcp/registry.ts` | PORT | Registry that connects, reloads, and dispatches tool calls across every configured MCP server, including sandbox binding and schema quarantine decisions based on structured state, not guesswork. |
| `sdk/src/platform/mcp/server/index.ts` | PORT | mcp/server, a local-first Model Context Protocol server that exposes the GoodVibes daemon's operator surface as MCP tools, generated from the operator catalog rather than hand-written, so an external agent tool can drive |
| `sdk/src/platform/mcp/server/session-tools.ts` | PORT | Fixed table of session lifecycle MCP tools (create, attach, send-message, read-transcript, steer) and their method ids. The 'intent' field is a closed enum tag on hardcoded data, not a classification of free text. |
| `sdk/src/platform/mcp/server/stdio-server.ts` | PORT | mcp/server/stdio-server.ts A minimal, dependency-free Model Context Protocol server that speaks JSON-RPC 2.0 over a newline-delimited stream (stdio is the local-first default). |
| `sdk/src/platform/mcp/server/tool-definitions.ts` | PORT | mcp/server/tool-definitions.ts Generates Model Context Protocol tool definitions from the GoodVibes operator catalog, rather than hand-writing them, so the MCP surface an external agent tool sees is exactly the daemon's  |
| `sdk/src/platform/plugins/api.ts` | PORT | PluginProviderConfig, minimal config for registering a custom LLM provider via an OpenAI-compatible endpoint. |
| `sdk/src/platform/plugins/index.ts` | PORT | Re-exports ./api.js, ./loader.js, ./manager.js. |
| `sdk/src/platform/plugins/loader.ts` | PORT | Additional plugin directories to search, appended after the standard directories. |
| `sdk/src/platform/plugins/manager.ts` | PORT | PluginState, Persisted state for all plugins. |
| `sdk/src/platform/runtime/plugins/quarantine.ts` | PORT | PluginQuarantineEngine: revokes a plugin's high-risk capabilities and records a quarantine entry (reason, timestamp, revoked list) without unloading the plugin; lift() reverses the flag for a caller-triggered reload. Capability risk lookup is a fixed enum check (isHighRiskCapability), not text judgment. |

## email, google

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/email/address-digest.ts` | PORT | address-digest.ts, how a mail address is written down when something has to be written down. |
| `sdk/src/platform/email/email-config.ts` | PORT | Reading the email config, and resolving the one secret it points at. |
| `sdk/src/platform/email/email-read-results.ts` | PORT | What a mail read actually found, including the answer that used to have nowhere to go. |
| `sdk/src/platform/email/email-service.ts` | PORT | IMAP/SMTP mail service: connect, fetch, send. No guesswork found. |
| `sdk/src/platform/email/imap-body-probe.ts` | PORT | Can this connection actually read message content, asked, not assumed. |
| `sdk/src/platform/email/imap-bodystructure.ts` | PORT | Reading one whole message: BODYSTRUCTURE, MIME part selection, and decoding. |
| `sdk/src/platform/email/imap-client.ts` | PORT | Minimal IMAP4rev1 client over an injected socket. |
| `sdk/src/platform/email/imap-draft.ts` | PORT | Writing one draft: header safety, message composition, Drafts discovery. |
| `sdk/src/platform/email/imap-fetch-response.ts` | PORT | Reading `* n FETCH (...)` responses whole. |
| `sdk/src/platform/email/imap-headers.ts` | PORT | Reading an IMAP server's answers: header blocks, delivery evidence, and the three FETCH/SEARCH response shapes the client asks for. |
| `sdk/src/platform/email/imap-message-read.ts` | PORT | Reading ONE whole message by UID, and saying which of three things happened. |
| `sdk/src/platform/email/imap-names.ts` | PORT | Names and credentials as they go on the IMAP wire. |
| `sdk/src/platform/email/imap-open.ts` | PORT | Classifies why an IMAP open()/connection attempt failed (authentication, mailbox, server, or connection) into a routable, owner-facing notice with plain-language remedies, preferring the server's own RFC response code when one is given. |
| `sdk/src/platform/email/imap-session.ts` | PORT | The IMAP wire session: one persistent reader per connection, tagged commands, untagged dispatch, and literals. |
| `sdk/src/platform/email/imap-types.ts` | PORT | Type definitions for IMAP messages and folders; no logic. |
| `sdk/src/platform/email/inbound/any-signal.ts` | PORT | Combine several abort signals into one. |
| `sdk/src/platform/email/inbound/backoff.ts` | PORT | Reconnect backoff: exponential, ceilinged, and FULL-jittered. |
| `sdk/src/platform/email/inbound/capability-policy.ts` | PORT | capability-policy.ts, what `surfaces.email.inbound.onInsufficientCapability` actually selects, and where it cannot select anything. |
| `sdk/src/platform/email/inbound/capability.ts` | PORT | Can this watcher do its job at all, and if not, does the owner know? |
| `sdk/src/platform/email/inbound/capability-types.ts` | PORT | capability-types.ts, the vocabulary for "can this watcher do its job". |
| `sdk/src/platform/email/inbound/connection.ts` | PORT | The real `MailboxConnectionPort`: an `ImapClient` behind the narrow shape the watcher was written against. |
| `sdk/src/platform/email/inbound/cursor-store.ts` | PORT | cursor-store.ts, the durable per-mailbox cursor, for both sources (docs/inbound-email.md §4, §3.4d). |
| `sdk/src/platform/email/inbound/expectation-registry.ts` | PORT | The seam that was missing: something that actually registers an expectation. |
| `sdk/src/platform/email/inbound/expectation-store.ts` | PORT | expectation-store.ts, persistence for `VerificationExpectationBook` (docs/inbound-email.md §9.2). |
| `sdk/src/platform/email/inbound/gmail-source.ts` | PORT | gmail-source.ts, Gmail as a first-class inbound source (docs/inbound-email.md §3.4d). |
| `sdk/src/platform/email/inbound/health.ts` | PORT | health.ts, email's own health entry, deliberately NOT a channel's. |
| `sdk/src/platform/email/inbound/housekeeping.ts` | PORT | housekeeping.ts, recovery-time and periodic garbage collection for everything inbound mail persists: the cursor store, the record store, and the expectation store (docs/inbound-email.md §9). |
| `sdk/src/platform/email/inbound/idle-watcher.ts` | PORT | The IDLE loop: RFC 2177 push, and the five things about it that are easy to get wrong. |
| `sdk/src/platform/email/inbound/imap-source.ts` | PORT | imap-source.ts, the existing IMAP watcher, presented as an `InboundMailSource` (docs/inbound-email.md §3.4d). |
| `sdk/src/platform/email/inbound/index.ts` | PORT | The inbound-mail watcher: IMAP IDLE with an adaptive poll fallback. |
| `sdk/src/platform/email/inbound/intake.ts` | PORT | intake.ts, what happens to a message the sink accepted. |
| `sdk/src/platform/email/inbound/mailbox-position.ts` | PORT | Where a mailbox currently ends, and how we came to know it. |
| `sdk/src/platform/email/inbound-notice-channels.ts` | PORT | Turning a `StructuredNotice` into one channel's wire string. |
| `sdk/src/platform/email/inbound/notice-health.ts` | PORT | notice-health.ts, a refusal to announce arriving mail, made VISIBLE. |
| `sdk/src/platform/email/inbound-notice.ts` | PORT | inbound-notice.ts, the ONE thing the owner is allowed to read about an arriving email. |
| `sdk/src/platform/email/inbound/poll-loop.ts` | PORT | Finding what arrived: the delta fetch, and the adaptive poll that drives it. |
| `sdk/src/platform/email/inbound/ports.ts` | PORT | Everything the inbound-mail watcher is GIVEN rather than reaches for. |
| `sdk/src/platform/email/inbound/record-store.ts` | PORT | record-store.ts, the durable inbound-mail record store (docs/inbound-email.md §9.3). |
| `sdk/src/platform/email/inbound/record-validation.ts` | PORT | record-validation.ts, content validation and field bounds for one stored inbound-mail record (docs/inbound-email.md §9.3, rule 3: validate by content). |
| `sdk/src/platform/email/inbound/sink.ts` | PORT | Where a found message goes, and the guard that keeps one arrival producing one notice. |
| `sdk/src/platform/email/inbound/source-cursor.ts` | PORT | source-cursor.ts, the persisted position, discriminated by source (docs/inbound-email.md §3.4d, §4). |
| `sdk/src/platform/email/inbound/source-factory.ts` | PORT | source-factory.ts, building the source the selection chose. |
| `sdk/src/platform/email/inbound/source-selection.ts` | PORT | source-selection.ts, which source reads the mailbox (docs/inbound-email.md §3.4d, "Selection is automatic"). |
| `sdk/src/platform/email/inbound/source.ts` | PORT | source.ts, the seam that makes inbound mail source-agnostic (docs/inbound-email.md §3.4d). |
| `sdk/src/platform/email/inbound/store-write-lock.ts` | PORT | store-write-lock.ts, the cross-process half of "one writer at a time" for the three inbound-mail stores (docs/inbound-email.md §9). |
| `sdk/src/platform/email/inbound/supervisor-status.ts` | PORT | supervisor-status.ts, the shape `email.inbound.status` answers with. |
| `sdk/src/platform/email/inbound/supervisor.ts` | PORT | supervisor.ts, inbound mail's lifecycle owner (docs/inbound-email.md §3.5). |
| `sdk/src/platform/email/inbound/terminal-notice.ts` | PORT | terminal-notice.ts, routing a terminal inbound-mail failure to the OWNER. |
| `sdk/src/platform/email/inbound/types.ts` | PORT | types.ts, shared types and validation primitives for the inbound-email persisted stores: cursor-store.ts, record-store.ts, expectation-store.ts, and housekeeping.ts. |
| `sdk/src/platform/email/inbound/watcher.ts` | PORT | One mailbox, watched: the connection lifecycle the IDLE and poll loops sit inside. |
| `sdk/src/platform/email/inbound/watcher-types.ts` | PORT | What the watcher is constructed with, what it publishes, and the two ceilings that bound its retrying. |
| `sdk/src/platform/email/index.ts` | PORT | Barrel re-export for the email package, including style-reply.ts's classifyTone; no logic of its own. |
| `sdk/src/platform/email/node.ts` | PORT | Node-specific IMAP/SMTP transport wiring. No guesswork found. |
| `sdk/src/platform/email/sender-claim.ts` | PORT | Describes a From: header as a display-only claim, deriving a confidence tier (unverified/partially-verified/protocol-verified/failed-verification) by counting DKIM/SPF/DMARC pass results. This is a deterministic tally over structured security-check outcomes, not a natural-language guess, and commandAuthority is pinned to the literal 'none' so no branch can promote it into an authority decision. |
| `sdk/src/platform/email/smtp-client.ts` | PORT | Minimal SMTP submission client (EHLO negotiation, AUTH PLAIN/LOGIN, MAIL FROM/RCPT TO/DATA with RFC 2821 dot-stuffing). All branching is on SMTP reply codes and fixed control-character validation; no free-text meaning judgment. |
| `sdk/src/platform/email/style-reply-lane.ts` | PORT | Personal Ops lane and workflow descriptors for a writing-style-matched draft reply. Explicitly marked NOT SHIPPED / NOT WIRED in its own header; pure metadata strings, no runtime guesswork. |
| `sdk/src/platform/email/style-reply.ts` | PORT | Pure deterministic composer for a writing-style-matched draft email reply (not shipped or wired per style-reply-lane.ts). classifyTone (line 123) and mostFrequent (line 102, used for greeting and sign-off) score free text against hand-picked FORMAL_TOKENS/CASUAL_TOKENS/GREETING_TOKENS/SIGN_OFF_TOKENS word lists by substring counting, exactly the hand-tuned-keyword-score guesswork the brief flags. The intent table's email row does not call this file out as JEV, so this is a disposition the coordinator should reconsider given the real guesswork inside it. |
| `sdk/src/platform/email/surface-config.ts` | PORT | surface-config.ts, driving `EmailService` from the daemon's own mailbox keys. |
| `sdk/src/platform/google/account-registry.ts` | PORT | Durable record of every account the agent created in the owner's name. |
| `sdk/src/platform/google/api-client.ts` | PORT | Gmail and Google Calendar over their REST APIs. |
| `sdk/src/platform/google/app-password-flow.ts` | PORT | Drives Google's app-password page (https://myaccount.google.com/apppasswords) to create a 16-character app password with a known label. |
| `sdk/src/platform/google/browser-elements.ts` | PORT | Matching controls on Google's own pages by accessible role and name. |
| `sdk/src/platform/google/browser-port.ts` | PORT | Driving the Google setup pages with the platform browser. |
| `sdk/src/platform/google/caldav-client.ts` | PORT | Minimal CalDAV client over an injectable HTTP transport. |
| `sdk/src/platform/google/caldav-parse.ts` | PORT | Minimal, dependency-free parsing helpers for CalDAV wire formats. |
| `sdk/src/platform/google/calendar-ics-flow.ts` | PORT | Drives Google Calendar's settings page (https://calendar.google.com/calendar/u/0/r/settings) to capture a calendar's private iCal address. |
| `sdk/src/platform/google/client-download.ts` | PORT | Picking up the OAuth client JSON the console just downloaded. |
| `sdk/src/platform/google/client-intake.ts` | PORT | Getting OAuth client credentials into the agent, the pluggable front step. |
| `sdk/src/platform/google/config-access.ts` | PORT | Reading connector config without turning "not set up" into a crash. |
| `sdk/src/platform/google/connection-proof.ts` | PORT | Proves a stored Google credential actually works by reading Gmail and Calendar (both reads, nothing mutated), then classifies any failure into a scope refusal, a disabled API, or a generic read failure with a matching remedy. |
| `sdk/src/platform/google/connection-repair.ts` | PORT | connection-repair.ts, finishing an adoption that only half landed. |
| `sdk/src/platform/google/connection.ts` | PORT | Composition root that resolves stored Google OAuth credentials (encrypted store, optional explicit disk adoption) and builds a live Google API client whose refresh function distinguishes a dead grant from a transient failure, handing dead grants to grant-diagnosis.ts. |
| `sdk/src/platform/google/consent-session.ts` | PORT | Registering an OAuth client the owner just handed over, and getting the consent link back in the same breath. |
| `sdk/src/platform/google/console-flow.ts` | PORT | Drives the Google Auth Platform console pages in a browser to read/change the OAuth publishing status and create a Desktop OAuth client, reading known element names and rendered page text. detectPublishingStatus()'s two-literal check ('in production' vs 'testing') is exact fixed UI copy and is not listed as a decision point. |
| `sdk/src/platform/google/credential-adoption.ts` | PORT | Finding Google credentials that already exist on this machine. |
| `sdk/src/platform/google/credential-removal.ts` | PORT | Removing or replacing a stored Google credential, which never happens without the owner saying yes first. |
| `sdk/src/platform/google/delivery-evidence.ts` | PORT | Evidence that a message was actually delivered to a particular address. |
| `sdk/src/platform/google/discovery.ts` | PORT | Deciding how to connect Google, before doing anything about it. |
| `sdk/src/platform/google/gateway-calendar-service.ts` | PORT | The Google-backed implementation of the daemon's `calendar.*` verbs. |
| `sdk/src/platform/google/gcloud-posture.ts` | PORT | What the gcloud CLI on this machine can tell us, and what it cannot do. |
| `sdk/src/platform/google/gcloud.ts` | PORT | gcloud.ts, the gcloud driver for the OAuth (Path B) setup flow. |
| `sdk/src/platform/google/gmail-inbound-reader.ts` | PORT | gmail-inbound-reader.ts, turning an adopted Google credential into the two things `GmailMailSource` needs, or saying why there are none. |
| `sdk/src/platform/google/grant-diagnosis.ts` | PORT | Diagnoses why a Google refresh token stopped working (account mismatch, revoked, client mismatch, testing-expiry, or unknown) and states the fix, instead of silently retrying a dead grant six times as the old code did. |
| `sdk/src/platform/google/history-delta.ts` | PORT | Gmail incremental sync via `users.history.list`. |
| `sdk/src/platform/google/index.ts` | PORT | Re-exports ./account-registry.js, ./api-client.js, ./app-password-flow.js, ./browser-elements.js, ./browser-port.js, ./caldav-client.js. |
| `sdk/src/platform/google/node.ts` | PORT | The machine half of the Google connector. |
| `sdk/src/platform/google/oauth-loopback.ts` | PORT | google-oauth-loopback.ts, the OAuth 2.0 authorization-code + PKCE flow used by the Path B ("oauth") Google setup, driven through a local loopback redirect (the Desktop app client type; see google-setup-plan.ts). |
| `sdk/src/platform/google/sender-authentication.ts` | PORT | Reading the receiving server's sender-authentication verdict. |
| `sdk/src/platform/google/setup-action-deps.ts` | PORT | What the Google setup runners need, and how the OAuth client is obtained. |
| `sdk/src/platform/google/setup-actions-adoption.ts` | PORT | Taking up Google credentials that already exist as files on this machine. |
| `sdk/src/platform/google/setup-actions-cloud-project.ts` | PORT | The Cloud-project half of the OAuth path: gcloud and the console pages. |
| `sdk/src/platform/google/setup-actions.ts` | PORT | The runners that make the Google setup flow do something. |
| `sdk/src/platform/google/setup-flow.ts` | PORT | The flow executor. |
| `sdk/src/platform/google/setup-plan.ts` | PORT | The single source of truth for both Google setup paths. |
| `sdk/src/platform/google/setup-runbook.ts` | PORT | Renders the written fallback runbook from the step plan. |
| `sdk/src/platform/google/setup-state.ts` | PORT | What is already set up. |
| `sdk/src/platform/google/signup-address.ts` | PORT | Per-signup email aliasing. |
| `sdk/src/platform/google/token-manager.ts` | PORT | Keeping a usable Google access token available. |
| `sdk/src/platform/google/types.ts` | PORT | Shared contracts for the Google (Gmail + Calendar) setup flows. |
| `sdk/src/platform/google/verification-expectation-id.ts` | PORT | The bound on a verification expectation's `id`, and the shape one may take. |
| `sdk/src/platform/google/verification-expectations.ts` | PORT | Scoped email-verification expectations. |
| `sdk/src/platform/google/verification-extraction.ts` | PORT | Extracts a verification link or code from a matched signup/login email. Host matching is deterministic label-boundary domain comparison (security-adjacent, stays code), but the VERIFICATION_CONTEXT regex at line 67 (a fixed list of word-stems: verif*, confirm*, activat*, validat*, code, pin, otp, passcode) decides whether the message is 'about verification' at all before a bare digit sequence is read as a code, a natural-language topic guess the email/google PORT row does not call out as JEV. Flagged for the coordinator. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/email/imap-open.ts:163` | classifyServerRefusal() falls back to three regex phrase lists (TRANSIENT_WORDING, AUTH_WORDING, MAILBOX_WORDING) to guess whether an ambiguous IMAP server refusal, one with no structured RFC response code, means the server is busy, the credential was rejected, or the mailbox is missing | dispatch pattern: when no RFC response code is present, read the server's refusal text as a choice among {server-unavailable, authentication-rejected, mailbox-unavailable}; keep the RFC-code lookup (lines 159-161) as code |
| `sdk/src/platform/email/style-reply.ts:102` | mostFrequent picks the user's habitual greeting and sign-off by counting, for each candidate token in a fixed priority list (GREETING_TOKENS, SIGN_OFF_TOKENS), how many prior sent messages contain it as a lowercased substring, and taking the highest count | a choice question over the corpus of prior sent messages: which of the candidate greetings (or sign-offs) best matches this user's habitual style |
| `sdk/src/platform/email/style-reply.ts:123` | classifyTone decides formal/casual/neutral by counting how many FORMAL_TOKENS versus CASUAL_TOKENS substrings appear across the user's prior sent message bodies and comparing the two counts | a choice question over the corpus of prior sent messages: is this user's writing style formal, casual, or neutral |
| `sdk/src/platform/google/connection-proof.ts:51` | isScopeRefusal() regex-matches the Google API error text for 'insufficient (authentication) scopes' or 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' (gated on HTTP 403) to decide the credential is missing a scope | select pattern: choose among {scope-refusal, service-disabled, other} from the status code and error text, replacing the two regex checks below |
| `sdk/src/platform/google/connection-proof.ts:56` | isServiceDisabled() regex-matches the error text for 'has not been used in project'/'is disabled'/'SERVICE_DISABLED'/'accessNotConfigured' to decide the Cloud project has the API turned off | folded into the same select pattern as isScopeRefusal above |
| `sdk/src/platform/google/connection.ts:181` | refreshFn() regex-matches the token-refresh error text for 'invalid_grant/expired/revoked' to decide the grant is dead (needing a person) rather than a transient failure worth retrying | coarsen pattern: classify the refresh-failure text as grant-invalid vs transient with confidence, in place of the single regex |
| `sdk/src/platform/google/console-flow.ts:92` | projectNotSelectedNeeded() is triggered by PROJECT_NOT_SELECTED_TEXT, four synonym regex phrasings ('select a project'/'no project selected'/'create a project to continue'/'select an existing project'), guessing that the console page is asking for a Cloud project to be selected | existence pattern: check whether the rendered page state matches the known 'no project selected' condition, replacing the synonym list |
| `sdk/src/platform/google/grant-diagnosis.ts:82` | diagnoseInvalidGrant() runs an ordered chain of checks: a deterministic account-string comparison first, then two regex reads of Google's free-text error ('expired or revoked/token has been revoked/account has been deleted/user rescinded' for revoked, and 'client/unauthorized_client/mismatch' for client-mismatch), to pick the most likely failure cause | ladder pattern: keep the account-mismatch and testing-expiry rungs as code (they come from known structured values), replace the free-text rungs (revoked, client-mismatch) with a Jev read of the Google error text choosing among {revoked, client-mismatch, unknown} |
| `sdk/src/platform/google/verification-extraction.ts:67` | VERIFICATION_CONTEXT, a regex of word stems (verif*, confirm*, activat*, validat*, code, pin, otp, passcode), gates extractCode's bare-digit fallback (line 144): a standalone 6-8 digit run is only read as a verification code when this regex matches somewhere in the message body, otherwise any account number or amount would be misread as a code | a yes/no question over the message body: is this message about verifying a signup or login at all, before treating a bare number in it as a code |

## embed

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/embed/session.ts` | PORT | embed/session.ts The thin, in-process embedding facade over the existing daemon boot factory. |

## error contract

| File | Disposition | Note |
|---|---|---|
| `daemon-sdk/src/error-response.ts` | PORT | Builds the structured daemon error response body and infers an error category from HTTP status, error code, or message text. |
| `errors/src/daemon-error-contract.ts` | PORT | Wire-level daemon error category/source string-literal unions and the StructuredDaemonErrorBody shape, plus the MEMORY_RECORD_NOT_FOUND sentinel code. |
| `errors/src/error-codes.ts` | PORT | Canonical SDKErrorCode string-literal union, its runtime SDKErrorCodes mirror, and isErrorCode/isKnownErrorCode membership helpers. |
| `errors/src/index.ts` | PORT | GoodVibesSdkError class hierarchy (ConfigurationError, ContractError, HttpStatusError) with deterministic HTTP-status-to-category-to-code lookup tables (inferCategory, inferCodeFromStatus, inferCodeFromCategory); fixed numeric-status mapping, not natural-language guesswork, so not a decision point. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `daemon-sdk/src/error-response.ts:133` | BILLING_MESSAGE_PATTERN, a regex of billing-failure phrases (credit balance, insufficient credit/quota/funds, out of credits, payment required, plans and billing), tested against the lowercased message inside inferCategory (lines 157-158) to decide whether a 400 or 429 status really means a spent account rather than a plain bad request or rate limit | a choice question over the error message text: billing versus the status's default category (bad_request for 400, rate_limit for 429) |
| `daemon-sdk/src/error-response.ts:187` | inferCategoryFromMessage: when no HTTP status or known error code is available, a ladder of regex phrase lists (auth/token/credential, forbidden/access denied, billing/credits/quota, rate limit/throttl, timeout, network codes, not found, bad request, protocol) tests the lowercased message and guesses one of ten categories | a dispatch pattern: route the error message text to one of the same ten named categories (authentication, authorization, billing, rate_limit, timeout, network, not_found, bad_request, protocol, unknown) |

## events

| File | Disposition | Note |
|---|---|---|
| `sdk/src/events/agents.ts` | PORT | Typed union of agent lifecycle event payloads and the agent usage shape; type definitions only, no logic. |
| `sdk/src/events/automation.ts` | PORT | Typed automation event union and fixed schedule-kind/outcome literal sets; type definitions only. |
| `sdk/src/events/communication.ts` | PORT | Typed inter-agent communication event union (directive, status, question, etc.); type definitions only. |
| `sdk/src/events/compaction.ts` | PORT | Typed compaction lifecycle event union; type definitions only. |
| `sdk/src/events/config.ts` | PORT | Typed config-change event union and config value/scope types; type definitions only. |
| `sdk/src/events/contracts/agent-mcp.ts` | PORT | Structural field validators for agent and MCP event payloads; deterministic type/shape checks, not meaning guesses. |
| `sdk/src/events/contracts/automation-route.ts` | PORT | Structural field validators for automation, route, control-plane, delivery, watcher and surface event payloads; deterministic type/shape checks. |
| `sdk/src/events/contracts/shared.ts` | PORT | Shared validator primitives (isString, isNumber, isBoolean, isObject) and the generic field-spec validator and envelope validator; deterministic type checks. |
| `sdk/src/events/contracts.ts` | PORT | Registers per-event-type structural validators and looks one up by event type; deterministic schema validation, not meaning guesswork. |
| `sdk/src/events/contracts/turn-tool.ts` | PORT | Structural field validators for turn and tool event payloads; deterministic type/shape checks. |
| `sdk/src/events/control-plane.ts` | PORT | Typed control-plane event union and fixed client/transport/principal-kind literal sets; type definitions only. |
| `sdk/src/events/deliveries.ts` | PORT | Typed delivery event union and fixed delivery-kind literal set; type definitions only. |
| `sdk/src/events/domain-map.ts` | PORT | Union of every runtime event type and the per-domain event-type map used to route events to listeners; type definitions only. |
| `sdk/src/events/fleet.ts` | PORT | Typed fleet-view event union and fixed node-kind/state/attention-reason literal sets; type definitions only. |
| `sdk/src/events/forensics.ts` | PORT | Typed forensics-report event union; type definitions only. |
| `sdk/src/events/index.ts` | PORT | Barrel export re-exporting every event domain module; no logic. |
| `sdk/src/events/knowledge.ts` | PORT | Typed knowledge-subsystem event union (ingest, review, consolidation, etc.); type definitions only, the judgment itself lives in the knowledge subsystem that emits these events. |
| `sdk/src/events/mcp.ts` | PORT | Typed MCP lifecycle event union; type definitions only. |
| `sdk/src/events/mcp-types.ts` | PORT | Fixed literal sets for MCP server role, trust mode and quarantine reason; type definitions only. |
| `sdk/src/events/ops.ts` | PORT | Typed ops-intervention event union and fixed intervention-reason literal set; type definitions only. |
| `sdk/src/events/orchestration.ts` | PORT | Typed orchestration task-contract and event union; type definitions only. Per the intent, this domain is renamed to the contract runner's contract domain but the file itself carries no decision logic. |
| `sdk/src/events/permissions.ts` | PORT | Typed permission-evaluation event union; type definitions only. Per the intent, this domain is renamed to the judgment domain but the file itself carries no decision logic. |
| `sdk/src/events/planner.ts` | PORT | Typed planner-decision and work-plan-task event shapes (StrategyCandidate scores, reasonCode strings); type definitions only, no scoring logic. Per the intent, this domain is renamed to the gate domain. |
| `sdk/src/events/plugins.ts` | PORT | Typed plugin discovery/lifecycle event union; type definitions only. |
| `sdk/src/events/providers.ts` | PORT | Typed provider event union; type definitions only. |
| `sdk/src/events/routes.ts` | PORT | Typed route-binding event union and fixed surface/target-kind literal sets; type definitions only. |
| `sdk/src/events/security.ts` | PORT | Typed security event union (scope violations, taint, etc.); type definitions only, the checks themselves live in the security subsystem which stays deterministic. |
| `sdk/src/events/session.ts` | PORT | Typed session lifecycle event union; type definitions only. |
| `sdk/src/events/surfaces.ts` | PORT | Typed surface event union and fixed surface-kind literal sets (transport, product, channel); type definitions only. |
| `sdk/src/events/tasks.ts` | PORT | Typed task-queue event union; type definitions only. |
| `sdk/src/events/tools.ts` | PORT | Typed tool-call event union and tool result summary shape; type definitions only. |
| `sdk/src/events/transport.ts` | PORT | Typed transport lifecycle event union; type definitions only. |
| `sdk/src/events/turn.ts` | PORT | Typed turn lifecycle event union and fixed stop-reason literal set; type definitions only. |
| `sdk/src/events/ui.ts` | PORT | Typed UI render event union; type definitions only. |
| `sdk/src/events/watchers.ts` | PORT | Typed watcher event union and fixed watcher-source-kind literal set; type definitions only. |
| `sdk/src/events/workflows.ts` | PORT | Typed WRFC workflow event union and fixed workflow-state literal set; type definitions only. Superseded conceptually by the contract runner per the intent, but the file itself is only event types. |
| `sdk/src/events/workspace.ts` | PORT | Typed workspace swap/checkpoint event union; type definitions only. |

## gate (replaces permissions)

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/agents/background-permission-gate.ts` | JEV | Gates tool calls made by background agents through the permission manager; becomes part of the gate. |
| `sdk/src/platform/permissions/analysis.ts` | JEV | Builds a PermissionRequestAnalysis for exec, fetch, path and delegate tool calls, guessing classification, risk level and side effects from command text and paths. |
| `sdk/src/platform/permissions/approval-rules.ts` | JEV | Builds and matches durable remember-tier policy rules (exact command, command class, path, tool) from structured tool call arguments; deterministic string and prefix matching, no free-text guessing. |
| `sdk/src/platform/permissions/briefs/build.ts` | JEV | Builds the human-facing approval brief (title, checklist, subject) by looking up a risk family already classified elsewhere through fixed dictionaries and switches over a closed set of family names. |
| `sdk/src/platform/permissions/briefs/render-hints.ts` | JEV | One-line string formatter combining a brief's headline and subject label for display; no decision logic. |
| `sdk/src/platform/permissions/briefs/types.ts` | JEV | Pure type definition for the approval brief shape; no behavior. |
| `sdk/src/platform/permissions/credential-read-defaults.ts` | JEV | Matches a read path against a fixed list of well-known credential file globs (ssh keys, cloud credentials, browser login stores) to decide whether the shipped default gates the read; deterministic glob matching against known paths, not guesswork over prose. |
| `sdk/src/platform/permissions/denial.ts` | JEV | Builds the structured ToolDenial and its explanatory error string for a refused tool call from a known reason code; deterministic string construction, no classification. |
| `sdk/src/platform/permissions/index.ts` | JEV | Barrel re-export of the permissions module's public surface. |
| `sdk/src/platform/permissions/manager.ts` | JEV | The permission gate's core: checkDetailed routes every tool call through auto-approve, mode-based rules, the session cache, durable user rules and the ask prompt, in priority order. |
| `sdk/src/platform/permissions/mode-change-emitter.ts` | JEV | Subscribes to permissions.mode config changes and emits a PERMISSION_MODE_CHANGED runtime event; pure wiring, no decision. |
| `sdk/src/platform/permissions/plan-mode-instructions.ts` | JEV | Holds the fixed plan-mode standing instruction text and appends it to the system prompt when plan mode is active; static text, no decision. |
| `sdk/src/platform/permissions/prompt.ts` | JEV | Type definitions for the permission ask request, its attribution variants, and the human decision shape; no behavior. |
| `sdk/src/platform/permissions/types.ts` | JEV | Type definitions for permission categories, risk levels, decision sources and reason codes, and the analysis and check-result shapes; no behavior. |
| `sdk/src/platform/permissions/user-rule-store.ts` | JEV | Persists durable user-origin permission rules to a per-project JSON file with queued atomic writes; plain storage, no decision. |
| `sdk/src/platform/runtime/client/approval-raiser.ts` | JEV | Client-side seam that raises a permission ask on the daemon and prompts locally at the same time, taking whichever answer settles first and writing the local decision back to the daemon's record. |
| `sdk/src/platform/runtime/mcp/permissions.ts` | JEV | MCP per-server permission manager: tracks trust level and per-tool overrides, and evaluates each tool call's risk by inferring its capability class from the tool name and arguments, then applying deterministic role/scope/trust-mode rules to allow, ask, or deny it; matches the intent's side-effect and risk-family batteries for the gate. |
| `sdk/src/platform/runtime/permissions/decision-log.ts` | JEV | DecisionLog: an in-memory bounded circular buffer recording every permission decision for debugging and compliance audit. |
| `sdk/src/platform/runtime/permissions/decision-otlp.ts` | JEV | Export-only mapping of DecisionLog records to OTLP span/log wire shapes, POSTed to a configured collector; no ingestion or judgment, pure format translation. |
| `sdk/src/platform/runtime/permissions/divergence-dashboard.ts` | JEV | Wraps the permission simulator to produce divergence trend history and an enforcement gate that blocks a switch to enforce mode when the divergence rate exceeds a configured threshold; passive, reads only. |
| `sdk/src/platform/runtime/permissions/evaluator.ts` | JEV | LayeredPolicyEvaluator: the core runtime permission decision engine, evaluating a tool call through mode, safety, and policy-rule layers; tool classification is by fixed closed-set membership (built-in tool names), not text judgment. |
| `sdk/src/platform/runtime/permissions/exec-prompt-wiring.ts` | JEV | Turns a detected exec PTY terminal prompt into a PermissionPromptRequest so it rides the same approval broker as a tool permission ask. |
| `sdk/src/platform/runtime/permissions/index.ts` | JEV | Public API barrel for the runtime permissions module: evaluator, sandbox policy, decision log, rule evaluators, safety checks, and the factory function. |
| `sdk/src/platform/runtime/permissions/lint.ts` | JEV | Static lint checks over a policy config for overly broad rules (e.g. an allow-all rule active in allow-all mode, a wildcard prefix rule with no command scoping); deterministic checks against fixed rule fields. |
| `sdk/src/platform/runtime/permissions/localhost-fetch-approval.ts` | JEV | The one-tap 'allow for this project' ask for fetches to loopback dev servers, riding the shared approval broker and persisting the answer to project settings. |
| `sdk/src/platform/runtime/permissions/normalization/ast.ts` | JEV | Shell AST node types (command/pipe/sequence/subshell) preserving operator structure for per-segment policy evaluation. |
| `sdk/src/platform/runtime/permissions/normalization/canonicalizer.ts` | JEV | Resolves raw command tokens to a canonical bare command name, stripping path prefixes, env-var assignments, and quoting. |
| `sdk/src/platform/runtime/permissions/normalization/classifier.ts` | JEV | Assigns a read/write/network/escalation/destructive classification to each command segment from fixed sets of well-known command binaries and subcommands, and detects the frozen catastrophic-command patterns (rm -rf /, dd to a raw device, fork bomb); this is the deterministic catastrophic-list boundary the intent keeps as code, not the risk-family judgment. |
| `sdk/src/platform/runtime/permissions/normalization/index.ts` | JEV | Barrel export and entry point (normalizeCommand) for the tokenize -> segment -> classify command normalization pipeline. |
| `sdk/src/platform/runtime/permissions/normalization/parser.ts` | JEV | Shell grammar parser converting a flat token list into a ShellNode AST, preserving compound-command operator structure (&&, //, ;, /, subshells). |
| `sdk/src/platform/runtime/permissions/normalization/segmenter.ts` | JEV | Splits a token list into CommandSegments at compound-command boundaries (&&, //, ;, /), resolving each segment's command name, args, and flags. |
| `sdk/src/platform/runtime/permissions/normalization/tokenizer.ts` | JEV | Converts a raw shell command string into an ordered token list, handling quoting, operators, variable expansion, subshells, and flags, with input-length and token-count safety caps. |
| `sdk/src/platform/runtime/permissions/normalization/types.ts` | JEV | Token, segment, classification, and normalized-command types for the command normalization pipeline. |
| `sdk/src/platform/runtime/permissions/normalization/verdict.ts` | JEV | Evaluates policy per shell-AST segment and aggregates a final compound verdict with per-segment structured denial reasons. |
| `sdk/src/platform/runtime/permissions/permission-composition.ts` | JEV | Composition root for the permission side of a runtime graph: the durable rule store, the permission manager over one ask seam, the three handlers (sandbox escalation, exec prompt, loopback fetch) sharing that seam, and the once-per-run containment receipt. |
| `sdk/src/platform/runtime/permissions/policy-config-loader.ts` | JEV | Loads a config-declared policy bundle file into the policy registry as a candidate at startup when policy-as-code is enabled; never auto-promotes. |
| `sdk/src/platform/runtime/permissions/policy-loader.ts` | JEV | Wraps raw policy bundle loading with signature validation, rejecting invalid/missing signatures in managed mode and marking unsigned bundles for non-managed mode. |
| `sdk/src/platform/runtime/permissions/policy-registry.ts` | JEV | Policy-as-Code registry managing versioned bundle promote/rollback lifecycle (loaded -> simulating -> promoting -> active), gated on simulation evidence and a passing divergence check. |
| `sdk/src/platform/runtime/permissions/policy-runtime.ts` | JEV | Wires the policy registry, divergence dashboard, policy diagnostics panels, lint, simulation, and preflight together, and keeps a bounded permission audit trail. |
| `sdk/src/platform/runtime/permissions/policy-signer.ts` | JEV | HMAC-SHA256 signing and verification of policy bundles for integrity/provenance, checked before the evaluator processes any rules. |
| `sdk/src/platform/runtime/permissions/preflight.ts` | JEV | Policy preflight review types and status for MCP server trust posture (pass/warn/block) built from lint findings. |
| `sdk/src/platform/runtime/permissions/risk-language.ts` | JEV | Static per-risk-family checklist text explaining what a human should confirm before approving; a lookup table keyed by the family risk-model.ts already classified, not itself a classifier. |
| `sdk/src/platform/runtime/permissions/risk-model.ts` | JEV | classifyPermissionRiskFamily assigns a permission request to one of sixteen risk families (delegation, shell-mutation, dependency-install, sandbox-policy-change, etc.); this is the risk-family classification the intent names as a battery. |
| `sdk/src/platform/runtime/permissions/rules/arg-shape.ts` | JEV | Policy rule evaluator matching a tool call's argument key/value pairs (literal or regex) against a user-authored ArgShapeRule. |
| `sdk/src/platform/runtime/permissions/rules/index.ts` | JEV | Barrel export for the policy rule evaluators (prefix, arg-shape, path-scope, network-scope, mode-constraint). |
| `sdk/src/platform/runtime/permissions/rules/mode-constraint.ts` | JEV | Policy rule evaluator that activates only when a specific permission mode is the active one. |
| `sdk/src/platform/runtime/permissions/rules/network-scope.ts` | JEV | Policy rule evaluator restricting network-capable tool calls by hostname glob pattern, with host trust tier classification. |
| `sdk/src/platform/runtime/permissions/rules/path-scope.ts` | JEV | Policy rule evaluator restricting file-path tool calls by glob-style path pattern. |
| `sdk/src/platform/runtime/permissions/rules/prefix.ts` | JEV | Policy rule evaluator matching a tool call by tool name and an optional literal command prefix of its first string argument. |
| `sdk/src/platform/runtime/permissions/rule-suggestions.ts` | JEV | Groups repeated permission denials by tool+target and suggests a durable scoped rule when the same denial recurs twice or more; deterministic grouping and counting. |
| `sdk/src/platform/runtime/permissions/safety-checks.ts` | JEV | The bypass-immune safety layer: fixed destructive-command-prefix, dangerous-shell-pattern, path-escape, and destructive-SQL-pattern checks that cannot be disabled by mode or policy. This is the frozen catastrophic-command list the intent keeps as code, not judged. |
| `sdk/src/platform/runtime/permissions/sandbox-escalation.ts` | JEV | Turns a sandbox host-access escalation into a PermissionPromptRequest on the shared approval broker, optionally annotated or auto-approved by the sandbox-judgment tier; never converts an allow into a deny. |
| `sdk/src/platform/runtime/permissions/sandbox-escalation-wiring.ts` | JEV | Composition-root wiring for the sandbox-escalation approval seam plus the optional model-judgment tier and its provider adapter. |
| `sdk/src/platform/runtime/permissions/sandbox-judgment.ts` | JEV | The optional model-judgment tier for a sandboxed command still on 'ask': builds a free-text prompt describing the command, sandbox plan, and escalations, and parses the model's reply into a looks-safe/flags-risk verdict that can annotate or, opt-in, auto-approve the ask. Never touches the frozen catastrophic block or converts an allow to a deny. |
| `sdk/src/platform/runtime/permissions/sandbox-policy.ts` | JEV | Decides whether an exec that would otherwise prompt can auto-allow because it runs entirely inside the OS sandbox boundary, using the deterministic command-normalization pipeline (not text judgment); never relaxes the frozen catastrophic block. |
| `sdk/src/platform/runtime/permissions/simulation-scenarios.ts` | JEV | Type definitions for a policy simulation scenario and its actual-vs-simulated-vs-authoritative decision comparison result. |
| `sdk/src/platform/runtime/permissions/simulation.ts` | JEV | PermissionSimulator runs an actual and a candidate LayeredPolicyEvaluator in parallel per call, tracking divergence counts by tool class, command prefix and simulation mode for the enforcement gate. |
| `sdk/src/platform/runtime/permissions/types.ts` | JEV | Core types for the layered permission evaluator: modes, decisions, reason codes, classification, policy rule shapes, and per-step evaluation trace. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/permissions/analysis.ts:39` | SECRET_NAME_PATTERN and INLINE_SECRET_PATTERN regexes match command text against secret-name keywords and known token shapes (Bearer, ghp_, sk-, AIza, xox) to guess whether a command exposes a credential | sandbox-advisory battery: yes/no question, does this command expose secret or credential material, banded act/confirm/escalate |
| `sdk/src/platform/permissions/analysis.ts:61` | pathLooksSensitive uses a regex over the path string to guess whether a path names a secret or credential file | sandbox-advisory battery: yes/no question, is this path likely to hold secrets or credentials |
| `sdk/src/platform/permissions/analysis.ts:96` | analyzeExec combines secret warnings and the command classification through an if/else chain into one hand-picked risk band (low/medium/high/critical) | risk-family battery: score-on-rubric scoring the side-effect surface of a shell command, banded act/confirm/escalate, in place of the if/else chain |
| `sdk/src/platform/permissions/analysis.ts:156` | analyzeFetch maps a host trust tier string (blocked/unknown/other) to a risk level through a hand-picked ternary | risk-family battery: score-on-rubric scoring the network side effect (host trust, egress), banded act/confirm/escalate |
| `sdk/src/platform/permissions/manager.ts:187` | checkDetailed nested if/else on the mode string (allow-all/plan/accept-edits/custom/prompt) and the category string (read/write/execute/delegate) hardcodes which calls auto-approve, prompt, or deny, independent of any computed stakes score | side-effect and risk-family batteries score each call's stakes; permission modes become presets over that stakes table (bands act/confirm/escalate) in place of the hardcoded per-mode/category matrix |
| `sdk/src/platform/runtime/mcp/permissions.ts:65` | inferCapability() keyword-matches the lower-cased tool name and its path/url arguments ('secret', 'write'/'edit'/'save'/'patch', 'read'/'list'/'grep'/'search', 'exec'/'shell'/'run'/'command', 'spawn'/'delegate'/'agent', 'config'/'settings', 'git' plus 'commit'/'push'/'merge', and a URL-scheme check for network read vs write) to guess which capability class a tool call belongs to | side-effect risk-family battery: a choice-over-options reading of the tool call's capability class (secret_read/write_fs/read_fs/exec/spawn_agent/config_mutation/system_mutation/network_read/network_write/generic) with confidence bands, replacing the keyword list; the role/scope/trust-mode rules that consume the result (roleAllowsCapability, severityForPosture, verdictForPosture) stay as code |
| `sdk/src/platform/runtime/permissions/risk-model.ts:39` | classifyPermissionRiskFamily picks one of sixteen risk families via a cascading chain of regex and substring matches over the tool name, its arguments, and the target path or shell command text (e.g. a regex for npm/pnpm/yarn/bun install commands, path regexes for config-like files and plugin directories) | risk-family battery: a choice-over-options reading that picks the risk family from the closed set, replacing the regex/string-match cascade |
| `sdk/src/platform/runtime/permissions/sandbox-judgment.ts:92` | a free-text prompt asks a model whether a sandboxed command that needs host access looks safe, and createSandboxJudgmentProvider parses the reply by regex-extracting a JSON object and reading its 'verdict' field | sandbox-advisory battery: a yes/no (looks-safe vs flags-risk) reading with stated reasons over the command, sandbox plan and policy reasons, replacing the ad hoc prompt-and-regex-parse |

## hooks, workflow, triggers, watchers

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/hooks/activity.ts` | PORT | Exports HookActivityRecord, HookActivityTracker. |
| `sdk/src/platform/hooks/chain-engine.ts` | PORT | Parse a duration string like "30s" or "5m" into milliseconds |
| `sdk/src/platform/hooks/contracts.ts` | PORT | Exports HookExecutionMode, HookAuthority, HookPointContract, listHookPointContracts, getHookPointContract, parseHookPath. |
| `sdk/src/platform/hooks/dispatcher.ts` | PORT | Loads hooks.json, matches event patterns and matchers, and fires matching hook runners (command/prompt/agent/http/ts) with a global timeout. VALID_HOOK_TYPES is a fixed schema enum; the intent table marks this subsystem model-free by design, and no natural-language guesswork was found here. |
| `sdk/src/platform/hooks/hook-api.ts` | PORT | Thin API surface over the hook dispatcher and workbench (contract search, scaffold/toggle/remove hook, simulate). contracts(filter) does a literal case-insensitive substring search over pattern/description/authority/executionMode fields, a search-box filter, not a meaning classification. |
| `sdk/src/platform/hooks/index.ts` | PORT | Exports createHookDispatcher. |
| `sdk/src/platform/hooks/matcher.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/hooks/runners/agent.ts` | PORT | Agent hook runner, spawns a subagent via AgentManager and waits for completion up to the hook's configured timeout. |
| `sdk/src/platform/hooks/runners/command.ts` | PORT | SECURITY MODEL, TRUST BOUNDARY Hook commands are user-defined and execute with full process privileges via `sh -c <command>`. |
| `sdk/src/platform/hooks/runners/http.ts` | PORT | HTTP hook runner. |
| `sdk/src/platform/hooks/runners/prompt.ts` | PORT | Prompt hook runner, sends event data to an LLM via ToolLLM. |
| `sdk/src/platform/hooks/runners/typescript.ts` | PORT | Expected shape of a TypeScript hook module's default export |
| `sdk/src/platform/hooks/runner.ts` | PORT | Exports HookRunnerContext, run. |
| `sdk/src/platform/hooks/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/hooks/workbench.ts` | PORT | Exports HookAuthoringAction, HookSimulationResult, HookConfigInspection, HookWorkbenchOptions, HookWorkbench, createHookWorkbench. |
| `sdk/src/platform/triggers/extract.ts` | PORT | extract.ts, turning a probe result into one observation. |
| `sdk/src/platform/triggers/grants.ts` | PORT | grants.ts, pre-registered, digest-pinned action grants. |
| `sdk/src/platform/triggers/hosts.ts` | PORT | hosts.ts, the real effects behind the trigger family's ports. |
| `sdk/src/platform/triggers/index.ts` | PORT | The trigger family: stream watchers, model-free condition checks, and one-shot on-exit process-lifecycle triggers over one supervision spine. |
| `sdk/src/platform/triggers/manager-streams.ts` | PORT | manager-streams.ts, the stream watcher kind's lifecycle. |
| `sdk/src/platform/triggers/manager.ts` | PORT | manager.ts, the trigger supervisor. |
| `sdk/src/platform/triggers/manager-types.ts` | PORT | manager-types.ts, the ports and configuration surface of the trigger supervisor. |
| `sdk/src/platform/triggers/probes.ts` | PORT | Runs one declarative trigger probe (http, file, command argv, or sdk-tool) with injectable IO and returns the raw captured value for the extractor to narrow; the scan flag (a yes/no reading of text) is the http capture returning response.ok, a structured boolean field, not a parsed natural-language reply, so there is no decision point. |
| `sdk/src/platform/triggers/process-triggers.ts` | PORT | One-shot on-exit process-lifecycle triggers: launches and tracks a supervised process, classifies its termination (exited/signalled/timed-out/unknown) from structured exit code, signal and timeout fields, and renders the default agent prompt; classify() and decideOnExitRecovery() are deterministic decision trees over measured process state, not a guess over meaning, so there is no decision point. |
| `sdk/src/platform/triggers/rules.ts` | PORT | rules.ts, the v1 predicate set, evaluated as pure functions over the state ring buffer each trigger already persists. |
| `sdk/src/platform/triggers/store.ts` | PORT | store.ts, persistence for the trigger family, with recovery housekeeping. |
| `sdk/src/platform/triggers/stream-watchers.ts` | PORT | stream-watchers.ts, watching the output of a long-lived command. |
| `sdk/src/platform/triggers/supervision.ts` | PORT | supervision.ts, the spine all three watcher kinds share. |
| `sdk/src/platform/triggers/types.ts` | PORT | types.ts, the declarative trigger DSL and its record shapes. |
| `sdk/src/platform/triggers/validation.ts` | PORT | Validates the declarative trigger DSL (probes, extracts, rules, fire actions) against closed kind sets and fixed-format patterns (JSONPath subset, jq subset, regex source, argv), rejecting anything that looks like code (js/eval/shell probe or action kinds) by name; the kind sets and rejected-kind maps are a closed schema check, not meaning guesswork over prose, so there is no decision point. |
| `sdk/src/platform/watchers/index.ts` | PORT | Re-exports ./registry.js, ./store.js. |
| `sdk/src/platform/watchers/registry.ts` | PORT | `watchers.recoveryWindowMinutes`, read at each use. |
| `sdk/src/platform/watchers/store.ts` | PORT | What the `.why` receipt tells a human who finds a quarantined watcher snapshot: nothing needs doing, the state comes back on its own. |
| `sdk/src/platform/workflow/index.ts` | PORT | Re-exports ./trigger-executor.js, ./work-plan-store.js. |
| `sdk/src/platform/workflow/trigger-executor.ts` | PORT | TriggerExecutor: matches hook events against registered trigger patterns, evaluates each trigger's optional condition with a restricted boolean-expression parser (dotted property paths on event/payload, comparison and logical operators, no eval or new Function), then spawns the action command; the condition language is a deterministic, closed-grammar expression evaluator over structured event data, not a meaning guess over prose, so there is no decision point. |
| `sdk/src/platform/workflow/work-plan-store.ts` | PORT | Age TTL for TERMINAL (done/cancelled) items. |

## hosted sessions

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/hosted-sessions/attachments.ts` | JEV | Attachment handling for a hosted session (the daemon's own conversation loop). No natural-language guesswork found. |
| `sdk/src/platform/hosted-sessions/exec-posture.ts` | JEV | Resolves a hosted session's exec containment posture (conversational vs workstream) from a product-supplied decider function, defaulting to the safer conversational posture on any error. Deterministic dispatch over a two-value enum; no guesswork found. |
| `sdk/src/platform/hosted-sessions/index.ts` | JEV | Barrel export for the hosted-sessions package; no logic. |
| `sdk/src/platform/hosted-sessions/liveness-probe.ts` | JEV | Probes whether a hosted session's loop is still alive. No guesswork found. |
| `sdk/src/platform/hosted-sessions/manager.ts` | JEV | The hosted-session manager: create, restore and dispose sessions, own the workspace floor and per-session model routing. This is the daemon host the intent table says becomes the contract runner's daemon host. No natural-language guesswork found in this file itself. |
| `sdk/src/platform/hosted-sessions/model-route.ts` | JEV | Per-session model selection view over the shared ProviderRegistry. resolveHostedModelDefinition refuses an unknown or unselectable model reference by construction rather than guessing; no guesswork found. |
| `sdk/src/platform/hosted-sessions/session-runtime.ts` | JEV | Runs one hosted session's conversation loop. No natural-language guesswork found. |
| `sdk/src/platform/hosted-sessions/spine-intake.ts` | JEV | Registers a hosted session onto the shared session spine and drains queued steer/follow-up inputs into the loop, retrying a failed delivery up to a fixed attempt cap (a deterministic counter, not a failure-transience classification). No guesswork found. |
| `sdk/src/platform/hosted-sessions/store.ts` | JEV | Persists hosted-session records. SAFE_ID is a fixed id-shape validator, not natural-language guesswork. |
| `sdk/src/platform/hosted-sessions/types.ts` | JEV | Type definitions for hosted sessions; no logic. |
| `sdk/src/platform/hosted-sessions/workspace-floor.ts` | JEV | Manages the workspace lease ('floor') a hosted session runs on. No guesswork found. |

## intelligence, git, workspace

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/git/index.ts` | PORT | Re-exports ./service.js, ./structured-diff.js. |
| `sdk/src/platform/git/optional-simple-git.ts` | PORT | optional-simple-git.ts, the one place `simple-git` is reached. |
| `sdk/src/platform/git/service.ts` | PORT | Wraps simple-git with hook emission (Pre/Post/Fail) on mutating operations (commit, push, pull, merge, checkout, stash, worktree add/remove); extracts conflict paths from merge output as a fallback to the library's structured conflict list. |
| `sdk/src/platform/git/structured-diff.ts` | PORT | Parses raw unified-diff text into a complete structured per-file/per-hunk form with no size cap, and reconstructs it losslessly for round-trip verification. Pure fixed-format parsing of git's own diff output; no meaning judgment. |
| `sdk/src/platform/intelligence/config.ts` | PORT | Per-language configuration for CodeIntelligence. |
| `sdk/src/platform/intelligence/facade.ts` | PORT | CodeIntelligence, unified facade over tree-sitter and LSP services. |
| `sdk/src/platform/intelligence/import-graph.ts` | PORT | Import graph for TypeScript/JavaScript files. |
| `sdk/src/platform/intelligence/index.ts` | PORT | CodeIntelligence public API. |
| `sdk/src/platform/intelligence/lsp/binary-downloader.ts` | PORT | Downloads and verifies LSP server binaries. No guesswork found. |
| `sdk/src/platform/intelligence/lsp/capabilities.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/intelligence/lsp/client.ts` | PORT | Start the LSP server process. |
| `sdk/src/platform/intelligence/lsp/index.ts` | PORT | Re-exports ./capabilities.js, ./client.js, ./protocol.js, ./service.js. |
| `sdk/src/platform/intelligence/lsp/protocol.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/intelligence/lsp/service.ts` | PORT | Resolve a server command: check node_modules/.bin/ first (bundled), then fall back to system PATH via Bun.which(). |
| `sdk/src/platform/intelligence/tree-sitter/embedded-wasm.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/intelligence/tree-sitter/index.ts` | PORT | Tree-sitter intelligence module. |
| `sdk/src/platform/intelligence/tree-sitter/languages.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/intelligence/tree-sitter/queries.ts` | PORT | Tree-sitter query helpers for symbol extraction, outline generation, and scope detection. |
| `sdk/src/platform/intelligence/tree-sitter/service.ts` | PORT | TreeSitterService, Grammar loading, parsing, and tree caching. |
| `sdk/src/platform/runtime/worktree/registry.ts` | PORT | Persisted registry of managed git worktrees: lists, reconciles, creates, prunes and tombstones worktree records, and classifies a worktree's kind and owner from its filesystem path shape. |
| `sdk/src/platform/workspace/checkpoint/cross-process-lock.ts` | PORT | cross-process-lock.ts, a file-based mutual-exclusion lock for a single directory, shared by every process that touches it. |
| `sdk/src/platform/workspace/checkpoint/index.ts` | PORT | checkpoint/index.ts Public barrel for the workspace checkpoint engine. |
| `sdk/src/platform/workspace/checkpoint/manager-options.ts` | PORT | manager-options.ts, the public option/filter shapes for WorkspaceCheckpointManager (manager.ts), split out to keep manager.ts under the repo's 800-line file cap. |
| `sdk/src/platform/workspace/checkpoint/manager.ts` | PORT | WorkspaceCheckpointManager: whole-workspace git-backed snapshot create/list/diff/restore/gc, automatic snapshotting on turn/agent lifecycle bus events, retention sweeps, and root-guard refusal for an over-broad workspace; pure deterministic bookkeeping over git objects and a JSON manifest, no meaning guessing. |
| `sdk/src/platform/workspace/checkpoint/pruner.ts` | PORT | pruner.ts `WorkspaceCheckpointPruner`, the `Pruner` implementation `RetentionPolicy` drives to enforce retention limits on workspace checkpoints. |
| `sdk/src/platform/workspace/checkpoint/root-guard.ts` | PORT | root-guard.ts Pure helpers and constants for WorkspaceCheckpointManager's root-safety guards: deciding whether a resolved workspace root is too broad to snapshot, and building the honest refusal messages used both for au |
| `sdk/src/platform/workspace/checkpoint/session-changes.ts` | PORT | session-changes.ts Pure computation for `WorkspaceCheckpointManager.sessionChanges`, the aggregate file changes a single session made, joined over its sessionId-stamped checkpoints. |
| `sdk/src/platform/workspace/checkpoint/side-git.ts` | PORT | SideGitRunner: thin wrapper around a hidden side git repository (separate GIT_DIR/GIT_WORK_TREE) used for whole-workspace checkpoint storage, exposing stage/write-tree/commit-tree/diff/restore/gc as named git invocations; no meaning guessing. |
| `sdk/src/platform/workspace/checkpoint/types.ts` | PORT | types.ts Types for the workspace checkpoint engine (`WorkspaceCheckpointManager`). |
| `sdk/src/platform/workspace/daemon-home.ts` | PORT | daemon-home.ts Resolves and manages the daemon's identity home directory (`daemon.homeDir`). |
| `sdk/src/platform/workspace/hunk-revert.ts` | PORT | Reverse-applies one unified-diff hunk against the current file content, clean-or-nothing (exact line-block match at the expected or a single unambiguous location, else a conflict), with a whole-tree safety checkpoint before mutating; unified-diff parsing and exact-match search are fixed-format parsing, not a meaning guess. |
| `sdk/src/platform/workspace/index.ts` | PORT | Re-exports ./checkpoint/index.js, ./daemon-home.js, ./registration/fold-legacy-register.js, ./registration/index.js, ./registration/shared-register-path.js, ./workspace-swap-manager.js. |
| `sdk/src/platform/workspace/registration/fold-legacy-register.ts` | PORT | fold-legacy-register.ts, move the workspace register from the pre-split location into the shared tier, once, without losing a row. |
| `sdk/src/platform/workspace/registration/index.ts` | PORT | workspace/registration/index.ts Public barrel for the shared registered-workspace registry: the user-scoped store (injectable I/O), the pure path→coverage resolver, and the worktree→main-repo link probe. |
| `sdk/src/platform/workspace/registration/resolution.ts` | PORT | workspace/registration/resolution.ts The PURE resolution function and path helpers for the registered-workspace registry. |
| `sdk/src/platform/workspace/registration/shared-register-path.ts` | PORT | shared-register-path.ts, where the workspace register lives, for every product that touches it. |
| `sdk/src/platform/workspace/registration/store.ts` | PORT | workspace/registration/store.ts The daemon-side registered-workspace store (user-scoped state, injectable I/O) plus the impure worktree-link probe the resolver's git metadata comes from. |
| `sdk/src/platform/workspace/registration/types.ts` | PORT | workspace/registration/types.ts Shared shapes for the daemon-side registered-workspace registry: the roots an operator has explicitly opted into (coverage flows DOWN each root's subtree), the subtree-scoped declined prom |
| `sdk/src/platform/workspace/registration/worktree-link.ts` | PORT | workspace/registration/worktree-link.ts The impure worktree→main-repo LINK probe. |
| `sdk/src/platform/workspace/workspace-swap-manager.ts` | PORT | workspace-swap-manager.ts Manages mutable runtime.workingDir transitions. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/git/service.ts:9` | isMissingGitIdentityError() matches a commit failure's message against three known git wordings ('author identity unknown', 'please tell me who you are', 'unable to auto-detect email address') to decide whether to retry the commit with a fallback identity | coarsen pattern: classify the commit-failure text as missing-identity vs other, with confidence, in place of the three-phrase list |

## knowledge

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/knowledge/bookmarks.ts` | JEV | Parses bookmark import content (JSON bookmark trees, Netscape bookmark HTML, plain URL lists) into KnowledgeBookmarkSeed records; deterministic parsing of fixed input formats, not a decision point. |
| `sdk/src/platform/knowledge/browser-history/discover.ts` | JEV | Finds local browser profile directories on disk per browser kind by matching known path roots and a per-browser profile-name regex (a fixed, documented directory-naming pattern, not free-text guesswork) and checking for the expected history/bookmarks files. |
| `sdk/src/platform/knowledge/browser-history/index.ts` | JEV | Barrel file re-exporting the browser-history collect/ingest, discovery and reader functions and their types. |
| `sdk/src/platform/knowledge/browser-history/ingest.ts` | JEV | Aggregates raw browser history/bookmark entries by canonical URL across browsers and profiles, composes a summary and structured metadata, and upserts each aggregate as a knowledge source plus per-profile source_group nodes and edges. Deterministic aggregation and templated text. |
| `sdk/src/platform/knowledge/browser-history/locked-db.ts` | JEV | Copies a browser's live (possibly locked) SQLite file plus its -wal/-shm sidecars to a temp directory so it can be read safely, with cleanup. Deterministic file handling. |
| `sdk/src/platform/knowledge/browser-history/paths.ts` | JEV | A fixed table of known install paths, profile-directory naming patterns and history/bookmark filenames per supported browser (Chromium/Gecko/WebKit families), plus root expansion and profile-glob-to-regex helpers. Fixed reference data, not a decision point. |
| `sdk/src/platform/knowledge/browser-history/readers.ts` | JEV | Reads history and bookmark rows directly out of each browser family's own SQLite schema or plist/bplist bookmark format (Chromium, Gecko/Firefox-family, WebKit/Safari/Epiphany), decoding each browser's own fixed transition/visit-type enum tables and epoch conventions. All deterministic binary/schema parsing of documented formats. |
| `sdk/src/platform/knowledge/browser-history/types.ts` | JEV | Type definitions for browser kinds/families, profiles, history/bookmark entries and the collect filter/result shapes. |
| `sdk/src/platform/knowledge/connectors.ts` | JEV | The knowledge connector registry (register/get/list/resolve/doctor) plus the built-in url, bookmark and url-list connectors; deterministic CRUD and dispatch over a closed set of connector ids. |
| `sdk/src/platform/knowledge/consolidation.ts` | JEV | Runs the light and deep consolidation passes: scores recent usage per subject with a hand-tuned formula, proposes memory-promotion/review/source-refresh candidates above a threshold, and on deep consolidation auto-promotes into durable memory only above a second, higher threshold. |
| `sdk/src/platform/knowledge/cooperative.ts` | JEV | Cooperative-scheduling helpers (yield to the event loop every N iterations, a cancellable scheduleBackground timer, a cancellable sleep); purely deterministic timing utilities, not a decision point. |
| `sdk/src/platform/knowledge/extensions.ts` | JEV | Type-only definitions for the knowledge extension points: object profile policy, page templates, relationship resolvers and facet providers. |
| `sdk/src/platform/knowledge/extraction-policy.ts` | JEV | Decides whether a stored extraction needs refreshing (extractor version bump or unusable prior text) and whether extracted text is usable at all, by matching a fixed list of limited-extraction marker phrases and by scoring a text sample's control/extended/letter/whitespace/punctuation character ratios against four hand-tuned thresholds to guess whether it is binary garbage or a raw PDF payload rather than readable text. |
| `sdk/src/platform/knowledge/extractors.ts` | JEV | Format-specific content extraction (HTML via readability or a lightweight regex fallback, Markdown, JSON, CSV/TSV, XML, YAML, DOCX/XLSX/PPTX via zip+regex, dispatch to the PDF extractor, and a generic binary fallback); format selection by mime type or extension is deterministic, and the text/summary/excerpt trimming is fixed-length truncation, not a decision point. |
| `sdk/src/platform/knowledge/generated-pages.ts` | JEV | Builds the graph of machine-generated knowledge pages (space-scoped sources whose metadata marks them generated) and lists them with neighbors and related pages; sort priority is a small deterministic point-count over structural flags (has a projection kind, has a resolved subject), not text guesswork. |
| `sdk/src/platform/knowledge/generated-projections.ts` | JEV | Materializes a generated markdown page (a wiki/dashboard/rollup projection) as a source plus artifact plus optional linking edge, reusing the existing artifact when its content hash is unchanged and rolling back partial writes on failure; all deterministic content-addressed bookkeeping. |
| `sdk/src/platform/knowledge/graphql-schema.ts` | JEV | The knowledge GraphQL SDL text, the optional-dependency loader for the graphql package, the JSON scalar, and small deterministic enum/int coercion helpers used by the resolvers. |
| `sdk/src/platform/knowledge/graphql.ts` | JEV | KnowledgeGraphqlService: builds/caches the parsed schema, resolves every query and mutation field by delegating to KnowledgeService methods, and enforces admin/write-scope checks on mutations. Pure dispatch and access control, no guesswork. |
| `sdk/src/platform/knowledge/home-graph/ask-page-refresh.ts` | JEV | After answering a Home Graph question, links useful returned facts/sources onto the mentioned devices and refreshes their generated pages. Gating on usefulness is delegated to page-quality.ts's isUsefulHomeGraphPageFact/Source (flagged there); the fixed edge weights (ASK_FACT_SOURCE_WEIGHT 0.82, ASK_FACT_DESCRIBES_WEIGHT 0.8) are confidence constants on the write, not a fresh natural-language guess in this file. |
| `sdk/src/platform/knowledge/home-graph/ask.ts` | JEV | Answers a Home Graph query, either via the semantic service or a local fallback that renders the top scored results. |
| `sdk/src/platform/knowledge/home-graph/auto-link.ts` | JEV | Decides which existing Home Graph node a newly indexed source document should be auto-linked to, and what kind of relation that link is. |
| `sdk/src/platform/knowledge/home-graph/documentation.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/extension.ts` | JEV | Declares the Home Graph knowledge-space extension's object profiles; no logic. |
| `sdk/src/platform/knowledge/home-graph/extraction-quality.ts` | JEV | One-line delegation to hasUsefulKnowledgeExtractionText in extraction-policy.js (not in this file list); no guesswork of its own. |
| `sdk/src/platform/knowledge/home-graph/extraction.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/generated-pages.ts` | JEV | Generates and refreshes device-passport and room pages from the graph. |
| `sdk/src/platform/knowledge/home-graph/helpers.ts` | JEV | Shared read/normalize helpers (readRecord, readString, buildHomeGraphMetadata, edgeIsActive, etc). No guesswork found. |
| `sdk/src/platform/knowledge/home-graph/import-export.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/index.ts` | JEV | Barrel export for the home-graph package; no logic. |
| `sdk/src/platform/knowledge/home-graph/inventory.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/link-node.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/link.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/map-view.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/page-quality.ts` | JEV | Decides whether a source or fact is worth showing on a generated Home Graph page. |
| `sdk/src/platform/knowledge/home-graph/pages.ts` | JEV | Lists generated Home Graph pages in display order. |
| `sdk/src/platform/knowledge/home-graph/quality.ts` | JEV | Raises Home Graph device-quality issues (missing manual, unknown battery type) by inferring facts about a device from its text and linked entities. |
| `sdk/src/platform/knowledge/home-graph/refinement.ts` | JEV | Orchestration wrapper listing/running/cancelling Home Graph refinement tasks; delegates the real decisions to triage.ts (flagged there) and the semantic self-improvement service. No guesswork of its own. |
| `sdk/src/platform/knowledge/home-graph/reindex.ts` | JEV | Deterministic reindex orchestration (budget/time management, extraction repair scanning, page refresh scheduling). No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/rendering.ts` | JEV | Renders room/device/packet pages and the Home Graph map from graph state, and dedupes the fact lines shown on a generated device page. |
| `sdk/src/platform/knowledge/home-graph/reset.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/review.ts` | JEV | Applies an already-decided review action (accept/reject/resolve/forget, supplied by the caller, e.g. the triage battery in triage.ts) to an issue, node, or source. Deterministic bookkeeping on a decision made elsewhere; no guesswork of its own. |
| `sdk/src/platform/knowledge/home-graph/search.ts` | JEV | The Home Graph retrieval engine: scores and ranks every source and node against a query, and decides which entity a query is about. |
| `sdk/src/platform/knowledge/home-graph/search-utils.ts` | JEV | Small shared helpers (intersects, isSingularObjectQuery) used by search.ts; no guesswork of its own beyond what search.ts already carries. |
| `sdk/src/platform/knowledge/home-graph/service.ts` | JEV | The Home Graph service facade: wires ask/search/reindex/quality/triage into one API surface. Calls scoreHomeGraphResults (flagged in search.ts) and refreshHomeGraphQualityIssues (flagged in quality.ts) but adds no new guesswork of its own. |
| `sdk/src/platform/knowledge/home-graph/source-links.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/space-selection.ts` | JEV | Resolves which knowledge space a Home Graph request reads/writes. No guesswork found. |
| `sdk/src/platform/knowledge/home-graph/state.ts` | JEV | Reads the graph's current nodes/edges/issues into a snapshot; no guesswork found. |
| `sdk/src/platform/knowledge/home-graph/status.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/home-graph/sync-self-improvement.ts` | JEV | Drives the background self-improvement pump for Home Graph sources and decides whether another pass should run. sourceHasUsefulSemanticFacts and downstream page refresh delegate usefulness judgments to page-quality.ts (already flagged); the pass/continue logic here (shouldContinueHomeGraphSyncSelfImprovement) is a deterministic progress check on counters, not a fresh guess. |
| `sdk/src/platform/knowledge/home-graph/sync.ts` | JEV | Syncs a Home Assistant snapshot into graph nodes/edges and retires stale records. Deterministic bookkeeping keyed on the snapshot's own object ids; no guesswork found. |
| `sdk/src/platform/knowledge/home-graph/triage.ts` | JEV | Runs LLM-driven triage over open Home Graph device-quality issues. |
| `sdk/src/platform/knowledge/home-graph/types.ts` | JEV | Type definitions for Home Graph records; no logic. The string 'quality-rule-heuristics' at line 90 is a literal tag value, not guesswork itself. |
| `sdk/src/platform/knowledge/html-readability.ts` | JEV | Loads the optional jsdom/@mozilla/readability toolchain and extracts readable article text (title, byline, headings, paragraph samples, links) from HTML; the article-extraction judgment itself is delegated entirely to the Readability library, this file only wires it up and reports availability. |
| `sdk/src/platform/knowledge/index.ts` | JEV | Barrel file re-exporting the knowledge subsystem's public surface: connectors, extraction policy, browser history, GraphQL service, spaces, generated pages/projections, map rendering, source quality, extensions, semantic service, Home Graph service, project planning, persistence, projections, store, service and their types. |
| `sdk/src/platform/knowledge/ingest-compile.ts` | JEV | After an artifact is extracted, finalizes and compiles a source into the knowledge graph: writes the extraction record, a snapshot edge, a domain node from the URL host, bookmark-folder nodes from the folder path, topic nodes from tags and extraction sections, link-to-source edges for canonicalized outbound links, and structured entity-hint nodes (project/capability/repo/provider/service/environment/user) read from tag prefixes and metadata keys. All deterministic structural extraction over already-typed fields (tags with a recognized prefix, metadata keys), not free-text guessing. |
| `sdk/src/platform/knowledge/ingest-context.ts` | JEV | Type-only definition of the dependency bundle (store, artifact store, connector registry, event emitter, lint, memory sync) the ingest functions are threaded through. |
| `sdk/src/platform/knowledge/ingest-inputs.ts` | JEV | The ingest entry points: ingest a URL or artifact, import bookmarks/URL-list files, ingest bookmark seeds and connector input, refresh sources, and pick refresh candidates by a fixed per-connector-type refresh-window table. All deterministic orchestration and table lookups, not guesswork. |
| `sdk/src/platform/knowledge/ingest.ts` | JEV | Barrel file re-exporting the ingest-context type and the ingest-compile/ingest-inputs functions. |
| `sdk/src/platform/knowledge/knowledge-api.ts` | JEV | Builds the typed, frozen KnowledgeApi and MemoryApi/CodeIndexApi facades over KnowledgeService and MemoryRegistry/CodeIndexStore, a thin adapter layer with no decisions of its own. |
| `sdk/src/platform/knowledge/knowledge-history-types.ts` | JEV | Type definitions for a knowledge node's append-only revision history, the review-state provenance stamped on node activation, and the semantic-enrichment bookkeeping record. |
| `sdk/src/platform/knowledge/lint.ts` | JEV | Runs deterministic health checks over the store (failed crawls, missing title/summary/extraction, stale sources past a fixed per-connector refresh window, unlinked sources, sparse extractions, duplicate canonical URLs, stale mirrored memory nodes) and replaces the issue list. All checks are structural comparisons against typed fields and timestamps, not guesses about meaning. |
| `sdk/src/platform/knowledge/map-filters.ts` | JEV | Filters and facets the knowledge map view: scope, kind/status/tag/id/linked-to filters, and a plain case-insensitive substring text search across a fixed set of fields per record kind. The free-text 'query' filter is a literal substring match a user typed, not a guessed classification. |
| `sdk/src/platform/knowledge/map.ts` | JEV | Renders the knowledge map result and its SVG: applies the map filters, sorts and caps nodes/sources/issues, lays nodes out in concentric rings keyed by a fixed kind-to-ring table, and picks fixed colors/radii per kind. All deterministic layout and lookup-table rendering. |
| `sdk/src/platform/knowledge/memory-sync.ts` | JEV | Mirrors non-contradicted memory records into the knowledge graph as memory nodes plus topic-tag and session-provenance edges; a direct, deterministic one-to-one projection of already-reviewed memory records. |
| `sdk/src/platform/knowledge/packet.ts` | JEV | Builds the curated knowledge packet and the plain-substring search endpoint: both score sources and nodes by tokenizing the task/query and checking literal token containment in a haystack of joined fields (scoreHaystack from shared.ts), then add hand-tuned boosts for status/extraction presence, usage frequency/diversity/recency, relation count and node kind, rank by total score, and truncate to fit a token budget with honest drop/truncation accounting. |
| `sdk/src/platform/knowledge/pdf-extractor.ts` | JEV | Extracts text from PDF buffers via pdfjs-dist, falling back to a hand-rolled raw PDF stream/string extractor (FlateDecode inflate, literal and hex string parsing) when pdfjs fails; readability of extracted text/strings is judged the same binary-like-ratio heuristic as extraction-policy.ts. |
| `sdk/src/platform/knowledge/persistence.ts` | JEV | Barrel file re-exporting the SQL schema builder, snapshot loader and read-view helpers from store-schema.ts and store-load.ts. |
| `sdk/src/platform/knowledge/projections.ts` | JEV | KnowledgeProjectionService renders and materializes markdown projections (overview, bundle, per-source/node/issue pages, health/backlinks dashboards, rollups) purely from typed store records and fixed templates; scope filtering and target resolution are deterministic lookups, no guesswork. |
| `sdk/src/platform/knowledge/projection-utils.ts` | JEV | Small deterministic formatting helpers used by projections.ts (slugify, quote, format date, join sections, dedupe, bullet list, sort by title, materialized-target reference, active-edge check). |
| `sdk/src/platform/knowledge/project-planning/helpers.ts` | JEV | Deterministic id/space/uri helpers for project-planning artifacts (project id from a path hash, canonical uri, source id, stable planning id, artifact summary text). No guesswork. |
| `sdk/src/platform/knowledge/project-planning/index.ts` | JEV | Barrel file re-exporting the project-planning service, helpers, readiness evaluator and their types. |
| `sdk/src/platform/knowledge/project-planning/readiness.ts` | JEV | Evaluates whether a planning state is ready to execute: checks for a goal, scope, open questions, decomposed tasks, dependency graph, verification gates and execution approval, and separately flags the goal as ambiguous when it contains one of a fixed list of vague English words/phrases. |
| `sdk/src/platform/knowledge/project-planning/service.ts` | JEV | ProjectPlanningService: CRUD over planning state, decisions and language artifacts stored as knowledge sources, answering open planning questions, and the durable work-plan task list (create/update/reorder/delete/clear, with runtime events). All deterministic state management; readiness judgment is delegated to readiness.ts. |
| `sdk/src/platform/knowledge/project-planning/types.ts` | JEV | Type definitions for project-planning state, decisions, language artifacts, readiness gaps, and the durable work-plan task/snapshot shapes. |
| `sdk/src/platform/knowledge/review.ts` | JEV | Applies an explicit reviewer action (accept/reject/resolve/reopen/edit/forget) to an issue and, when the caller supplied replacement facts, writes them onto the linked source or node; status transitions are a fixed action-to-status table, not a decision. |
| `sdk/src/platform/knowledge/scheduling.ts` | JEV | KnowledgeScheduleService: the fixed catalog of knowledge jobs (lint, reindex, refresh, browser-history sync, projection rebuild, semantic enrichment/self-improvement, light/deep consolidation), schedule CRUD, timer arming/reconciliation and job-run bookkeeping. Deterministic scheduling infrastructure. |
| `sdk/src/platform/knowledge/scope-records.ts` | JEV | Decides which knowledge space a source/node/issue belongs to, including whether a 'default' space record is really contaminated leakage from another extension (Home Assistant, the goodvibes-agent default wiki, a GitHub-scraped navigation-chrome page) by matching a battery of hand-written regexes against the record's title/summary/metadata text (home assistant markers, agent-wiki frontmatter markers, GitHub navigation-menu chrome phrases, retailer-domain and low-value-source phrases carried in from source-quality.ts). |
| `sdk/src/platform/knowledge/semantic/answer-common.ts` | JEV | Defines the shared EvidenceItem type used across the answer pipeline; no logic. |
| `sdk/src/platform/knowledge/semantic/answer-evidence.ts` | JEV | Collects the evidence set (sources, nodes, facts) an answer is synthesized from. |
| `sdk/src/platform/knowledge/semantic/answer-fact-selection.ts` | JEV | Filters and ranks which facts are shown or handed to the answer prompt for a given query. |
| `sdk/src/platform/knowledge/semantic/answer-fallback.ts` | JEV | Renders a non-LLM fallback answer from raw evidence when no semantic LLM is configured; delegates text-quality filtering to fact-quality.ts's isLowValueFeatureOrSpecText (flagged there). No new guesswork of its own. |
| `sdk/src/platform/knowledge/semantic/answer-gaps.ts` | JEV | Creates knowledge-gap records for unanswered questions. The confidence:70 at line 59 is a fixed default stamp on a manually-created gap record, not a fresh guess about the text. |
| `sdk/src/platform/knowledge/semantic/answer-llm.ts` | JEV | Synthesizes the final answer text via the semantic LLM. |
| `sdk/src/platform/knowledge/semantic/answer-quality.ts` | JEV | Decides whether a synthesized answer is good enough or needs a flagged gap, and strips low-value lines from it. |
| `sdk/src/platform/knowledge/semantic/answer-source-ranking.ts` | JEV | Ranks which sources are cited alongside an answer. |
| `sdk/src/platform/knowledge/semantic/answer-space.ts` | JEV | No natural-language guesswork found. |
| `sdk/src/platform/knowledge/semantic/answer.ts` | JEV | Orchestrates the answer pipeline (evidence collection, LLM synthesis, quality cleanup, gap detection); the real decisions live in answer-evidence.ts, answer-llm.ts and answer-quality.ts, all flagged there. No new guesswork of its own. |
| `sdk/src/platform/knowledge/semantic/background-scheduler.ts` | JEV | Schedules background enrichment/self-improvement work. No natural-language guesswork found. |
| `sdk/src/platform/knowledge/semantic/enrichment.ts` | JEV | Enriches a newly indexed source into semantic facts, entities, relations and gaps, either via an LLM or a deterministic fallback. |
| `sdk/src/platform/knowledge/semantic/fact-quality.ts` | JEV | The shared fact/text quality gate used by nearly every other file in this package (rendering, page-quality, answer-fact-selection, answer-quality, repair-fact-selection, self-improvement-graph). |
| `sdk/src/platform/knowledge/semantic/gap-repair.ts` | JEV | Runs a web search to fill a knowledge gap and assesses which results are trustworthy enough to ingest. |
| `sdk/src/platform/knowledge/semantic/graph-index.ts` | JEV | Builds an in-memory index of a knowledge space's nodes/edges/sources for the self-improvement pipeline. No natural-language guesswork found. |
| `sdk/src/platform/knowledge/semantic/index.ts` | JEV | Barrel export for the semantic package; no logic. |
| `sdk/src/platform/knowledge/semantic/llm.ts` | JEV | Wraps the configured provider as the semantic package's LLM client (completeJson, timeouts). No guesswork of its own; it is the transport the free-text prompts in enrichment.ts, answer-llm.ts, gap-repair.ts and home-graph/triage.ts run over. |
| `sdk/src/platform/knowledge/semantic/object-scope.ts` | JEV | Decides which graph entity (or entities) a query is about, and whether a given source or node falls inside that scope. |
| `sdk/src/platform/knowledge/semantic/repair-fact-selection.ts` | JEV | Selects and classifies which source sentences become promoted repair facts, and judges the source's authority. |
| `sdk/src/platform/knowledge/semantic/repair-profile.ts` | JEV | Derives structured device-specification facts from raw scraped source text for a device's profile. |
| `sdk/src/platform/knowledge/semantic/repair-subjects.ts` | JEV | No natural-language guesswork found; delegates subject identification to self-improvement-graph.ts and object-scope.ts, both flagged there. |
| `sdk/src/platform/knowledge/semantic/self-improvement-gap-context.ts` | JEV | Decides whether an open knowledge gap should be repaired, skipped, or suppressed. |
| `sdk/src/platform/knowledge/semantic/self-improvement-gap-state.ts` | JEV | Persists gap status transitions (suppressed, stale, etc.) decided elsewhere (self-improvement-gap-context.ts). Deterministic bookkeeping; no guesswork of its own. |
| `sdk/src/platform/knowledge/semantic/self-improvement-graph.ts` | JEV | Shared graph-traversal helpers for the self-improvement pipeline (facts/sources for an object, coverage, fact usability). |
| `sdk/src/platform/knowledge/semantic/self-improvement-intrinsic-gaps.ts` | JEV | Auto-creates knowledge gaps for devices whose feature/specification profile looks incomplete. |
| `sdk/src/platform/knowledge/semantic/self-improvement-promotion.ts` | JEV | Promotes accepted repair-search evidence into semantic facts and links them onto the right device subjects (a gated write). |
| `sdk/src/platform/knowledge/semantic/self-improvement-recovery.ts` | JEV | Recovers/resumes interrupted self-improvement runs from persisted state. Deterministic bookkeeping; no guesswork found. |
| `sdk/src/platform/knowledge/semantic/self-improvement-tasks.ts` | JEV | Records refinement-task rows for self-improvement runs; passes through a confidence value decided elsewhere (self-improvement-gap-context.ts's classifyGap or the gap-repair assessment). No new guesswork of its own. |
| `sdk/src/platform/knowledge/semantic/self-improvement.ts` | JEV | Runs the self-improvement pass over open gaps, calling classifyGap (flagged in self-improvement-gap-context.ts) and the gap repairer. |
| `sdk/src/platform/knowledge/semantic/service.ts` | JEV | The semantic knowledge service facade: answer, enrich, reindex, self-improve, all wired together. |
| `sdk/src/platform/knowledge/semantic/timeouts.ts` | JEV | Timeout/deadline helpers (withTimeout, clampTimeoutMs). Deterministic; timeouts are explicitly not a decision point per the brief. |
| `sdk/src/platform/knowledge/semantic/types.ts` | JEV | Type definitions for the semantic package; no logic. |
| `sdk/src/platform/knowledge/semantic/utils.ts` | JEV | Shared text/id helpers for the semantic package. |
| `sdk/src/platform/knowledge/service-jobs.ts` | JEV | Dispatches a scheduled/manual knowledge job to its handler by a fixed kind-to-function switch (lint, reindex, refresh-stale/bookmarks, browser-history sync, rebuild-projections, semantic enrichment/self-improvement, light/deep consolidation) and shapes each result. Pure dispatch, no guesswork. |
| `sdk/src/platform/knowledge/service-node-admin.ts` | JEV | Query helpers for nodes/issues (scope, kind/status filters, plain literal-substring text search, honest stale-node exclusion by default) and the explicit accept/reject node-review decision that activates or staleifies a node. |
| `sdk/src/platform/knowledge/service.ts` | JEV | KnowledgeService, the facade every knowledge verb goes through: status, source/node/issue query and CRUD, item views, ingest, projections, map, reindex, search/ask/packet building, jobs/schedules, consolidation decisions and refinement tasks. querySources/queryNodes/queryIssues use a plain literal-substring token filter (every query token must appear in a joined haystack) for the free-text 'query' filter, the same deterministic filter-box pattern as map-filters.ts, not a ranked guess. |
| `sdk/src/platform/knowledge/shared.ts` | JEV | Shared constants and helpers used across the knowledge subsystem: tokenize/slugify, URI canonicalization, tag merging, the packet keyword-scoring function scoreHaystack, token-count estimation, detail-level trimming, packet rendering, source-type inference, and the per-connector refresh-window table. |
| `sdk/src/platform/knowledge/source-quality.ts` | JEV | Decides whether a source is worth generating a knowledge page from: a fixed-weight quality score (source-discovery rank, source-type bonus, a quality-keyword regex bonus, a low-value penalty) that also gates page-source selection and ranking, and a separate low-value classifier that matches commerce/marketplace keyword regexes and a fixed list of retailer domains (amazon, ebay, walmart, bestbuy, target) against the source's title/summary/description/URL text. |
| `sdk/src/platform/knowledge/spaces.ts` | JEV | Knowledge-space id helpers: prefix constants for agent/Home-Assistant/project spaces, normalization, metadata stamping and scope-matching. Deterministic string handling, not a decision point. |
| `sdk/src/platform/knowledge/store-config.ts` | JEV | Resolves the knowledge SQLite db path per store family (wiki/home-graph/agent) with a loud mismatch guard, and defines DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE (40), the auto-accept threshold used by the node review gate. |
| `sdk/src/platform/knowledge/store-load.ts` | JEV | Loads every knowledge table from SQLite into typed record arrays via the store-schema row mappers. Pure data marshalling. |
| `sdk/src/platform/knowledge/store-node-history.ts` | JEV | Writes a node row, clamps/normalizes a confidence value, and resolveNodeActivation decides a node's status (active/draft) and stamps honest review provenance (auto-accepted, pending-review, reviewed, explicit, pre-gate) by comparing its confidence against the store's configured auto-accept threshold; also records append-only node revisions by diffing changed fields and merges nodes by re-pointing edges. |
| `sdk/src/platform/knowledge/store-read.ts` | JEV | Read-only accessors over the in-memory store view: status counts, sorted/paged listings per record kind, space-scoped listings, lookups by id/canonical-uri/kind+slug, edge traversal and the combined item view. All deterministic map/array operations. |
| `sdk/src/platform/knowledge/store-record-delete.ts` | JEV | Cascading hard delete of a single node or source record and everything that references it (edges, issues, usage records, consolidation candidates, refinement tasks, revisions, enrichment state). Deterministic cascade, no guesswork. |
| `sdk/src/platform/knowledge/store-refinement.ts` | JEV | Upserts a refinement task row, merging metadata and trace entries and deriving typed source-tracking fields (accepted/ingested/rejected source ids, promoted fact count, source assessments) from metadata. Deterministic record assembly. |
| `sdk/src/platform/knowledge/store-schedules.ts` | JEV | Upsert and delete for a knowledge schedule row. Deterministic CRUD. |
| `sdk/src/platform/knowledge/store-schema.ts` | JEV | The knowledge SQLite schema (table/index DDL) and every row-to-record mapper, plus small deterministic helpers (stableText, uniq, JSON parse-with-fallback, issue-status-on-fingerprint-change). |
| `sdk/src/platform/knowledge/store-space-delete.ts` | JEV | Plans and executes a full knowledge-space delete: collects every record (sources, nodes, edges, issues, extractions, job runs, refinement tasks, usage, consolidation candidates/reports, schedules) whose space id or reference chain matches the target space, then deletes them. Deterministic graph-closure computation over explicit space ids and reference fields. |
| `sdk/src/platform/knowledge/store.ts` | JEV | KnowledgeStore, the single class owning the SQLite-backed in-memory maps for every knowledge record kind: init, listing/paging/lookup delegation to store-read.ts, upsert/delete for every record kind (sources, nodes with the review-gate activation and revision history, edges, issues, extractions, job runs with a retention cap, refinement tasks, usage, consolidation candidates/reports, schedules), and knowledge-space delete. Space-id inference for a new node/issue prefers a non-default space already carried by a referenced source/node over an explicit default, a deterministic precedence rule over already-tagged data, not a guess about meaning. |
| `sdk/src/platform/knowledge/types.ts` | JEV | The full set of knowledge record and upsert-input type definitions: sources, nodes, edges, issues, extractions, jobs/job-runs, refinement tasks (including per-source assessment shape), usage, consolidation candidates/reports, schedules, packets, item views, connectors, projections and the map result shapes. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/knowledge/consolidation.ts:271` | scoreUsageBoost combines four hand-tuned weighted terms over usage stats (frequency capped at 28, usage-kind/session diversity capped at 14, an average-score term capped at 12, and a recency bonus of 10/6/3/0 by age bucket) into one composite score; refreshKnowledgeConsolidationCandidates then gates whether a subject becomes a visible candidate at all on score >= LIGHT_CONSOLIDATION_THRESHOLD (45), and runKnowledgeConsolidation gates the actual write into durable memory (memoryRegistry.add) on score >= DEEP_CONSOLIDATION_AUTOPROMOTE_THRESHOLD (72), both fixed numeric cutoffs over a hand-tuned score | the knowledge gated-write pattern: a composite-score compound (arithmetic terms for frequency/diversity/recency stay code) feeding a judged confirm/escalate reading over whether this subject is worth promoting to durable memory right now, with bands replacing the two hard-coded thresholds so the write into memory is gated by a reviewable judgment rather than an unreviewable magic number |
| `sdk/src/platform/knowledge/extraction-policy.ts:60` | hasUsefulKnowledgeExtractionText rejects text that contains any of four fixed marker phrases (LIMITED_EXTRACTION_MARKERS, e.g. 'pdf extraction produced limited text') or that looksLikeRawPdfPayload or looksBinaryLikeText; looksBinaryLikeText samples up to 4096 characters and classifies the sample as binary-like by comparing control/extended/letter/whitespace/punctuation ratios against four hand-tuned constants (KNOWLEDGE_BINARY_*_RATIO_THRESHOLD) | an existence/quality reading over the extraction sample (does this look like usable readable text, yes/no with a reason) replacing the fixed ratio-threshold heuristic; the marker-phrase and extractor-version checks stay deterministic since they compare against known fixed strings and a version counter |
| `sdk/src/platform/knowledge/home-graph/ask.ts:149` | a regex tests the user's raw query text against a fixed list of integration-related words (integration, platform, add-on, plugin, service, api, setup, configure, configuration, auth, credential, rate limit) to decide whether ha_integration nodes should be included among the linked objects returned with the answer | choice pattern: classify whether the query concerns a Home Assistant integration/platform topic, gating whether integration nodes are included as linked objects |
| `sdk/src/platform/knowledge/home-graph/auto-link.ts:95` | scoreCandidates hand-scores every candidate node against the source's evidence text: +120 to +180 for an exact model-id substring match, +140 for an entity-id match, +120 for a device-id match, +12/+18 per overlapping non-generic title token, +28 for a manufacturer-name match, up to +50 for related-entity token overlap, plus kind-specific bonuses/penalties (+16, +40, -45); autoLinkHomeGraphSource then only accepts the top candidate when its score clears a fixed MIN_AUTO_LINK_SCORE of 90 (line 19) and beats the runner-up by at least 20 points (line 46) unless it was an exact-model match | alignment pattern (entity match on a 3-level score): align a source document to the graph entity it evidences, replacing the fixed point totals and the 90/20-point acceptance gate with a banded confidence reading (act/confirm/escalate) |
| `sdk/src/platform/knowledge/home-graph/auto-link.ts:239` | inferRelation (and its helpers isManualLikeSource line 248, isIntegrationDocumentationSource line 258) classify what KIND of document a source is - receipt, warranty, manual, or integration documentation - from keyword and regex matches over its tags/title/URI text ('receipt', 'warranty', /\bmanual\b/\.pdf\b/owner.?s guide/user guide/, tags like 'integration'/'documentation') | choice pattern: classify a linked source's relation to its device (receipt, warranty, manual, integration documentation, or generic source) from its title, tags and text, replacing the keyword/regex rules |
| `sdk/src/platform/knowledge/home-graph/generated-pages.ts:672` | generatedPagePriority hand-scores which nodes get a generated page first: +8 for objectKind device, +8/+2 for certain domains, plus a device-type keyword regex (/tv/receiver/speaker/thermostat/.../, +6) and an infrastructure/software keyword regex (/home assistant/plugin/add-on/.../, -8) over the node's title and summary text | rerank pattern: rank which nodes most deserve a generated page next, replacing the fixed domain bonuses and the two keyword regexes |
| `sdk/src/platform/knowledge/home-graph/generated-pages.ts:903` | a fixed authorityBoost threshold (>=120 official-vendor, >0 vendor, else secondary) turns the continuous source-authority score from semantic/answer-source-ranking.ts into a 3-level trust tier stamped on every synthesized device-profile fact | a banded quality/alignment reading (act/confirm/escalate scaled to stakes) in place of the fixed >=120 / >0 cutoffs for how much a generated fact's source is trusted |
| `sdk/src/platform/knowledge/home-graph/page-quality.ts:43` | isLowValueHomeGraphPageSource judges a source page as low value by testing its combined title/summary/description/url text against three fixed regexes: shopping/retail language (shop now, affiliate, buy now, sponsored listing, etc.), a list of retailer domains (amazon, ebay, walmart, bestbuy, target), and comparison/catalog phrasing (speaker compare, device ratings, top N devices) | quality pattern: score a source's usefulness for a device page on a specificity rubric, replacing the three fixed regexes with a Jev quality reading |
| `sdk/src/platform/knowledge/home-graph/pages.ts:79` | generatedPagePriority hand-scores display order for generated pages: +30/+18 for projection kind, +24/+16 for subject node kind, plus a device-type keyword regex (/tv/television/webos/iphone/.../ +12) and an infrastructure keyword regex (/home assistant/plugin/theme/.../ -10) over the page's title and summary text | rerank pattern: rank generated pages by how much they matter to show first, replacing the fixed bonuses and the two keyword regexes |
| `sdk/src/platform/knowledge/home-graph/quality.ts:196` | isSoftwareOrInfrastructure decides whether a graph node is really a physical device or actually software/infrastructure, by testing its combined title/summary/metadata/linked-entity text against two fixed keyword-term lists, EXCLUDED_SOFTWARE_TERMS (add-on, automation, integration, service, template, virtual, ...) and EXCLUDED_INFRASTRUCTURE_TERMS (adapter, bridge, coordinator, dongle, gateway, hub) | choice pattern: classify a node as a physical device vs software/infrastructure vs unclear, from its description and linked entity domains, replacing the two keyword-term lists |
| `sdk/src/platform/knowledge/home-graph/quality.ts:162` | shouldRequireBatteryType decides whether a device should have a known battery type by testing its text against EXCLUDED_MAINS_TERMS (a list of mains-powered device words like 'refrigerator', 'washer', 'tv') to rule the issue out, and BATTERY_EVIDENCE_TERMS (battery, cr2032, motion sensor, remote, ...) to rule it in, plus two fixed entity-domain/device-class sets (BATTERY_ENTITY_DOMAINS, BATTERY_DEVICE_CLASSES) | yes/no reading: does this device run on battery power, from its description and linked entity domains/device classes, replacing the two keyword-term lists and the two fixed domain sets, banded to raise or suppress the quality issue |
| `sdk/src/platform/knowledge/home-graph/quality.ts:181` | shouldRequireManual decides whether a device should have a linked manual from manufacturer/model presence plus a fixed MANUAL_ENTITY_DOMAINS set of Home Assistant entity domains (alarm_control_panel, camera, climate, lock, media_player, ...) | yes/no reading: does this device warrant a manual, from its type and linked entity domains, replacing the fixed domain set |
| `sdk/src/platform/knowledge/home-graph/rendering.ts:484` | normalizedFactValuesEquivalent (used by isRedundantPageFactDetail, line 470) decides whether two rendered fact strings say the same thing by tokenizing both and requiring at least 75% of the shorter string's tokens to appear in the longer one, a fixed string-similarity threshold for identity | a Jev reading of whether two candidate fact lines are redundant restatements of the same value, replacing the fixed 0.75 token-overlap threshold with a banded similarity judgment |
| `sdk/src/platform/knowledge/home-graph/rendering.ts:508` | cleanPageFactTitle discards a fact title as scraped spec-table junk when it is longer than 120 characters AND matches a fixed keyword regex (hdmi, usb, hdr, speaker, audio, ports, features, selected, motion, freesync, quantity, table) | quality pattern: score whether a fact title is a genuine device attribute versus raw spec-table noise on a specificity rubric, replacing the length-plus-keyword cutoff |
| `sdk/src/platform/knowledge/home-graph/search.ts:178` | scoreHomeGraphResults, via scoreFields (line 742), ranks every candidate source and node by fixed per-token point totals (10-14 points per matching token), anchor-identity bonuses, and extraction/link-state bonuses and penalties, using a hand-built query-expansion synonym table (QUERY_EXPANSIONS, lines 75-82: capability/feature/television/tv) and stopword/generic-anchor-token exclusion lists (STOPWORDS, GENERIC_ANCHOR_TOKENS) | rerank pattern: rank candidate sources and nodes by relevance to the query with a Jev reading, replacing the fixed per-token point totals and the hand-picked synonym/stopword tables |
| `sdk/src/platform/knowledge/home-graph/search.ts:408` | selectAnchorNodes (with sourceAnchorIdentityScore, line 388) decides which graph node(s) a query is 'about' using the same point-scoring plus a fixed top-score-minus-12 tolerance band (line 423) to decide which near-tied candidates also count as anchors | alignment pattern (entity match on a 3-level score): decide which entity, if any, a query names, replacing the score-and-tolerance-band selection |
| `sdk/src/platform/knowledge/home-graph/search.ts:671` | pruneWeakTokenCoverage keeps only results whose token coverage is within 1 of the best result's coverage (topCoverage - 1, line 677), a fixed relevance-tolerance cutoff deciding which results are still relevant enough to keep | existence check pattern: does the corpus contain anything that actually answers the query, replacing the token-coverage-minus-one cutoff with a banded existence reading |
| `sdk/src/platform/knowledge/home-graph/search.ts:518` | queryNeedsSourceEvidence and queryMentionsIntegration (line 522) classify what the query is asking about (evidence/manual-seeking, or integration-related) from two fixed keyword-token sets (SOURCE_EVIDENCE_TOKENS, INTEGRATION_QUERY_TOKENS), gating which sources/nodes are boosted or included in results | choice pattern: classify what the query is asking about, replacing the two fixed keyword-token sets |
| `sdk/src/platform/knowledge/home-graph/triage.ts:150` | runHomeGraphIssueTriage prompts the configured semantic LLM with a hand-written system prompt (buildTriageSystemPrompt, line 335, including hardcoded per-issue-code reject/review guidance from DEFAULT_HOME_GRAPH_TRIAGE_RULES, line 51) to classify each open device-quality issue as 'reject' or 'review' with a free-text reason and a self-reported 0-100 confidence number, parses the strict-JSON response (parseTriageDecisions, line 367), and auto-applies a reject only when that self-reported confidence clears a single hand-tuned threshold, HOME_GRAPH_TRIAGE_DEFAULT_MIN_CONFIDENCE = 85 (line 17) | Home Graph triage as a choice: a battery asking whether an open device-quality issue should be rejected or sent for human review, with an act/confirm/escalate band scaled to stakes replacing the single hand-tuned 85 confidence threshold and the free-text-then-parse round trip |
| `sdk/src/platform/knowledge/packet.ts:48` | searchKnowledge and buildKnowledgePacketFromCurrentState both rank candidates by scoreHaystack's literal-substring token match plus a stack of hand-tuned additive boosts (status/extraction-presence flat bonuses, scoreUsageBoost's frequency/diversity/recency terms, a relation-count boost capped at 18-20, a freshness boost of +6/-8, and a fixed per-node-kind boost table), sorting by the summed score and slicing to the requested limit or token budget | the knowledge rerank pattern over retrieval candidates (source and node records matched against the task/write-scope), replacing the keyword-substring score and its hand-tuned additive boosts with a single reviewable ranking judgment; the token-budget truncation and honest drop/truncation counters stay code since they are arithmetic over already-ranked items |
| `sdk/src/platform/knowledge/pdf-extractor.ts:342` | isReadablePdfText treats a string as readable PDF text only if it passes looksLikeRawPdfPayload/looksBinaryLikeText and at least 55% of a 512-char sample is letters, digits or whitespace, a hand-tuned ratio threshold deciding whether an extracted PDF string fragment is real text or decoding noise | the same extraction-quality existence reading used in extraction-policy.ts, applied per extracted string fragment instead of a fixed 0.55 ratio cutoff |
| `sdk/src/platform/knowledge/project-planning/readiness.ts:9` | VAGUE_TERMS, a fixed list of about 12 words/phrases (better, improve, improved, setup, integration, agent channel, remote, thing, stuff, etc, clean up, fix it) matched by substring against the plan's goal text to decide whether the goal is ambiguous and needs clarification before work starts | a judge pattern over the goal text (is this goal concrete enough to act on, judged against a goal/criteria rubric) replacing the fixed vague-word list; every other readiness gap in this file (missing goal/scope/tasks/dependencies/verification/approval) stays a deterministic structural check over counts and booleans |
| `sdk/src/platform/knowledge/scope-records.ts:366` | hasExtensionOnlyKnowledgeMarker, hasLegacyDefaultAgentWikiMarker, hasDefaultGoodVibesProductNavigationMarker and hasGithubNavigationChromeMarker each test a fixed list of regexes (e.g. /home\s*assistant/, /navigation\s+menu/, /skip\s+to\s+content/, /repository\s+files\s+navigation/) against joined title/summary/metadata text to decide whether a record scoped to the default knowledge space is actually mis-scoped extension or scraped-chrome content, gating isDefaultExtensionContaminatedSource/Node/Issue and so gating whether the record is visible in the default space at all | an existence/classification reading (does this record's text look like Home Assistant content, agent-wiki boilerplate, or scraped page-navigation chrome rather than genuine default-space knowledge, yes/no per category) replacing the regex battery; the space-id and edge/metadata bookkeeping used to gather the candidate text stays code |
| `sdk/src/platform/knowledge/semantic/answer-evidence.ts:57` | collectAnswerEvidence hand-scores every candidate source/node/fact for inclusion as answer evidence: a base token-overlap score (scoreSemanticText) plus a subject-token overlap score, a fixed 100-120 point namespace-alias penalty when the subject score is zero, a +120 candidate/linked bonus, semantic-kind boosts, and up to +60/+80 bonus scaled by attached-fact count (facts.length*6 or *10), plus sourceAuthorityBoostForAnswer (flagged in answer-source-ranking.ts) | existence check then rerank pattern: first judge whether the graph actually holds evidence for the query, then rank what counts as evidence, replacing the point-scored bonuses and penalties |
| `sdk/src/platform/knowledge/semantic/answer-evidence.ts:480` | pruneEvidence keeps only evidence items within a fixed topScore-90 tolerance band (line 485) when strictTopCluster is requested | a banded existence/relevance reading in place of the fixed 90-point tolerance band |
| `sdk/src/platform/knowledge/semantic/answer-fact-selection.ts:24` | factIntent classifies what kind of facts a query is asking for (feature/capability/spec vs procedure/configuration vs maintenance/warning vs none) from four fixed keyword-token sets | choice pattern: classify what kind of facts the query wants, replacing the four keyword-token sets |
| `sdk/src/platform/knowledge/semantic/answer-fact-selection.ts:74` | factQuality hand-scores a fact's overall priority for display/selection: +40 for an llm extractor, +34 for a repair-promotion extractor, +24/+14 for official-vendor/vendor source authority, +12 for having a value, +8/+6 for capability-or-feature/specification kind, plus confidence/10 | quality pattern: score a fact's usefulness and trustworthiness on a specificity rubric, replacing the fixed per-attribute point totals |
| `sdk/src/platform/knowledge/semantic/answer-llm.ts:18` | synthesizeAnswer sends the collected evidence to a free-text LLM prompt (a hand-written system prompt that bakes in topic-exclusion rules: ignore accessory/cable/battery/safety wording unless asked) and parses its JSON reply (normalizeLlmAnswer, line 89) into an answer, a self-reported 0-100 confidence, and follow-up gaps | judge pattern: judge the synthesized answer against the query and the supplied evidence, replacing the prompt-then-parse round trip with a structured Jev reading |
| `sdk/src/platform/knowledge/semantic/answer-llm.ts:58` | answerConfidence falls back to a hand-tuned formula when the LLM omits a confidence value: the top evidence score divided by 5, plus up to 35 points for the count of distinct cited facts (count*4), clamped to 10-92 | a banded confidence reading (act/confirm/escalate) in place of the fixed score/5 + factBoost formula |
| `sdk/src/platform/knowledge/semantic/answer-quality.ts:9` | answerNeedsFeatureGap decides whether a synthesized answer lacks enough concrete feature/spec evidence to flag a knowledge gap: it counts 'concrete' facts linked to the query subject against fixed thresholds (>=3 accept outright, >=2 plus a text-signal check), classifies the query as 'broad' via a fixed regex (features?/specs?/capabilities/what can/what does), and checks the answer/source text against a fixed list of manual/vendor keywords | existence check pattern: does the retrieved evidence actually answer the query well enough, replacing the concrete-fact-count thresholds and the broad-query/vendor-keyword regexes with a banded existence/quality reading |
| `sdk/src/platform/knowledge/semantic/answer-quality.ts:69` | hasEnoughAnswerSignal/hasBroadFeatureQueryIntent/queryFeatureTerms/featureSignalFamilyCount classify a query's breadth and count how many distinct TV/AV feature 'families' (display, ports, audio, network, smart, gaming, tuner) the answer text covers, via eight fixed regexes | quality pattern: score how thoroughly the answer covers the topic's feature areas on a specificity rubric, replacing the eight fixed regexes |
| `sdk/src/platform/knowledge/semantic/answer-source-ranking.ts:47` | sourceAnswerQuality ranks which sources to cite: evidence score/4, plus sourceAuthorityBoostForAnswer (line 64: up to +140 for a regex-detected 'official-vendor-domain' match, +120 for 'official' plus support/spec/manual wording, +80 for a 'manufacturer-domain' match), plus up to +80 for fact count*10 and +90 for promoted-fact count*18, a rank-derived bonus, a status bonus, minus 90 for a generated source | rerank pattern plus an alignment/quality reading of a source's vendor authority, replacing the fixed regex-derived point bonuses and the per-attribute weights |
| `sdk/src/platform/knowledge/semantic/enrichment.ts:109` | extractSemanticsWithLlm sends the source text to a free-text LLM extraction prompt and parses its JSON reply into facts/entities/relations/gaps, each carrying a self-reported 0-100 confidence that is accepted as-is | extraction verifier / structure recovery pattern: recover structured facts from the source text and verify them field by field, replacing the free-text-prompt-then-parse round trip |
| `sdk/src/platform/knowledge/semantic/enrichment.ts:291` | classifySentenceFact (the deterministic fallback) classifies a sentence into one of five kinds (warning, procedure, maintenance, compatibility, feature, specification) via a cascade of fixed keyword regexes, and stamps every match with a flat confidence of 55 regardless of content | coarsen pattern: classify a sentence's kind with a confidence, coarsening to one of the five parent labels, replacing the regex cascade and the flat confidence stamp |
| `sdk/src/platform/knowledge/semantic/enrichment.ts:240` | shouldDeriveDeterministicProfileFacts gates whether structured profile-fact derivation runs at all, via a model-identity regex plus two 'looks like a spec page' regexes (one over the source's title/tags, one over the extracted text's TV/AV vocabulary and size/resolution patterns) | choice pattern: decide whether this source is a device specification page worth profiling, replacing the three regex gates |
| `sdk/src/platform/knowledge/semantic/enrichment.ts:959` | inferLabels tags extracted text with topic labels (hdmi, usb, battery, firmware, warranty, voice, network) via a fixed keyword regex per label | choice pattern: classify which topic labels apply to a fact's text, replacing the fixed per-label regexes |
| `sdk/src/platform/knowledge/semantic/enrichment.ts:972` | entityMatchesHint and findSemanticNode (line 993) decide whether an extracted entity mention refers to an existing graph node by naive substring containment between the hint text and the node's title/aliases/manufacturer/model | alignment pattern (entity match on a 3-level score): decide whether an extracted mention refers to an existing entity, replacing the substring-containment check |
| `sdk/src/platform/knowledge/semantic/fact-quality.ts:70` | isLowValueFeatureOrSpecText is an approximately 60-rule cascade of hardcoded regexes deciding whether a fact or sentence is low-value junk text: accessory/packaging boilerplate, safety and installation warnings, remote-control button minutiae, marketplace/price language, truncated table fragments, repeated leading phrases, and dozens of other TV-manual-specific patterns; hasConcreteFeatureSignal (line 275) is its positive-signal counterpart, one large keyword regex deciding whether text 'looks like' a genuine feature/spec claim; isUsefulKnowledgePageFact (line 279) combines both plus a confidence/extractor rule to decide whether a fact is shown at all | quality pattern: score a candidate fact or sentence's usefulness on a specificity rubric, replacing this entire hand-written regex cascade with a single Jev quality reading banded to act/confirm/escalate |
| `sdk/src/platform/knowledge/semantic/gap-repair.ts:349` | assessGapRepairSource hand-scores each web search result's trustworthiness for filling a knowledge gap: 0-12 points for search rank, +28/+42 for a model-id match, +14 for a manufacturer match, +30 for a subject match, up to +18 for query-token overlap, up to +14 for gap-token overlap, +10 for a fixed 'source-purpose' regex (specifications, features, manual, support, product, documentation, datasheet), +28 for a manufacturer-name-in-domain match, +28 for a regex-derived 'official vendor domain' match; a candidate is only accepted once this score clears a fixed minConfidence (default 70, lines 286/309/456) | quality pattern: score a candidate web source's trustworthiness for repairing a specific knowledge gap on a specificity/authority rubric, replacing the point-scored bonuses and the fixed 70-point acceptance threshold with a banded reading |
| `sdk/src/platform/knowledge/semantic/gap-repair.ts:542` | isOfficialVendorDomain/domainMatchesManufacturer (and candidateOfficialHostsForManufacturer) infer whether a web domain belongs to a device's manufacturer by slugifying the manufacturer name and regex-matching it against the domain, denylisting generic slugs like 'support', 'docs', 'shop', 'store' | alignment pattern (entity match on a 3-level score): decide whether a web domain is the manufacturer's own site, replacing the slug-regex heuristic |
| `sdk/src/platform/knowledge/semantic/object-scope.ts:26` | inferAnswerObjectScope (via scoreObjectNode, line 212) decides which graph entity a query refers to using hand-tuned point scoring plus a hardcoded, TV-specific rule block (lines 223-230: +100 for an ha_device matching /tv/television/webos/bravia/roku/, +70 for a media_player domain match, +30/+40 for other TV-adjacent conditions, -40 for sensor/switch/automation matches), and a fixed top-score-minus-12 tolerance band (line 57) admitting near-tied candidates as anchors | alignment pattern (entity match on a 3-level score): decide which entity or entities a query names, replacing the hand-tuned point totals (including the special-cased TV rules) and the tolerance band with a Jev alignment reading |
| `sdk/src/platform/knowledge/semantic/object-scope.ts:246` | isSingularObjectQuery classifies whether a query is about one specific object ('the tv', 'this device') via a fixed regex over articles/demonstratives plus type words, and a singular/plural token check for tv/television | choice pattern: classify whether the query names a single specific object versus a general topic, replacing the regex and the singular/plural check |
| `sdk/src/platform/knowledge/semantic/object-scope.ts:327` | sourceMatchesAnchor decides whether a source document actually concerns the anchor entity by tokenizing the anchor's text (excluding a fixed GENERIC_ANCHOR_TOKENS list) and requiring the source text's token-overlap score to clear a fixed threshold (the lesser of 24 or tokens.length*12) | existence check pattern: does this source actually discuss the anchor entity, replacing the fixed token-overlap threshold with a banded existence reading |
| `sdk/src/platform/knowledge/semantic/repair-fact-selection.ts:44` | classifyRepairFact classifies what kind of device specification a sentence describes (display/picture, ports, network/wireless, audio, gaming, smart TV, tuner) via a cascade of category-detection regexes over hardcoded TV/AV vocabulary, then extracts a canonical value string by testing the sentence against dozens of further label/regex pairs per category (e.g. '4K UHD resolution', 'HDMI ARC/eARC', 'FreeSync/VRR support') | choice pattern: classify what kind of device specification a sentence describes from a closed, product-specific option set, and extract its value, replacing the cascading category regexes and per-label term matching |
| `sdk/src/platform/knowledge/semantic/repair-fact-selection.ts:113` | sourceAuthority classifies a source's trust tier (official-vendor/vendor/secondary) from regex matches over its trust-reason/domain/title/summary/url text ('official-vendor-domain', 'official' plus support/spec/manual/docs words, 'manufacturer-domain'); the same classification is reimplemented near-identically in answer-source-ranking.ts's sourceAuthorityBoostForAnswer and gap-repair.ts's isOfficialVendorDomain | alignment/quality pattern: judge a source's authority tier for this claim on a rubric, replacing the regex-based trust classification (and its duplicated copies elsewhere in this package) with one reusable Jev reading |
| `sdk/src/platform/knowledge/semantic/repair-fact-selection.ts:133` | repairSentenceScore and repairIntentPatterns (line 182) hand-score how well a candidate sentence answers the query's intent: repairIntentPatterns first classifies the query's topic (ports/network/display/gaming, or a generic fallback) from fixed keyword sets, then repairSentenceScore awards fixed points for source authority (+12), an intent-pattern match (+20), a concrete-feature signal (+8), a category-keyword hit (+12/+6), and penalizes question/FAQ/price-page phrasing (-20) | rerank pattern: rank candidate sentences by how well they answer the query's intent, replacing the fixed point totals and the keyword-based intent classification |
| `sdk/src/platform/knowledge/semantic/repair-profile.ts:25` | deriveRepairProfileFacts derives structured device-specification facts from raw source text using a fixed table of category rules (PROFILE_RULES): each rule tests an 'intent' regex against the query, a minimum-match count, and a list of label/regex term pairs against the source text, near-identical in structure to repair-fact-selection.ts's classifyRepairFact, to decide which specification categories apply and what values to report | structure recovery pattern: recover structured device-specification fields (kind, value, category) from raw scraped text, replacing the fixed rule table of intent regexes and label/term regex pairs (and its duplicate in repair-fact-selection.ts) |
| `sdk/src/platform/knowledge/semantic/self-improvement-gap-context.ts:105` | classifyGap decides whether an open knowledge gap should be repaired, skipped, or suppressed; the suppress path (isNotApplicableGap, line 213) rules a gap not-applicable via profile-declared suppressed-gap-kind keyword matches and, for battery-type gaps specifically, a fixed keyword regex over the linked node's text (battery, button, keypad, leak sensor, motion sensor, remote, lock, thermostat, phone, watch, ble beacon, ...) deciding whether a battery is plausible for that kind of subject | a suppress/repair choice battery: judge whether an open knowledge gap is worth pursuing at all, replacing the profile-keyword and battery-keyword rules with a Jev reading, mirroring how Home Graph triage (home-graph/triage.ts) makes the same kind of call |
| `sdk/src/platform/knowledge/semantic/self-improvement-graph.ts:105` | factCoverage classifies which feature 'areas' (display, ports, audio, network, smart, control) a device's facts cover using six fixed regexes, to judge how complete its knowledge profile is | quality pattern: score how complete a device's feature-area coverage is on a specificity rubric, replacing the six area regexes |
| `sdk/src/platform/knowledge/semantic/self-improvement-graph.ts:152` | repairTargetFactCount decides how many repaired facts count as 'enough' for a gap via a single regex test on the gap's own title/summary (complete/full/features/capabilities/specifications/profile -> requires 3 facts, otherwise 1) | a Jev reading of how much evidence a gap repair needs, replacing the complete/full keyword threshold |
| `sdk/src/platform/knowledge/semantic/self-improvement-intrinsic-gaps.ts:160` | shouldCreateIntrinsicFeatureGap (and the inline duplicate at line 70) decides whether a device's knowledge profile is complete enough to skip creating a new gap, using a fixed threshold on factCoverage's area classification (self-improvement-graph.ts): fewer than 4 core facts or fewer than 3 covered areas triggers a new gap | existence check pattern: does the graph already know enough about this device, replacing the fixed 4-fact/3-area threshold with a banded existence/coverage reading |
| `sdk/src/platform/knowledge/semantic/self-improvement-promotion.ts:541` | isRepairFactCompatibleWithSubjects/textMatchesSubject (line 556) gate whether a promoted repair fact is actually written and linked to a given device subject, by naive substring containment between the fact's claimed-subject text and the candidate device's title/aliases/manufacturer/model, falling back to comparing model-number-shaped tokens extracted by regex | alignment pattern (entity match on a 3-level score): before writing a promoted fact's link to a device, confirm the fact is actually about that device, replacing the substring-containment and model-token-overlap check gating the write |
| `sdk/src/platform/knowledge/semantic/self-improvement-promotion.ts:319` | upsertSourceLinkedRepairProfileFact stamps a fixed confidence (90/82/76) and edge weight (0.96/0.84 or 0.95/0.82) purely from the caller-supplied authority tier ('official-vendor' vs other), a fixed lookup table rather than a graded judgment of how much to trust this specific fact | a banded quality/alignment reading in place of the fixed per-tier confidence and weight constants |
| `sdk/src/platform/knowledge/semantic/self-improvement.ts:600` | isBudgetError classifies whether a caught error represents budget/time exhaustion rather than a real failure, by regex-matching the error's message text for the words timeout, timed out, budget, deadline, or exceeded | a Jev reading of a failure's transience: was this a budget/time cutoff rather than a genuine failure, replacing the keyword regex over the raw error message |
| `sdk/src/platform/knowledge/semantic/service.ts:556` | answerNeedsForegroundRepair decides whether to block the response and run gap repair synchronously before answering: it requires the query to be about a specific subject, then triggers repair when the answer has no facts, no sources, or a confidence below a fixed 50-point cutoff | existence check pattern: judge whether the answer already has enough grounded evidence to return as-is, replacing the fixed 50-point confidence cutoff with a banded existence/quality reading |
| `sdk/src/platform/knowledge/semantic/utils.ts:137` | scoreSemanticText is the shared relevance-scoring primitive reused across this package (object-scope.ts, gap-repair.ts, answer-evidence.ts and others): it awards a fixed 12 or 6 points per query token found as a substring in the candidate text, with no graded distinction beyond token length | the shared primitive that each file's rerank/existence-check pattern replaces: relevance scoring becomes a Jev reading rather than a fixed per-token point score |
| `sdk/src/platform/knowledge/shared.ts:119` | scoreHaystack awards a flat 25 points per literal task-token substring match and 18 per scope-token match found anywhere in a joined haystack string, with the matched-token name folded into a free-text 'reason'; this is the core relevance score every knowledge retrieval path (search, packet building, consolidation candidate surfacing) is built on | the knowledge existence/rerank pattern: a typed relevance reading over whether and how well a candidate record answers the task, replacing literal substring scoring; 'reason' becomes the reading's own stated justification rather than a token echoed back |
| `sdk/src/platform/knowledge/source-quality.ts:59` | knowledgePageSourceQuality sums a hand-tuned score (discovery rank * 5, +24 base, +10/+6 by source type, +10 if a fixed keyword regex like /support/specifications?/manual/product/ matches the source URI text, -120 if isLowValueKnowledgePageSource) and knowledgePageSourceWeight rescales it into a 0.05-0.98 page weight; isLowValueKnowledgePageSource itself matches fixed commerce-keyword regexes and a fixed retailer-domain regex against joined title/summary/description/url text to decide a source is low-value (shopping/marketplace) rather than genuine reference material | the knowledge source-quality specificity rubric: a scored reading over the source's title/summary/URL judging how usable and non-commercial it is for a generated page, replacing the hand-tuned point sum and the commerce-keyword/retailer-domain regex classifier; the discovery-rank arithmetic and status gating stay code |
| `sdk/src/platform/knowledge/store-config.ts:58` | DEFAULT_NODE_AUTO_ACCEPT_CONFIDENCE is a single fixed number (40), chosen to sit just below the confidence levels the existing deterministic producers emit (facts at 45, wiki pages at 55), that gates whether a newly synthesized node auto-activates or is held as a draft pending human review; this is the whole gated-write mechanism for the knowledge graph | the knowledge gated-write pattern's confirm/escalate bands, replacing the single hard-coded auto-accept number with a reviewable band boundary; producers keep emitting a confidence-like signal but the accept/hold-for-review line becomes part of the judgment battery's threshold table rather than a constant buried in this file |
| `sdk/src/platform/knowledge/store-node-history.ts:82` | resolveNodeActivation auto-accepts a new/draft node as 'active' when confidence >= autoAcceptConfidence (a single configured number, default 40) and otherwise holds it as 'draft' pending review; an explicit producer-set status or a review with applied facts is honored as-is | the knowledge gated-write pattern: the same confirm/escalate reading described in store-config.ts drives this activation decision, replacing the bare numeric comparison; the append-only revision bookkeeping and edge re-pointing on merge stay code |

## observe (new)

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/runtime/cost/attribution.ts` | JEV | CostAttributionService: a cost view over LLM usage records with cache-aware pricing and time-window aggregation, attributable by agent, tool, hook, MCP server, model, provider and session. Pricing and aggregation are arithmetic over catalog rates, not judged. |
| `sdk/src/platform/runtime/cost/cost-origin.ts` | JEV | AsyncLocalStorage-scoped cost-attribution origin: records which tool call, hook, or MCP server caused the LLM usage inside the current async scope, so downstream cost attribution can be broken down by cause. |
| `sdk/src/platform/runtime/cost/pricing-seams.ts` | JEV | Builds the two pricing seams (priceUsage, priceProvenance) shared by the fleet registry and the orchestration engine, over one model-pricing resolver; unknown/subscription models price as null rather than a fabricated dollar figure. |
| `sdk/src/platform/runtime/cost/quota-window.ts` | JEV | QuotaWindowTracker: answers whether spawning N agents will likely exhaust a provider's rate/quota window, from observed 429s and rate-limit headers only; verdict is 'unknown' absent evidence, never a fabricated confident answer. |
| `sdk/src/platform/runtime/eval/baseline.ts` | JEV | Load/save/capture utilities for EvalBaseline records (JSON files on disk) and a text diff report between a stored baseline and a fresh eval run. |
| `sdk/src/platform/runtime/eval/format.ts` | JEV | Console/panel formatting helpers for an eval suite result and a CI gate result. |
| `sdk/src/platform/runtime/eval/gate-suites.ts` | JEV | The standing CI gate's all-floors-passing scenario set, driving the production PerfMonitor path with synthetic healthy fixtures. |
| `sdk/src/platform/runtime/eval/index.ts` | JEV | Barrel export for the eval harness: runner, scorecard, built-in suites, gate suites, baseline persistence, formatting, and the task-suite adapter. |
| `sdk/src/platform/runtime/eval/runner.ts` | JEV | EvalRunner: runs eval suites through production PerfMonitor/scorecard paths, computes mean suite score, and compares a fresh run against a baseline to produce a CI gate result (floor failures and point-drop regressions). |
| `sdk/src/platform/runtime/eval/scorecard.ts` | JEV | Converts a raw eval result into a weighted per-dimension scorecard (safety, quality, latency, cost, recovery); every input is a structured count, duration, dollar figure or boolean flag, not natural-language text. |
| `sdk/src/platform/runtime/eval/suites.ts` | JEV | Built-in benchmark suite set (core-performance, safety, etc.) exercising the production PerfMonitor and scoring path with a mix of real wall-clock timings and clearly-flagged synthetic fixtures. |
| `sdk/src/platform/runtime/eval/task-suite.ts` | JEV | Terminal-Bench-style external task-suite adapter: runs each task through an injected real session executor, then its shell verification script, and reports pass/fail per task (verification is exit-code based, deterministic). |
| `sdk/src/platform/runtime/eval/types.ts` | JEV | Core type definitions for the eval harness: scenario, raw result, scorecard, suite result, baseline, and gate result contracts. |

## observer

| File | Disposition | Note |
|---|---|---|
| `sdk/src/observer/index.ts` | PORT | SDKObserver interface (onEvent/onError/onTransportActivity/onAuthTransition), the invokeObserver error-isolation wrapper, and console/OpenTelemetry built-in observer adapters. |

## occasions

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/occasions/acknowledge.ts` | JEV | Records an owner acknowledgement (the third answer besides yes/no) as two ordered writes: the answer then the open item, so the item survives quiet and enumerable; also composes the fixed two-sentence acknowledgement reply. |
| `sdk/src/platform/occasions/cadence.ts` | JEV | Pure calendar-day and served-boundary arithmetic for the nudge cadence: item ids, the lead/day-of boundary, the away-adjusted day-of date, the later-return date, and reconciling old unbounded raise counts into the two-boundary ledger. All deterministic date math and record transforms, not guesswork. |
| `sdk/src/platform/occasions/capture.ts` | JEV | Proposes and confirms an occasion or plan capture and handles removal; the occasion kind (gift-giving, remember-only, neither) is explicitly never inferred, capture refuses to write until the owner states it, asking a fixed three-way question when it is missing. |
| `sdk/src/platform/occasions/dates.ts` | JEV | Calendar-date arithmetic for occasions: parsing MM-DD/YYYY-MM-DD, leap-year handling, next occurrence, day differences, timezone-aware today and minutes-of-day. All deterministic date arithmetic over fixed formats. |
| `sdk/src/platform/occasions/destinations.ts` | JEV | Resolves the configured comma-separated nudge destination list against a hardcoded forbidden-surface set (TUI is refused structurally) and composes the destination-specific delivery text, framing the agent's own conversation with a self-contained notice. Deterministic list handling, not a decision point. |
| `sdk/src/platform/occasions/grammar.ts` | JEV | The one prose-line grammar for an occasion and a plan: splits a line into title and attribute segments by a fixed separator, classifies each segment by shape (date, recurrence word, kind word, lead-N, for-whom, mirrored, range) against a small fixed vocabulary the format itself defines, and renders lines back. This is fixed-format parsing of a documented mini-grammar, not free-text guesswork; the kind vocabulary is read, never inferred from the title. |
| `sdk/src/platform/occasions/index.ts` | JEV | Barrel file exporting the occasion/plan shapes, date and grammar helpers, nudge composition, subject resolution, acknowledge/interview/reader/policy/sweep/destinations/cadence helpers, and the service's own view types; deliberately does not export the service, state store, sweep loop or capture flow classes themselves. |
| `sdk/src/platform/occasions/interview.ts` | JEV | Builds the short gift-interview question sequence; opens the first question from a profile line about the person's interests, picked by matching a fixed English keyword list (likes, loves, into, enjoys, hobby, favourite, etc.) against the person's profile lines, falling back to a generic question when nothing matches. Never recommends a gift itself, only asks questions. |
| `sdk/src/platform/occasions/nudge.ts` | JEV | Composes nudge and conflict message text; converts a day count to a proximity word (imminent/soon/approaching) by fixed numeric thresholds, joins subject names, and builds the self-contained agent-conversation notice. The date itself never appears in any composed text. Threshold-on-a-number classification, not guesswork over prose. |
| `sdk/src/platform/occasions/pending.ts` | JEV | Pure composition of the pull view (occasions.pending): partitions open nudge items into unacknowledged and acknowledged, scoped same-day agent de-duplication, and builds conflict messages for still-open conflicts. Deterministic set/map bookkeeping. |
| `sdk/src/platform/occasions/policy.ts` | JEV | Reads the occasions.* config keys live into a typed OccasionsPolicy with bool/int/text coercion and clamped ranges, plus the shared daemon.timezone read. Deterministic config coercion. |
| `sdk/src/platform/occasions/push.ts` | JEV | Pushes one nudge to every configured destination independently, recording a per-destination delivered/failure outcome rather than throwing, and stamps items as spoken-to-agent for the day once a push actually lands. |
| `sdk/src/platform/occasions/reader.ts` | JEV | Reads the owner's profile prose into typed occasions and plans via the grammar, resolves each occasion's subject against the owner's declared names, and surfaces duplicate-id declarations with disagreeing dates as conflicts rather than silently taking the newer one. |
| `sdk/src/platform/occasions/service.ts` | JEV | OccasionsService, the one object every occasions verb goes through: list/listPlans/disclose/giftHistory reads, propose/confirm/remove capture, answer (yes/no/later), the gift interview flow with auto-acknowledge while the owner is choosing a gift, the sweep (reap, decide, mirror, deliver, remember), pending, and acknowledge/resolveConflict. Owns sequencing only; the judged decisions live in interview.ts and capture.ts. |
| `sdk/src/platform/occasions/state-store.ts` | JEV | The machine-owned persisted state for occasions: acknowledgements, gift history, open items, interviews and calendar mirrors, each validated record-by-record on load (a bad record is dropped and counted, not fatal), capped, reaped on a schedule, and disclosed; also reconciles legacy unbounded raise counts into the two-boundary ledger at load time. |
| `sdk/src/platform/occasions/subject.ts` | JEV | Resolves who an occasion is about (owner/other/unattributed) through layered evidence: an explicit self-declaration word on the line (SELF_WORDS: me, myself, mine, self, a fixed controlled vocabulary the grammar itself defines), a named person checked against the owner's declared aliases, or a possessive title checked the same way; unattributed is the deliberate safe default. The self-word list and possessive-apostrophe pattern are fixed-format grammar tokens the format's own spec defines, not free-text guesswork; also decides whether a subject may ever be pushed (never for the owner's own remember-only occasions). |
| `sdk/src/platform/occasions/sweep.ts` | JEV | The whole due-for-raising decision as one pure function: applies, in order, enabled, active-hours, kind-neither, lead-window, owner-subject-never-pushed, already-answered, mirrored-suppression and the two-boundary served-ledger gate, batching everything that survives into one nudge. Every rule is a deterministic comparison over dates, counts and enum answers already captured elsewhere (kind, subject, answer), not itself a guess about meaning. |
| `sdk/src/platform/occasions/ticker.ts` | JEV | The self-rearming timer that runs the sweep on a live-read interval, serializing passes and re-arming after a failed pass. Deliberately dumb; carries no judgment. |
| `sdk/src/platform/occasions/types.ts` | JEV | Shapes for occasions, plans, acknowledgements, gift records, calendar mirrors, open items, nudges and interviews, plus their enum constants and type guards (kind, subject, answer, ack-source, raise boundary). |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/occasions/capture.ts:178` | when the owner has not stated a kind, the code always asks the same fixed three-option question ('one you'll want to sort something for, one to just remember, or neither') with no attempt to suggest which fits the occasion; the old code deliberately has no heuristic here because a wrong guess (a cheerful gift prompt against a death anniversary) would be genuinely bad | a gated choice reading over the occasion title/person (solemn-remembrance vs celebratory-gift-giving) that only ever produces a suggested default to show alongside the fixed question, never an auto-applied answer; the write path keeps refusing until the owner's own words confirm a kind, so 'never inferred' holds exactly as it does today, this is a new assistive suggestion layered on an unchanged refusal, not a replacement of an existing guess |
| `sdk/src/platform/occasions/interview.ts:39` | INTEREST_WORDS, a fixed list of about 17 English words/phrases (likes, loved, into, enjoys, collects, wants, obsessed, keeps talking about, hobby, favourite, fan of, reading, plays, etc.), matched by substring against each profile line about the person to guess which line expresses an interest, with an honest fallback to a generic opening question when nothing matches, documented in the file's own comment as 'a small heuristic with an honest fallback rather than a classifier' | an existence pattern over the person's profile lines (does any line express an interest, and which one) paired with a rerank to choose the single best opening line when more than one qualifies, replacing the keyword-substring match; the honest generic-question fallback stays the behavior when the existence check comes back negative |

## operator and peer clients

| File | Disposition | Note |
|---|---|---|
| `daemon-sdk/src/operator.ts` | PORT | Dispatches operator HTTP routes by regex-matching fixed URL path patterns (e.g. approvals claim/approve/deny/cancel from the path segment), not text meaning. |
| `operator-sdk/src/client-core.ts` | PORT | Low-level operator remote client: typed invoke()/stream() over the operator contract plus named per-family facades (sessions, tasks, approvals, providers, control, telemetry). |
| `operator-sdk/src/client.ts` | PORT | createOperatorSdk factory: wires the HTTP transport, operator contract and Zod schema registry into the OperatorSdk facade with dispose lifecycle hooks. |
| `operator-sdk/src/index.ts` | PORT | operator-sdk package barrel export. |
| `operator-sdk/src/schema-registry.ts` | PORT | Builds a methodId-to-Zod-schema registry by naming convention, scanning the contracts package's exported symbols for a matching schema name. |
| `peer-sdk/src/client-core.ts` | PORT | Low-level peer remote client: typed invoke() over the peer contract plus named facades (pairing, peer heartbeat, work pull/complete, operator snapshot). |
| `peer-sdk/src/client.ts` | PORT | createPeerSdk factory: wires the HTTP transport and peer contract into the PeerSdk facade with dispose lifecycle hooks. |
| `peer-sdk/src/index.ts` | PORT | peer-sdk package barrel export. |
| `transport-core/src/errors.ts` | PORT | Normalizes an unknown thrown value into a typed transport Error, describing it for logs and deciding 'recoverable' from a closed, fixed set of known network error codes (POSIX errno names, undici UND_ERR_* codes, 'fetch failed'). Deterministic code matching against a documented closed set, not free-text judgment; no decision points. |

## orchestration (workstreams, ported)

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/orchestration/attempts.ts` | JEV | Best-of-N sibling attempts for a work item; the winner is chosen by the select pattern. |
| `sdk/src/platform/orchestration/bookkeeping.ts` | PORT | Post-phase bookkeeping failure classification for a workstream phase. |
| `sdk/src/platform/orchestration/budget.ts` | PORT | Budget enforcement before a new agent is spawned. |
| `sdk/src/platform/orchestration/cancellation.ts` | PORT | Per-work-item cancellation registry. |
| `sdk/src/platform/orchestration/dependency-gate.ts` | PORT | Per-tick dependency pre-pass over work items. |
| `sdk/src/platform/orchestration/dirty-guard.ts` | PORT | Keeps a scoped commit from sweeping in unrelated uncommitted changes. |
| `sdk/src/platform/orchestration/elastic-pool.ts` | PORT | Spawns an agent for a ready task when none is free. |
| `sdk/src/platform/orchestration/engine.ts` | PORT | OrchestrationEngine: owns workstream state and drives the phase pipeline. |
| `sdk/src/platform/orchestration/graph-dynamics.ts` | PORT | Runtime changes to the workstream dependency graph. |
| `sdk/src/platform/orchestration/index.ts` | PORT | Barrel for the orchestration modules. |
| `sdk/src/platform/orchestration/judge.ts` | JEV | Best-of-N judge; the model call that scores candidates becomes the select pattern. |
| `sdk/src/platform/orchestration/persistence.ts` | PORT | Schema-versioned persistence of workstreams with a debounced writer. |
| `sdk/src/platform/orchestration/phase-runner.ts` | PORT | Runs one work item through one phase: spawn agent, await completion, verify claims, run gates, commit. |
| `sdk/src/platform/orchestration/proposal-workstream.ts` | PORT | Turns an approved plan proposal into a workstream; its commit-scope setting moves off wrfc-config. |
| `sdk/src/platform/orchestration/review-task-source.ts` | PORT | Review findings as a second task source feeding the workstream engine; its commit-scope setting moves off wrfc-config. |
| `sdk/src/platform/orchestration/scheduler.ts` | PORT | Pure capacity-matching of ready work to agents. |
| `sdk/src/platform/orchestration/types.ts` | PORT | The orchestration model: workstreams, phases, work items and events. |
| `sdk/src/platform/orchestration/workstream-attempts-validation.ts` | PORT | Validates best-of-N attempt counts on work items. |
| `sdk/src/platform/orchestration/workstream-draft-edits.ts` | PORT | Edits to a workstream draft before launch. |
| `sdk/src/platform/orchestration/workstream-draft-store.ts` | PORT | Stores workstream drafts with an abandonment TTL. |
| `sdk/src/platform/orchestration/workstream-draft-types.ts` | PORT | Types for workstream drafts and their provenance. |
| `sdk/src/platform/orchestration/workstream-services.ts` | PORT | Session-facing workstream engine services and draft bookkeeping. |
| `sdk/src/platform/orchestration/worktree-isolation.ts` | PORT | Per-work-item git worktree isolation. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/orchestration/attempts.ts:None` | best-of-N winner picked by the attempt judge | select pattern (candidate selection over the sibling attempts, or none) |
| `sdk/src/platform/orchestration/judge.ts:None` | a free model call scores held-merge candidates and proposes a winner | select pattern (pick one candidate or none) with a fit yes/no per candidate |

## owner profile, personal capture

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/owner-profile/consumers.ts` | PORT | consumers.ts, every place that used to hold or guess a fact about the owner, reading it from here instead. |
| `sdk/src/platform/owner-profile/context-block.ts` | PORT | context-block.ts, the open tier, rendered for system context. |
| `sdk/src/platform/owner-profile/disclosure.ts` | PORT | disclosure.ts, the one-line receipt. |
| `sdk/src/platform/owner-profile/document.ts` | PORT | Parses and renders the owner-profile markdown document: sections, field lines, code fences, provenance suffixes and 'was:' supersede comments. All regexes here match a fixed markdown structure, not free-text meaning. |
| `sdk/src/platform/owner-profile/fields.ts` | PORT | fields.ts, the mechanical field registry. |
| `sdk/src/platform/owner-profile/index.ts` | PORT | owner-profile/, what the platform knows about the person who owns it. |
| `sdk/src/platform/owner-profile/paths.ts` | PORT | paths.ts, where the profile lives. |
| `sdk/src/platform/owner-profile/store-load.ts` | PORT | store-load.ts, getting the profile's bytes off disk, and deciding what they are. |
| `sdk/src/platform/owner-profile/store.ts` | PORT | Loads, watches and writes the owner-profile document, and exposes field, section and provenance lookups. person() searches profile prose for a name with an exact (case-insensitive) word-boundary regex, not a similarity score, so it is a literal lookup rather than a judged match. |
| `sdk/src/platform/owner-profile/store-types.ts` | PORT | store-types.ts, the input and view shapes `store.ts` takes and answers with. |
| `sdk/src/platform/owner-profile/trust.ts` | PORT | Deterministic two-pass taint check deciding whether a profile write or removal carries command authority, refusing writes derived from untrusted content read earlier in the turn. This is the security/taint boundary the intent marks as staying code, not a judged decision; the 'fuzzy' word in a comment describes a bounded length check, not actual similarity scoring. |
| `sdk/src/platform/owner-profile/types.ts` | PORT | Type definitions for profile surfaces, provenance, lines, sections and write results; no logic. |
| `sdk/src/platform/owner-profile/writer.ts` | PORT | writer.ts, surgical line edits, never a re-serialisation. |
| `sdk/src/platform/personal-capture/authority.ts` | PORT | personal-capture/authority.ts Decides whether the turn now being answered may write to the owner's profile. |
| `sdk/src/platform/personal-capture/index.ts` | PORT | personal-capture, recording what the owner tells you about himself. |
| `sdk/src/platform/personal-capture/port.ts` | PORT | personal-capture/port.ts The narrow surface the capture tool needs, and the holder that lets a composition root hand it over after the tool has already been registered. |
| `sdk/src/platform/personal-capture/spawn-contract.ts` | PORT | Builds the fixed system-prompt text and spawn options for a conversational capture turn, including a static complaint-handling instruction ladder. The tool list and instruction strings are hardcoded, not learned or classified. |

## payments

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/payments/address.ts` | JEV | Reads and fills the owner's stored shipping and billing addresses onto a checkout; deterministic field completeness checks, no guesswork. |
| `sdk/src/platform/payments/browser-checkout-driver.ts` | JEV | Implements the checkout page driver over a real browser engine, with guard-identity checks and pre-click vs post-click failure classification by exact error class name; deterministic. |
| `sdk/src/platform/payments/budget.ts` | JEV | The three daily budget pools (item, overage, tolerance) and reserve/commit/release arithmetic; deterministic money arithmetic, stays code. |
| `sdk/src/platform/payments/card-material.ts` | JEV | The in-process port that reads stored card material and renders one field's typed value; deterministic, no guesswork. |
| `sdk/src/platform/payments/card-redaction.ts` | JEV | Scrubs live card material out of page-derived text by literal and digit-run matching; card-shape/security scanning, stays code per the intent's deterministic-boundary rule. |
| `sdk/src/platform/payments/cart.ts` | JEV | Compares the cart against the owner's request and detects a recurring/subscription charge in the checkout's order-summary text. |
| `sdk/src/platform/payments/checkout-extraction.ts` | JEV | Turns a raw checkout reading's strings into integers via money-parsing and cross-checks the page's stated total; deterministic, no guesswork. |
| `sdk/src/platform/payments/checkout-flow.ts` | JEV | Orchestrates the whole purchase (gates, taint, merchant classification, extraction, cart check, recurring check, decision, reservation, notice window, fill, submit, record); calls the decision points recorded in cart.ts, merchant-judge-model.ts and notice-delivery.ts but adds no new guesswork of its own. |
| `sdk/src/platform/payments/checkout-page.ts` | JEV | The narrow port of page operations (fill, fillSecrets, choose, submitOrder) a purchase needs; deterministic, merchant-agnostic. |
| `sdk/src/platform/payments/checkout-reading-input.ts` | JEV | Shape and bounds validation of a checkout reading supplied over the control plane; deterministic, no interpretation of meaning. |
| `sdk/src/platform/payments/checkout-registry.ts` | JEV | Durable registry of which purchase is in flight on a browser page, and crash-recovery phase verdicts; deterministic state machine. |
| `sdk/src/platform/payments/day.ts` | JEV | Timezone-aware calendar-day computation for the daily budget reset; deterministic date arithmetic, stays code. |
| `sdk/src/platform/payments/decide.ts` | JEV | The pure decision order (budget, ceiling, overage pool, shipping ladder) over an already-gated purchase; deterministic money arithmetic. |
| `sdk/src/platform/payments/entry-surface.ts` | JEV | Which surfaces may accept typed card details, and a card-shape scan of inbound messages to refuse card entry elsewhere; the card-shape scan is explicitly a deterministic security check, not a judged decision, per the intent. |
| `sdk/src/platform/payments/fill-card.ts` | JEV | Reads the stored card and types it into the page once a purchase has been decided and armed; deterministic ordering and refusals. |
| `sdk/src/platform/payments/gates.ts` | JEV | Step 0 terminal gates (enabled, card, address, owner-direct, leader); deterministic boolean checks with no guesswork. |
| `sdk/src/platform/payments/index.ts` | JEV | The payment capability's public re-export surface; no logic of its own. |
| `sdk/src/platform/payments/marketplace-listing.ts` | JEV | Evaluates one marketplace listing (fixed-price vs auction, seller reputation numeric thresholds) read from the platform's own trusted widget; deterministic threshold comparison over structured, platform-attributed figures, not free-text guesswork. |
| `sdk/src/platform/payments/merchant-judge-model.ts` | JEV | Builds a prompt from a fixed criterion and the validated registrable domain, sends it to a helper model, and parses the JSON verdict into qualifies/confident/recourse/marketplace; this is the merchant-qualification and recourse-category judgement the intent names for payments. |
| `sdk/src/platform/payments/merchant-recourse.ts` | JEV | Composes the merchant judgement (from merchant-judge-model.ts) with owner overrides and marketplace policy into a final major/not-major verdict; the guesswork itself lives in the injected judge port (merchant-judge-model.ts), this file's own precedence logic is deterministic. |
| `sdk/src/platform/payments/message.ts` | JEV | Renders the approval, veto, cancellation and confirmation notices from a closed struct of typed scalars; deterministic string formatting, never merchant text. |
| `sdk/src/platform/payments/money-parsing.ts` | JEV | Parses a checkout page's amount and quantity strings into exact integer minor units by a strict grammar, refusing anything ambiguous; deterministic arithmetic parsing, stays code per the intent. |
| `sdk/src/platform/payments/notice-delivery.ts` | JEV | Sends the approval/veto notice over the channel router and reads the owner's inbound reply; this is the approval-and-veto reply reading the intent names for payments. |
| `sdk/src/platform/payments/order-correlation.ts` | JEV | Correlates an inbound confirmation email to a recent purchase by registrable domain and time window, and extracts order number, ship date and tracking reference from the confirmation body. |
| `sdk/src/platform/payments/payment-ports.ts` | JEV | The two composition-supplied ports (purchase ledger, payment notifier) the checkout flow spends and speaks through; type definitions only. |
| `sdk/src/platform/payments/payments-config.ts` | JEV | Reads the daemon's live payments settings (budgets, timezone, window minutes, merchant policy) from config at the moment of use; deterministic config parsing with safe fallbacks. |
| `sdk/src/platform/payments/payments-gateway-service.ts` | JEV | The daemon-side service binding the payments.checkout.* verbs to the flow, plus boot-time recovery of interrupted checkouts; deterministic orchestration and timeouts. |
| `sdk/src/platform/payments/purchase-record.ts` | JEV | One audit-ledger row shape for a completed purchase; type definition only. |
| `sdk/src/platform/payments/shipping.ts` | JEV | Ranks a checkout's delivery options and walks the one-rung-at-a-time shipping ladder within the overage budget; deterministic ordinal ranking by cost, never by delivery-day wording. |
| `sdk/src/platform/payments/taint-gate.ts` | JEV | Refuses a purchase whose item, ceiling, merchant or checkout url derives from untrusted content; deterministic taint check, stays code per the intent. |
| `sdk/src/platform/payments/types.ts` | JEV | The payment capability's vocabulary: minor units, currency codes, the owner-supplied-text brand, command-authority channels, refusal codes; type definitions and deterministic validators. |
| `sdk/src/platform/payments/windows.ts` | JEV | The approval-gate and veto-window state machines and their deliberately opposite silence rules, plus interrupted-window recovery; deterministic state transitions. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/payments/cart.ts:118` | RECURRING_PATTERNS, a fixed list of regexes over the merchant's order-summary text (subscri.., recurring, auto-renew, per month/year, free trial, save card for future) matched in detectRecurringCharge to decide if a checkout enrolls a recurring charge | battery yes/no (noul) question: "does this order summary describe a recurring or subscription charge?", banded so any non-confident or positive answer refuses the purchase (conservative-by-design, matching today's refuse-on-any-match behavior) |
| `sdk/src/platform/payments/merchant-judge-model.ts:61` | RESPONSE_INSTRUCTIONS, a hand-written prompt asking the model for a JSON object {qualifies, confident, recourse, marketplace}, plus parseVerdict (line 87) parsing that free-text/JSON answer into a typed verdict, in createModelMerchantJudge (line 134) | choice-over-options reading ("does this registrable domain qualify as an established retailer with real recourse: yes / no / not confident") plus a short choice reading for marketplace kind (none / buyer-protection / per-seller), banded so not-confident and no both resolve to not-qualifying, matching the intent's merchant-qualification and recourse-category batteries |
| `sdk/src/platform/payments/notice-delivery.ts:118` | APPROVAL_WORDS and VETO_WORDS, two hand-written keyword maps (approve/approved/yes/y/ok/okay/go/buy it -> approve; deny/denied/no/n/cancel/stop/don't -> deny; and the mirrored veto map where go/ok/yes/approve acknowledge and stop/no/cancel/wait/don't/hold object), read in parsePaymentReply (line 141) by exact or first-word match | the judgment package's reply pattern (read a human reply: approve, reject, amend, unclear) run twice, once for the approval-window vocabulary (approve/deny) and once for the veto-window vocabulary (acknowledge/object), so the same words can be read oppositely on the two windows exactly as today, with an unclear reading falling through to the window's own silence rule |
| `sdk/src/platform/payments/order-correlation.ts:176` | ORDER_NUMBER, SHIP_DATE and TRACKING, three regexes over the confirmation email body text, run in extractConfirmationFacts (line 187) to pull out an order number, a ship date and a tracking reference | the judgment package's structure-recovery pattern (extract named structured fields, order number / ship date / tracking reference, from free text, with a null field when none is found) in place of the three regexes; the domain and time-window correlation logic itself stays deterministic |

## presentation

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/presentation/glyphs.ts` | PORT | Fixed table of UI glyphs and status-state icon assignments shared by the TUI and agent renderers. |
| `sdk/src/platform/presentation/index.ts` | PORT | Re-exports ./glyphs.js, ./thinking-phrases.js, ./tones.js, ./waiting-wording.js. |
| `sdk/src/platform/presentation/thinking-phrases.ts` | PORT | thinking-phrases.ts, the rotating "thinking" phrase pool, hoisted from `goodvibes-tui` src/renderer/ui-factory.ts (THINKING_PHRASES). |
| `sdk/src/platform/presentation/tones.ts` | PORT | tones.ts, the canonical UI tone-token table, hoisted from `goodvibes-tui` src/renderer/ui-primitives.ts (UI_TONES + DIFF_TONES + SPINNER_FRAMES) and src/renderer/theme.ts (resolveUiTones / UI_TONES_LIGHT). |
| `sdk/src/platform/presentation/waiting-wording.ts` | PORT | waiting-wording.ts, the honest waiting-state WORDING contract, extracted from `goodvibes-tui` src/renderer/ui-factory.ts:554-584 (the phrase-selection branch inside createThinkingFragment; the companion :522-552 computeS |

## principals

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/principals/index.ts` | JEV | Barrel file re-exporting the principal registry, store, and the identity/sentinel types and helpers. |
| `sdk/src/platform/principals/registry.ts` | JEV | CRUD gateway over the principal store plus resolveByIdentity, which maps one channel-specific sender identity to its principal by an exact {channel, value} key lookup, falling back to the honest unknown principal when nothing matches; identity uniqueness is enforced as a hard invariant (create/update refuse a conflicting identity rather than reattaching it). |
| `sdk/src/platform/principals/store.ts` | JEV | Durable JSON-snapshot persistence for the principal registry, following the same versioned-document PersistentStore pattern as other registries. |
| `sdk/src/platform/principals/types.ts` | JEV | The principal identity model: PrincipalKind union, PrincipalIdentity/PrincipalRecord shapes, the unknown- and owner-principal sentinels, and identity normalization/key helpers. All deterministic. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/principals/registry.ts:205` | resolveByIdentity does only exact-key matching against identities the caller already registered by hand; there is no code today that looks at two different channel identities (a Slack id and an email address, say) and decides they belong to the same person, so there is no automatic cross-channel merge to replace, only the deliberately narrow exact lookup this file documents as never guessing | the principals entity-alignment pattern: when an unmapped identity resolves to unknown, run an alignment reading (a 3-level entity-match score) against existing principals' known identities and profile context to propose a same-person merge; the proposal is still gated behind an explicit create/update call (the CONFLICT-on-reattach invariant stays code), so the honest-unknown behavior for a genuinely new person is unchanged |

## profiles, templates

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/profiles/index.ts` | PORT | Barrel file re-exporting ProfileManager and the profile shape helpers. |
| `sdk/src/platform/profiles/manager.ts` | PORT | ProfileManager saves, loads, lists and deletes named host config profiles (display, provider and behavior settings) as JSON files. |
| `sdk/src/platform/profiles/shape.ts` | PORT | Converts a config snapshot to and from ProfileData by walking the config schema for display, provider and behavior keys. |
| `sdk/src/platform/templates/index.ts` | PORT | Barrel file re-exporting TemplateManager. |
| `sdk/src/platform/templates/manager.ts` | PORT | TemplateManager saves, loads, lists, deletes and expands named prompt templates with {{var}} substitution and bounded depth template inclusion. |

## providers

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/discovery/scanner.ts` | PORT | Scans localhost and the local /24 subnet for OpenAI-compatible local model servers (Ollama, LM Studio, vLLM, llama.cpp, etc.), persists discoveries to disk, and queries each server for context-window and output-limit metadata. Functionally this is provider discovery (finding usable model providers), which is why it is filed under 'providers' rather than the intent's 'discovery, mcp, plugins, acp' row (workspace/MCP scanning); flagged for the coordinator as an interpretive call. |
| `sdk/src/platform/providers/amazon-bedrock-mantle.ts` | PORT | Bedrock Mantle model adapter: dated fallback model list plus live ListFoundationModels discovery, reusing Bedrock's SigV4 signing. |
| `sdk/src/platform/providers/amazon-bedrock.ts` | PORT | Amazon Bedrock provider adapter: SigV4-signed invoke and list calls, with a dated fallback model list refreshed by live discovery. |
| `sdk/src/platform/providers/anthropic-compat.ts` | PORT | Anthropic-compatible HTTP provider adapter (non-SDK path): request and response mapping, retries, tool formats. |
| `sdk/src/platform/providers/anthropic-sdk-provider.ts` | PORT | Anthropic provider built on the official SDK client: streaming, tool formats, stop-reason mapping, reasoning. |
| `sdk/src/platform/providers/anthropic-sse-assembler.ts` | PORT | Assembles Anthropic SSE stream events into content blocks and stop reasons. |
| `sdk/src/platform/providers/anthropic-stream.ts` | PORT | Shared Anthropic reasoning-effort helpers deciding which request field (thinking budget vs output_config.effort) a given model version accepts; a deterministic version-based rule, not a judgment. |
| `sdk/src/platform/providers/anthropic.ts` | PORT | Direct Anthropic API provider: chat, streaming, batch adapter, cache strategy, live model discovery. |
| `sdk/src/platform/providers/anthropic-vertex.ts` | PORT | Claude-on-Vertex-AI provider; defers the Anthropic SDK and google-auth-library imports to a runtime factory since both are optional dependencies. |
| `sdk/src/platform/providers/auto-register.ts` | PORT | Auto-registers providers whose API key environment variables are present, using catalog data; handles multi-endpoint providers. |
| `sdk/src/platform/providers/builtin-catalog.ts` | PORT | Static catalog of built-in OpenAI-compatible and Anthropic-compatible provider definitions: base URLs, default models, env vars. |
| `sdk/src/platform/providers/builtin-registry.ts` | PORT | Constructs and registers every built-in provider instance plus the catalog provider name aliases. |
| `sdk/src/platform/providers/cache-capability.ts` | PORT | Type definitions for a provider's prompt-cache capability (explicit, automatic, implicit, none) and its pricing terms. |
| `sdk/src/platform/providers/cache-planner.ts` | PORT | Plans prompt-cache breakpoint placement per turn: a fixed heuristic by default, or an optional helper-model call for optimization. |
| `sdk/src/platform/providers/cache-strategy.ts` | PORT | Computes the default cache-breakpoint placement strategy from a provider's declared cache capability. |
| `sdk/src/platform/providers/capabilities.ts` | PORT | Unified per-provider and per-model capability registry (streaming, tool calling, etc.) used for routing decisions. |
| `sdk/src/platform/providers/context-discovery.ts` | PORT | Probes a local provider's endpoints (LM Studio, Ollama, OpenAI-compat, llama.cpp, TGI) in order of verbosity to discover its context window size. |
| `sdk/src/platform/providers/context-window-fallback.ts` | PORT | Infers a conservative context-window size from the provider and model-id family when no catalog or API value is available. |
| `sdk/src/platform/providers/context-window-overrides.ts` | PORT | Persists user-set and observed (learned from provider rejections) context-window overrides per model. |
| `sdk/src/platform/providers/credential-authority-contract.ts` | PORT | Enforces that every registered provider declares how its credentials are obtained, and refuses providers that do not. |
| `sdk/src/platform/providers/credentials.ts` | PORT | Pure functions that resolve which provider ids currently have a configured API key. |
| `sdk/src/platform/providers/custom-loader.ts` | PORT | Loads user-defined custom provider configs (JSON files) from a watched directory and builds provider instances from them. |
| `sdk/src/platform/providers/discovered-compat.ts` | PORT | Thin OpenAI-compat subclasses for locally discovered server types: vLLM, llama.cpp, TGI, LocalAI. |
| `sdk/src/platform/providers/discovered-factory.ts` | PORT | Builds a provider instance for a locally discovered server from its declared server type and traits. |
| `sdk/src/platform/providers/discovered-traits.ts` | PORT | Fixed per-server-type trait table (adapter kind, capabilities, effort levels) for locally discovered servers. |
| `sdk/src/platform/providers/effort-levels.ts` | PORT | Fixed table of human-readable descriptions for each reasoning-effort level. |
| `sdk/src/platform/providers/fallback-model.ts` | PORT | Registers the configured model with an inferred context window and effort levels before the model catalog cache has loaded. |
| `sdk/src/platform/providers/favorites.ts` | PORT | Stores pinned and recently-used model entries on disk. |
| `sdk/src/platform/providers/gateway-pricing.ts` | PORT | Fetches and caches machine-readable per-model pricing from gateway providers' own /models endpoints. |
| `sdk/src/platform/providers/gemini.ts` | PORT | Google Gemini provider adapter: chat, streaming, embeddings, live model discovery. |
| `sdk/src/platform/providers/github-copilot.ts` | PORT | GitHub Copilot provider adapter: token exchange, chat via the OpenAI/Anthropic-compat paths, dated fallback model list. |
| `sdk/src/platform/providers/health.ts` | PORT | Pure provider-registry lookup helpers: find a registered provider by name with catalog-alias resolution. |
| `sdk/src/platform/providers/index.ts` | PORT | Public re-export barrel for the providers package's types and helpers. |
| `sdk/src/platform/providers/inline-reasoning.ts` | PORT | Splits a model's inline reasoning (a structured field or a <think> tag) out of its answer content on a fixed per-field/per-tag rule, so it never leaks into the transcript or export as ordinary answer text. |
| `sdk/src/platform/providers/interface.ts` | PORT | Core provider interface and shared types: ChatRequest/Response, capability contract, auth routes. |
| `sdk/src/platform/providers/json-ttl-cache.ts` | PORT | Shared on-disk TTL cache envelope helpers (staleness check) used by several provider caches. |
| `sdk/src/platform/providers/keyless-default.ts` | PORT | Derives whether the shipped default model truly works without an API key from the provider's own registered auth state, so onboarding copy cannot overclaim. |
| `sdk/src/platform/providers/launch-tolerant-registry.ts` | PORT | Builds a ProviderRegistry that never throws at boot due to a missing API key env var, by planting and then clearing placeholder keys. |
| `sdk/src/platform/providers/live-model-discovery.ts` | PORT | Shared fetch, cache and diff machinery so a provider's live model list refreshes with an honest fallback chain: live fetch, on-disk cache, packaged static list. |
| `sdk/src/platform/providers/llama-cpp.ts` | PORT | llama.cpp server provider adapter built on the OpenAI-compat base class. |
| `sdk/src/platform/providers/lm-studio-helpers.ts` | PORT | Shared request and response shaping helpers for LM Studio's OpenAI Responses-style API. |
| `sdk/src/platform/providers/lm-studio.ts` | PORT | LM Studio provider adapter: chat, tool calls, reasoning via the Responses API shape. |
| `sdk/src/platform/providers/local-context-ingestion.ts` | PORT | Fetches and caches a local or custom provider's per-model max_context_length from its /v1/models endpoint. |
| `sdk/src/platform/providers/microsoft-foundry-shared.ts` | PORT | URL-normalization helpers for Microsoft Foundry endpoint configuration. |
| `sdk/src/platform/providers/model-benchmarks.ts` | PORT | Fetches and caches published third-party model benchmark scores and derives a quality tier from them; the tiers are bucketed from fixed numeric benchmark thresholds, not text judgment. |
| `sdk/src/platform/providers/model-catalog-cache.ts` | PORT | Fetches and caches the models.dev catalog feed, transforming it into CatalogModel records with honest (never-coerced-to-zero) pricing and reasoning-option data. |
| `sdk/src/platform/providers/model-catalog-notifications.ts` | PORT | Diffs two catalog snapshots and formats plain-text change notifications for added, removed and changed models. |
| `sdk/src/platform/providers/model-catalog-synthetic.ts` | PORT | Groups catalog models from different providers into synthetic canonical failover models by family and normalized name, and scores the best backend by benchmark. |
| `sdk/src/platform/providers/model-catalog.ts` | PORT | Defines the CatalogModel/CatalogProvider shapes and the registry-backed ModelCatalog used for pricing lookups, tier labeling and capability-facts derivation. |
| `sdk/src/platform/providers/model-id-resolution.ts` | PORT | Resolves a user-typed bare model id or provider:model key against the live registry, disambiguating unique bare ids and suggesting closest matches by edit distance when unknown. |
| `sdk/src/platform/providers/model-limits.ts` | PORT | Fetches and caches OpenRouter's /models catalog to fill in context length, output cap and pricing gaps for models the registry has no other limits for. |
| `sdk/src/platform/providers/model-pricing.ts` | PORT | Resolves one (provider, model) pair's price with user-manual, registration, provider-served, then catalog precedence, and computes usage cost from resolved rates, keeping unpriced honestly distinct from free. |
| `sdk/src/platform/providers/model-source-contract.ts` | PORT | Registration-time check that every provider declares where its model list comes from (live discovery, dated static list, or catalog-backed), rejecting providers with an undeclared model source. |
| `sdk/src/platform/providers/ollama.ts` | PORT | Adapts chat/embed calls to Ollama's native NDJSON API, falling back to the OpenAI-compat client when the native call fails in an unsupported way. |
| `sdk/src/platform/providers/openai-codex.ts` | PORT | Chat client for the ChatGPT/Codex subscription surface (chatgpt.com/backend-api), using a dated-static model list and token refresh-then-retry on auth rejection. |
| `sdk/src/platform/providers/openai-compat-diagnostics.ts` | PORT | Pure helpers that fingerprint a chat request by shape and extract/format a diagnostic message from a failed OpenAI-compatible provider's error body and headers. |
| `sdk/src/platform/providers/openai-compat.ts` | PORT | Generic OpenAI-compatible chat/embeddings provider used for many backends (Mercury-2, OpenRouter, llama.cpp, etc.), handling streaming, tool-call accumulation, reasoning-format variants and live model-list refresh. |
| `sdk/src/platform/providers/openai-stream-delta.ts` | PORT | Normalizes divergent OpenAI-compatible streaming delta shapes (plain content, reasoning, reasoning_content, reasoning_summary, typed content arrays) into content and reasoning text fragment lists. |
| `sdk/src/platform/providers/openai-stream-helpers.ts` | PORT | Accumulates streaming OpenAI-format tool-call deltas, finalizes them, merges usage counters, and extracts text-embedded tool calls as a fallback when a model emits them as raw sentinel tokens instead of structured calls. |
| `sdk/src/platform/providers/openai.ts` | PORT | Wraps the official openai npm client for GPT-5-family chat/embeddings/batch, with a dated-static model list refreshed live at boot and on demand. |
| `sdk/src/platform/providers/optimizer.ts` | PORT | ProviderOptimizer selects a provider/model route via a deterministic capability-contract match (first capable candidate wins, explicitly no opaque scoring) with auto/manual/pinned modes and a fallback-transition log; the routing subsystem hoists provider comparison and routing from providers like this one, though this file itself makes no guessed judgment today. |
| `sdk/src/platform/providers/optional-bedrock.ts` | PORT | The one place the optional @anthropic-ai/bedrock-sdk package is dynamically loaded, so an install without it degrades gracefully instead of crashing the daemon at module init. |
| `sdk/src/platform/providers/optional-openai.ts` | PORT | The one place the optional openai npm package is dynamically loaded and its client constructed, for the same graceful-degradation reason as optional-bedrock.ts. |
| `sdk/src/platform/providers/provider-api.ts` | PORT | Composition-root API surface over the provider registry, favorites store and benchmark store: lists/selects models, manages favorites, benchmarks and runtime metadata queries. |
| `sdk/src/platform/providers/provider-error.ts` | PORT | Shared helpers extracting an HTTP status from a provider error object and wrapping it into a typed ProviderError. |
| `sdk/src/platform/providers/provider-model.ts` | PORT | Tolerant parsing of the provider:model config string into its provider and model halves, with a default fallback for a blank value. |
| `sdk/src/platform/providers/provider-not-found-error.ts` | PORT | Typed error thrown when a requested provider id is not registered, listing the currently-registered ids. |
| `sdk/src/platform/providers/provider-stop-reason.ts` | PORT | Small helpers resolving an 'unknown' stop reason to 'completed' when content was produced, and building the providerStopReason field. |
| `sdk/src/platform/providers/rate-limit-headers.ts` | PORT | Provider-agnostic parser for the rate-limit/quota headers (Anthropic, OpenAI-style, IETF draft, retry-after) that upstream LLM providers return. |
| `sdk/src/platform/providers/reasoning-effort-families.ts` | PORT | Curated per-model-family fallback table (Anthropic, Gemini, Grok, DeepSeek, OpenAI, Mercury) for what reasoning-effort controls a model accepts when the live catalog carries nothing for it. |
| `sdk/src/platform/providers/reasoning-effort.ts` | PORT | Central reasoning-effort model: severity ladder, per-model spec resolution and precedence (catalog, declared, family, fallback), snap-down mapping of a requested level onto what a model accepts, and rejection-message detection. |
| `sdk/src/platform/providers/registry-catalog-lifecycle.ts` | PORT | Extracted catalog init/refresh logic for ProviderRegistry: loads the on-disk cache at startup, and fetches/persists/applies/notifies a fresh catalog on refresh. |
| `sdk/src/platform/providers/registry-configured-ids.ts` | PORT | Computes which provider ids are currently configured, by env vars, config API keys (with a small fixed alias map), synthetic backend availability, and each provider's own isConfigured() check. |
| `sdk/src/platform/providers/registry-configured-model.ts` | PORT | ConfiguredModelFollower re-reads the provider.model config key at use time so a write made after boot is adopted, with last-write-wins precedence against an in-process model switch. |
| `sdk/src/platform/providers/registry-helpers.ts` | PORT | Small deterministic helpers: attach a registryKey to a model definition, strictly split a provider:model registry key, and a key-order-independent JSON stringify for diffing. |
| `sdk/src/platform/providers/registry-live-model-discovery.ts` | PORT | Owns the providerNativeModels bucket: seeds and sweeps live/dated-static model lists reported directly by each provider, independent of the shared catalog. |
| `sdk/src/platform/providers/registry-models.ts` | PORT | Builds the merged model registry from custom/runtime/provider-native/synthetic/catalog/discovered sources with precedence and suppression rules, and diffs custom-model sets for warnings. |
| `sdk/src/platform/providers/registry.ts` | PORT | ProviderRegistry, the central class managing provider instances, the merged model registry, pricing resolution, context-window overrides and model selection; findAlternativeModel's tier-matched failover and every lookup here are deterministic (exact id/alias/tier matching), not guesswork, though this is the file the routing subsystem's provider comparison and fallback logic is hoisted out of. |
| `sdk/src/platform/providers/registry-types.ts` | PORT | Type definitions for ModelDefinition, ProviderRegistryOptions and related registry shapes; no runtime behavior. |
| `sdk/src/platform/providers/runtime-metadata.ts` | PORT | Builds the standard per-provider auth-route descriptors (api-key, secret-ref, service-oauth, subscription-oauth, anonymous) and folds per-route truth into the aggregate configured/detail pair a provider reports. |
| `sdk/src/platform/providers/runtime-snapshot.ts` | PORT | Builds per-provider and per-model runtime/usage snapshots (auth state, models, resolved pricing with provenance) for runtime-metadata queries. |
| `sdk/src/platform/providers/session-cost.ts` | PORT | The one session-cost resolver: pricing precedence (free suffix, wired registry resolver, live catalog, small hand-maintained static fallback table, honest unpriced), the money arithmetic for session totals, and the budget-alert threshold plumbing. |
| `sdk/src/platform/providers/sse-line-buffer.ts` | PORT | Canonical SSE line buffer handling both LF and CRLF line endings per RFC 7230/W3C SSE spec. |
| `sdk/src/platform/providers/stop-reason-maps.ts` | PORT | Per-provider raw stop/finish/done-reason maps into a canonical ChatStopReason vocabulary (Anthropic, OpenAI, Gemini, llama.cpp, Ollama, Codex, LM Studio), plus context-overflow signal detection. |
| `sdk/src/platform/providers/synthetic.ts` | PORT | SyntheticProvider is the catalog-backed failover wrapper: canonical models with multiple provider backends tried in tier-isolated, key-aware order, cooldown-based rotation on billing/rate-limit/client/transient errors (classified by HTTP status code, a deterministic boundary), and cross-model fallback for the free tier. |
| `sdk/src/platform/providers/tier-prompts.ts` | PORT | Derives a model capability tier from its context-window size and returns tier-appropriate extra guidance text appended to the system prompt. |
| `sdk/src/platform/providers/tool-formats.ts` | PORT | Wire-format conversion for tool definitions/messages across OpenAI, Anthropic and Gemini call shapes, plus text-embedded tool-call extraction (fixed sentinel-token parsing) for models that emit calls as raw tokens. |
| `sdk/src/platform/providers/well-known-endpoints.ts` | PORT | Frozen maps of well-known local LLM service default base URLs and ports, used only for zero-config local discovery fingerprinting, never overriding user config. |
| `sdk/src/platform/runtime/provider-accounts/registry.ts` | PORT | Builds a per-provider account snapshot (which auth route is active/preferred, freshness, issues, recommended repair actions) from structured booleans and timestamps: API key present, subscription state and expiry, service OAuth state. Purely deterministic routing and freshness rules; no free-text judgment. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/discovery/scanner.ts:305` | identifyServer() (documented in its own comment as 'Heuristic identification of the server software') infers which local LLM server software answered from the response port plus substring matches on response headers and model-id strings ('lmstudio', 'x-vllm', 'llama', 'localai', 'text-generation-inference') | dispatch pattern: route the probe evidence (port, headers, model ids) to one of the known server-type labels as a closed-set choice, replacing the substring-match chain |
| `sdk/src/platform/providers/model-catalog-cache.ts:80` | classifies a provider id as subscription, shutdown, or normal by testing membership in two hardcoded provider-id sets plus a 'coding-plan' substring check | choice battery (closed set: subscription/shutdown/normal) or fold into the routing subsystem's provider classification, judged instead of matched against a hardcoded id list |
| `sdk/src/platform/providers/model-catalog-cache.ts:98` | decides a model is free by provider category plus a 'coding-plan' substring match on the model id, combined with a zero-cost check | fold into the same provider/model classification battery above so free-tier status is judged from catalog facts rather than string matching on the id |
| `sdk/src/platform/providers/model-catalog-synthetic.ts:50` | normalizes a model display name into a slug by stripping a hardcoded list of modifier words and date-like patterns via regex, used to decide which catalog entries are 'the same model' across providers for synthetic grouping | alignment pattern (entity match, 3-level score) deciding whether two catalog model entries name the same underlying model, replacing the regex-stripped slug comparison |
| `sdk/src/platform/providers/model-catalog.ts:81` | when no exact id match exists, falls back to substring/prefix matching (modelId.startsWith(model.id) // modelId.includes(model.id)) to decide a catalog entry is the queried model | alignment pattern (entity match) or the select pattern (pick one candidate or none) resolving model identity instead of substring matching |
| `sdk/src/platform/providers/model-catalog.ts:237` | buckets a model into 'premium' vs 'standard' tier by a hardcoded input-price threshold of $3 per 1M tokens | score-on-rubric battery banding a model's tier by price and capability instead of one hardcoded price cutoff |
| `sdk/src/platform/providers/model-id-resolution.ts:133` | suggests a 'did you mean' model id by nearest Levenshtein edit distance across every registered id when the typed id is unknown | this is a typo-correction helper over a closed, exact candidate list rather than a natural-language meaning judgment; flagged because it matches the brief's 'string-similarity thresholds for identity' category literally, for the coordinator to decide whether it stays code (deterministic edit distance, no ambiguity) or becomes a select/rerank reading |
| `sdk/src/platform/providers/model-limits.ts:125` | strips trailing date-like suffixes (8-digit date, YYMM, 6-digit date) from a model id via three regexes to guess its version-less 'stem' for matching | fold into the alignment-pattern entity match below; stem-stripping guesswork becomes part of that battery's own normalization |
| `sdk/src/platform/providers/model-limits.ts:132` | matches a provider's model id to an OpenRouter catalog entry by chained exact id, provider-prefixed id, date-suffix-stripped stem, and endsWith-suffix string comparisons | alignment pattern (entity match, 3-level score) resolving whether two model ids name the same model across catalogs, replacing the chained string-matching heuristics |
| `sdk/src/platform/providers/model-pricing.ts:77` | picks a per-provider cache-rate multiplier pair by testing whether the provider name contains one of four hardcoded vendor-name substrings (anthropic/openai/google/deepseek) | choice battery or plain config keyed by exact provider id (not a name substring); also touches the project's 'no vendor names in routing/tier rules' rule since it hardcodes vendor substrings, flagged for the coordinator |
| `sdk/src/platform/providers/ollama.ts:451` | decides whether to fall back from Ollama's native chat API to the OpenAI-compat path by testing HTTP status plus two regexes over the error message text ('tool/messages/unsupported' and 'not implemented/unsupported/unknown endpoint') | yes/no battery reading whether this provider error means 'native endpoint unsupported, fall back to the compat path', replacing the regex match on the error string |
| `sdk/src/platform/providers/openai-stream-delta.ts:57` | classifies a streamed content-array entry as 'reasoning' vs plain content by testing whether its type field string contains the substrings 'reason' or 'think' | this normalizes a small enumerable vendor wire vocabulary rather than open natural-language guesswork; flagged since it matches the brief's keyword-list decision-point category literally, for the coordinator to judge whether it stays code or becomes a classify/dispatch reading |
| `sdk/src/platform/providers/reasoning-effort-families.ts:32` | normalizes a model id for family matching by stripping known vendor/region routing prefixes (bedrock region.vendor., version suffixes, vertex @-snapshots, colon-routing suffixes) via a chain of regexes | fold into the choice battery below; id normalization becomes part of that battery's own preprocessing |
| `sdk/src/platform/providers/reasoning-effort-families.ts:93` | guesses a model's reasoning-effort capability (named levels vs token budget vs toggle vs none) by testing its normalized id against roughly twenty hardcoded regex patterns for known model family generations, used only when the live catalog carries no reasoning_options for that model | choice battery classifying which reasoning-control shape a given model most likely uses, replacing the regex-matched family table as the last-resort fallback (still ranked below the live catalog and any explicit declaration); this table is also vendor-and-model-name-based by design, worth a second look against the project's 'no vendor or model names in routing/tier rules' rule when routing is built |
| `sdk/src/platform/providers/reasoning-effort.ts:431` | decides whether a 400 error was caused by the requested reasoning-effort level by testing whether the provider's raw error text matches the regex /effort/reasoning/thinking/budget_tokens/i | yes/no battery reading whether this provider rejection was caused by an unsupported reasoning-effort setting, replacing the keyword regex over the error text |
| `sdk/src/platform/providers/session-cost.ts:130` | resolves pricing for an unrecognized model id by falling back to substring/prefix matching (modelId.startsWith(m.id) // modelId.includes(m.id)) against live-catalog entries | alignment pattern (entity match) for model identity resolution, replacing the substring/prefix heuristic |
| `sdk/src/platform/providers/session-cost.ts:141` | same substring/prefix fallback matching against the small hand-maintained STATIC_FALLBACK_PRICING table | same alignment-pattern entity match as above, applied to the static-fallback lookup |
| `sdk/src/platform/providers/stop-reason-maps.ts:96` | classifies Ollama's free-form done_reason string into completed/tool_call/max_tokens by testing regexes /tool/i and /length/max_tokens/i rather than an exact map, because Ollama's own vocabulary for this field is inconsistent across versions | choice battery classifying the provider's raw stop/done reason into the canonical stop-reason vocabulary, replacing the regex guess for backends with no fixed enum |
| `sdk/src/platform/providers/tier-prompts.ts:22` | buckets a model into free/standard/premium tier by two hardcoded context-window thresholds (128K, 32K) to decide how much extra prompt guidance to inject | coarsen pattern or score-on-rubric battery classifying model capability tier from context window and other model facts, replacing the two fixed thresholds, bands scaled to the low stakes of this decision (more guidance text vs less) |

## runtime

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/runtime/agent-graph-composition.ts` | PORT | Composes the six required daemon-grade agent-run collaborators (message bus, archetype loader, orchestrator, manager, context accounting, WRFC controller) in the one correct wiring order. |
| `sdk/src/platform/runtime/agent-graph.ts` | PORT | Composes the four-object agent graph for a surface running its own conversation loop, in the required wiring order. |
| `sdk/src/platform/runtime/alert-gating.ts` | PORT | One shared gate deciding whether an unfocused-user alert (budget breach, long task, failure, awaiting approval) should fire, based on config flags and terminal focus state. |
| `sdk/src/platform/runtime/at-rest-persistence.ts` | PORT | Redacts credentials and secrets out of on-disk transcript and execution-ledger records before they are appended, using the shared credential-pattern redactor. |
| `sdk/src/platform/runtime/auth/crypto-adapter.ts` | PORT | Crypto adapter, runtime-neutral interface for PKCE and random-bytes operations used by oauth-core.ts. |
| `sdk/src/platform/runtime/auth/inspection.ts` | PORT | Exports AuthInspectionFreshness, ProviderAuthInspection, AuthInspectionSnapshot, AuthInspectionDeps, inspectProviderAuth, buildAuthInspectionSnapshot. |
| `sdk/src/platform/runtime/auth/oauth-client.ts` | PORT | OAuthClient, OAuth flows for **daemon authentication**. |
| `sdk/src/platform/runtime/auth/oauth-core.ts` | PORT | A token endpoint that ANSWERED, with a non-ok status. |
| `sdk/src/platform/runtime/bootstrap-background.ts` | PORT | Kicks off background provider and MCP-server discovery and registration at startup. |
| `sdk/src/platform/runtime/bootstrap-helpers.ts` | PORT | Shared runtime bootstrap helpers: system-prompt loading and model-selection restore. |
| `sdk/src/platform/runtime/bootstrap-hook-bridge.ts` | PORT | Fires lifecycle hook events from runtime state changes. |
| `sdk/src/platform/runtime/bootstrap-runtime-events.ts` | PORT | Wires runtime event-bus subscriptions to the host's system-message router and workstream labels. |
| `sdk/src/platform/runtime/bootstrap-services.ts` | PORT | Starts the host daemon process: adopt-or-spawn a compatible daemon, version compatibility check, socket and port handling. |
| `sdk/src/platform/runtime/bootstrap.ts` | PORT | Re-export barrel for the runtime bootstrap modules. |
| `sdk/src/platform/runtime/channel-composition.ts` | PORT | Composes the surface registry, channel plugin registry and route-binding manager for a host composition root. |
| `sdk/src/platform/runtime/client/approval-updates.ts` | PORT | approval-updates.ts, watching approval records over the push channel instead of asking again every few seconds. |
| `sdk/src/platform/runtime/client/config-client.ts` | PORT | config-client.ts, reading and writing the settings the DAEMON owns. |
| `sdk/src/platform/runtime/client/conversation-rewind-host.ts` | PORT | conversation-rewind-host.ts, a surface answering the daemon's questions about a conversation only it is holding. |
| `sdk/src/platform/runtime/client/credentials-client.ts` | PORT | credentials-client.ts, writing a credential the DAEMON will use. |
| `sdk/src/platform/runtime/client/daemon-autostart.ts` | PORT | daemon-autostart.ts, starting a daemon that is installed but not running, once, at boot. |
| `sdk/src/platform/runtime/client/daemon-handover.ts` | PORT | daemon-handover.ts, moving an installed daemon binary onto the daemon product's own release line, once, at a surface's launch. |
| `sdk/src/platform/runtime/client/daemon-verbs.ts` | PORT | daemon-verbs.ts, the socket every client seam plugs into, and nothing else. |
| `sdk/src/platform/runtime/client/devices-client.ts` | PORT | devices-client.ts, the paired-phone surface, as a client. |
| `sdk/src/platform/runtime/client/fleet-union.ts` | PORT | fleet-union.ts, a fleet view shows everything running, not just what this surface started. |
| `sdk/src/platform/runtime/client/index.ts` | PORT | Re-exports ./approval-raiser.js, ./approval-updates.js, ./config-client.js, ./conversation-rewind-host.js, ./credentials-client.js, ./daemon-autostart.js. |
| `sdk/src/platform/runtime/client-services.ts` | PORT | Defines the lighter in-process service graph a surface uses when it talks to a daemon for everything else, instead of constructing the full daemon-grade RuntimeServices. |
| `sdk/src/platform/runtime/client/session-dispatch.ts` | PORT | Polls the daemon for queued continuation inputs on sessions this surface hosts, runs the bound continuation runner, and reports the agent id and eventual answer back so a channel reply can be bound to the right conversation. |
| `sdk/src/platform/runtime/client/spine-adoption.ts` | PORT | spine-adoption.ts, wiring a surface's session and memory spines to the daemon it adopted. |
| `sdk/src/platform/runtime/client/tasks-client.ts` | PORT | tasks-client.ts, a task list shows every runtime task, not just this surface's. |
| `sdk/src/platform/runtime/code-index-services.ts` | PORT | Wires up the repo source-tree code index store for a composition root. |
| `sdk/src/platform/runtime/compaction/index.ts` | PORT | Barrel file re-exporting the compaction lifecycle manager, its types, the lifecycle state-machine helpers, and the strategy functions. |
| `sdk/src/platform/runtime/compaction/lifecycle.ts` | PORT | The compaction state machine: valid transition map, transition helpers, and strategy selection by numeric token-pressure ratio (microcompact below 50%, autocompact 50-85%, collapse above that or on prompt-too-long). |
| `sdk/src/platform/runtime/compaction/manager.ts` | PORT | CompactionManager drives the full compaction lifecycle: gates on a feature flag, selects and runs a strategy, scores its quality, escalates to a more aggressive strategy on a low score, creates and validates a boundary commit, and exposes the resume-repair pipeline. |
| `sdk/src/platform/runtime/compaction/quality-score.ts` | PORT | Scores a compaction run by combining a deterministic compression-ratio score with a semantic-retention score; the intent names this file as where compaction quality adopts the fidelity pattern. |
| `sdk/src/platform/runtime/compaction/resume-repair.ts` | PORT | Session resume repair pipeline: fixes an empty message list, a missing leading user message, token overflow (by truncation), and non-serialisable content blocks in a boundary commit before it is resumed. Purely structural checks, no text judgment. |
| `sdk/src/platform/runtime/compaction/strategies/autocompact.ts` | PORT | Auto-compaction strategy: keeps the most recent 60% of messages by count and prepends a handoff note; purely structural, no text judgment. |
| `sdk/src/platform/runtime/compaction/strategies/boundary-commit.ts` | PORT | Creates and validates a boundary commit (checkpoint) from a strategy's output, tracking append-only lineage for replay-safe session resumption. |
| `sdk/src/platform/runtime/compaction/strategies/collapse.ts` | PORT | Collapse strategy: reduces the whole conversation to one structured handoff message keeping only the last user/assistant exchange (truncated to 500 characters each); structural, no text judgment. |
| `sdk/src/platform/runtime/compaction/strategies/index.ts` | PORT | Barrel re-export for the compaction strategy functions and the quality-score module. |
| `sdk/src/platform/runtime/compaction/strategies/microcompact.ts` | PORT | Micro-compaction strategy: keeps the last 20 messages unmodified, drops the rest, and prepends a short handoff note; purely structural. |
| `sdk/src/platform/runtime/compaction/strategies/reactive.ts` | PORT | Reactive/emergency compaction strategy run on a provider prompt-too-long error: drops oldest messages by running token-estimate sum until the remainder fits 45% of the context window. |
| `sdk/src/platform/runtime/compaction/types.ts` | PORT | Shared types for the compaction lifecycle: states, strategies, strategy input/output, boundary commit, lifecycle result, trigger, and repair action/result shapes. |
| `sdk/src/platform/runtime/config/emit-bridge.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/config/index.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/context-usage.ts` | PORT | Single shared arithmetic turning a token count and window size into a usage percentage and remaining-tokens figure. |
| `sdk/src/platform/runtime/correlation.ts` | PORT | AsyncLocalStorage-based request, session, turn and run id propagation for downstream event correlation. |
| `sdk/src/platform/runtime/crash-capture.ts` | PORT | Writes a bounded, content-validated crash record (stack, version, pid, session, timestamp) before an uncaught fault takes the process down. |
| `sdk/src/platform/runtime/daemon-adoption-policy.ts` | PORT | Pure decision policy for whether to adopt an already-running compatible daemon or spawn a new one, based on a version-compatibility probe. |
| `sdk/src/platform/runtime/daemon-version-compat.ts` | PORT | Semver-band compatibility check deciding whether a surface may safely adopt a daemon reporting a given version. |
| `sdk/src/platform/runtime/deferred-startup.ts` | PORT | Coordinator that schedules and drains deferred startup tasks. |
| `sdk/src/platform/runtime/detached-daemon-runtime.ts` | PORT | Records and discovers the pid, host and port of a detached daemon process via a JSON file. |
| `sdk/src/platform/runtime/diagnostics/actions.ts` | PORT | Diagnostics action system, action dispatch bindings for diagnostic entries. |
| `sdk/src/platform/runtime/diagnostics/index.ts` | PORT | Diagnostics system, barrel re-exports and factory. |
| `sdk/src/platform/runtime/diagnostics/panels/agents.ts` | PORT | Agents diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/divergence.ts` | PORT | Divergence diagnostics panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/events.ts` | PORT | EventsPanel: subscribes to every runtime event-bus domain and keeps a bounded, filterable buffer of event entries for the diagnostics Events view; the domain list and summarised fields are fixed structural constants, not text judgment. |
| `sdk/src/platform/runtime/diagnostics/panels/forensics.ts` | PORT | ForensicsDataPanel, diagnostic data provider for the Forensics panel. |
| `sdk/src/platform/runtime/diagnostics/panels/health.ts` | PORT | Health diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/index.ts` | PORT | Diagnostics panels barrel, re-exports all panel data provider classes. |
| `sdk/src/platform/runtime/diagnostics/panels/ops.ts` | PORT | OpsPanel, diagnostic data provider for the Operator Control Plane. |
| `sdk/src/platform/runtime/diagnostics/panels/panel-resources.ts` | PORT | Panel resource diagnostics panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/policy.ts` | PORT | Policy diagnostics panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/replay.ts` | PORT | Replay panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/security.ts` | PORT | SecurityPanel: wraps an ApiTokenAuditor and exposes a point-in-time snapshot of token scope/rotation audit results for the diagnostics Security view. |
| `sdk/src/platform/runtime/diagnostics/panels/state-inspector.ts` | PORT | State Inspector diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/tasks.ts` | PORT | Tasks diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/tool-calls.ts` | PORT | Tool Calls diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/tool-contracts.ts` | PORT | Tool Contracts diagnostic panel data provider. |
| `sdk/src/platform/runtime/diagnostics/panels/transport.ts` | PORT | Transport diagnostics panel data provider. |
| `sdk/src/platform/runtime/diagnostics/provider.ts` | PORT | DiagnosticsProvider, aggregates all diagnostic panel data providers into a single unified interface. |
| `sdk/src/platform/runtime/diagnostics/types.ts` | PORT | Diagnostics system types, shared across all diagnostic panel data providers. |
| `sdk/src/platform/runtime/disposal.ts` | PORT | Shutdown seam that stops every poller, timer and owner a composed runtime graph started, best-effort and total. |
| `sdk/src/platform/runtime/durability-housekeeping.ts` | PORT | Reclaims crash-residue files left behind by a hard kill: stale liveness markers, orphaned transcript journals, quarantine files, and anchor sidecars, all by bounded age and count caps. |
| `sdk/src/platform/runtime/durability-services.ts` | PORT | Wires the data-safety stores a host composition needs: snapshot scheduler, permission-rule store, credential chain, retention janitor, durability housekeeping. |
| `sdk/src/platform/runtime/ecosystem/bundle-install.ts` | PORT | bundle-install.ts The activation-planning layer that binds a verified capability bundle to the existing plugin capability + quarantine machinery. |
| `sdk/src/platform/runtime/ecosystem/bundle-manifest.ts` | PORT | bundle-manifest.ts The capability-bundle manifest format. |
| `sdk/src/platform/runtime/ecosystem/bundle-pin.ts` | PORT | bundle-pin.ts SHA-256-pinned bundle distribution. |
| `sdk/src/platform/runtime/ecosystem/catalog.ts` | PORT | Read a curated catalog document. |
| `sdk/src/platform/runtime/ecosystem/index.ts` | PORT | Ecosystem barrel, the curated catalog + capability-bundle distribution layer. |
| `sdk/src/platform/runtime/ecosystem/marketplace-index.ts` | PORT | marketplace-index.ts A static, self-hostable JSON index of capability bundles. |
| `sdk/src/platform/runtime/ecosystem/recommendations.ts` | PORT | Exports EcosystemRecommendation, buildEcosystemRecommendations. |
| `sdk/src/platform/runtime/emitters/agents.ts` | PORT | Agent emitters, typed emission wrappers for AgentEvent domain. |
| `sdk/src/platform/runtime/emitters/automation.ts` | PORT | Automation emitters, typed wrappers for AutomationEvent domain. |
| `sdk/src/platform/runtime/emitters/communication.ts` | PORT | Communication emitters, typed emission wrappers for communication domain. |
| `sdk/src/platform/runtime/emitters/compaction.ts` | PORT | emitters/compaction.ts Typed emission wrappers for the CompactionEvent domain. |
| `sdk/src/platform/runtime/emitters/config.ts` | PORT | Config emitters, typed wrappers for the ConfigEvent domain. |
| `sdk/src/platform/runtime/emitters/control-plane.ts` | PORT | Control-plane emitters, typed wrappers for ControlPlaneEvent domain. |
| `sdk/src/platform/runtime/emitters/deliveries.ts` | PORT | Delivery emitters, typed wrappers for DeliveryEvent domain. |
| `sdk/src/platform/runtime/emitters/fleet.ts` | PORT | Fleet emitters, typed wrappers for the FleetEvent domain. |
| `sdk/src/platform/runtime/emitters/forensics.ts` | PORT | Exports emitForensicsReportCreated. |
| `sdk/src/platform/runtime/emitters/index.ts` | PORT | Emitters barrel, re-exports all typed emission wrappers and the EmitterContext. |
| `sdk/src/platform/runtime/emitters/knowledge.ts` | PORT | Knowledge emitters, typed wrappers for KnowledgeEvent domain. |
| `sdk/src/platform/runtime/emitters/mcp.ts` | PORT | MCP emitters, typed emission wrappers for McpEvent domain. |
| `sdk/src/platform/runtime/emitters/ops.ts` | PORT | Ops emitters, typed emission wrappers for the OpsEvent domain. |
| `sdk/src/platform/runtime/emitters/orchestration.ts` | PORT | Orchestration emitters, typed emission wrappers for OrchestrationEvent domain. |
| `sdk/src/platform/runtime/emitters/permissions.ts` | PORT | Permission emitters, typed emission wrappers for PermissionEvent domain. |
| `sdk/src/platform/runtime/emitters/planner.ts` | PORT | Planner emitters, typed emission wrappers for adaptive planner events. |
| `sdk/src/platform/runtime/emitters/plugins.ts` | PORT | Plugin emitters, typed emission wrappers for PluginEvent domain. |
| `sdk/src/platform/runtime/emitters/providers.ts` | PORT | Provider emitters, typed emission wrappers for provider events. |
| `sdk/src/platform/runtime/emitters/routes.ts` | PORT | Route emitters, typed wrappers for RouteEvent domain. |
| `sdk/src/platform/runtime/emitters/security.ts` | PORT | Security emitters, typed wrappers for SecurityEvent domain. |
| `sdk/src/platform/runtime/emitters/session.ts` | PORT | Session emitters, typed emission wrappers for SessionEvent domain. |
| `sdk/src/platform/runtime/emitters/surfaces.ts` | PORT | Surface emitters, typed wrappers for SurfaceEvent domain. |
| `sdk/src/platform/runtime/emitters/tasks.ts` | PORT | Task emitters, typed emission wrappers for TaskEvent domain. |
| `sdk/src/platform/runtime/emitters/tools.ts` | PORT | Tool emitters, typed emission wrappers for ToolEvent domain. |
| `sdk/src/platform/runtime/emitters/transport.ts` | PORT | Transport emitters, typed emission wrappers for TransportEvent domain. |
| `sdk/src/platform/runtime/emitters/turn.ts` | PORT | Turn emitters, typed emission wrappers for TurnEvent domain. |
| `sdk/src/platform/runtime/emitters/ui.ts` | PORT | UI emitters, typed wrappers for UIEvent domain. |
| `sdk/src/platform/runtime/emitters/watchers.ts` | PORT | Watcher emitters, typed wrappers for WatcherEvent domain. |
| `sdk/src/platform/runtime/emitters/workflows.ts` | PORT | Workflow emitters, typed emission wrappers for WRFC workflow events. |
| `sdk/src/platform/runtime/event-envelope.ts` | PORT | Re-export of the shared event-envelope type and constructor from transport-core. |
| `sdk/src/platform/runtime/event-feeds.ts` | PORT | Re-export of the shared runtime event feed types and constructors from transport-core. |
| `sdk/src/platform/runtime/events/envelope.ts` | PORT | Re-exports ../event-envelope.js. |
| `sdk/src/platform/runtime/events/index.ts` | PORT | Runtime Events, barrel re-exports and RuntimeEventBus. |
| `sdk/src/platform/runtime/execution-intents.ts` | PORT | Fixed enums for execution risk class, network policy and filesystem policy used to describe a tool's execution intent. |
| `sdk/src/platform/runtime/feature-announcements.ts` | PORT | Announce-once receipts for default-on features so a capability introduces itself exactly once per install. |
| `sdk/src/platform/runtime/feature-flag-composition.ts` | PORT | One shared way a runtime composition builds or adopts its feature-flag manager and wires the live config bridge. |
| `sdk/src/platform/runtime/feature-flags/feature-settings-queries.ts` | PORT | feature-settings-queries.ts, the questions a surface asks of the FEATURE_SETTINGS catalog next door. |
| `sdk/src/platform/runtime/feature-flags/feature-settings.ts` | PORT | Binding layer between domain config keys and the internal capability gates (boolean/enum/constant bindings), plus the per-feature settings metadata surfaces render. Config-value membership checks are against fixed closed sets, not free text. |
| `sdk/src/platform/runtime/feature-flags/flag-config-map.ts` | PORT | Static machine-readable map from each feature-flag id to the config keys and categories that tune it, kept in lockstep with the flag registry by a test guard. |
| `sdk/src/platform/runtime/feature-flags/flags.ts` | PORT | The canonical static registry of platform capability flags (id, name, description, default state, tier, runtime-toggleability); a data table, not decision logic. Some descriptions mention relevance/similarity features implemented elsewhere. |
| `sdk/src/platform/runtime/feature-flags/flags-voice.ts` | PORT | Voice capability registry entries, spread into FEATURE_FLAGS by flags.ts. |
| `sdk/src/platform/runtime/feature-flags/gates.ts` | PORT | The declared reason a capability cannot operate in this build, or null when it can. |
| `sdk/src/platform/runtime/feature-flags/graduation.ts` | PORT | graduation.ts, feature-flag graduation as a release policy. |
| `sdk/src/platform/runtime/feature-flags/index.ts` | PORT | Capability gates and per-feature settings metadata, barrel exports and factory. |
| `sdk/src/platform/runtime/feature-flags/manager.ts` | PORT | FeatureFlagManager: initialises flags from the registry, applies config overrides, enforces kill-switch and runtime-toggle rules, and keeps an audit log of transitions. |
| `sdk/src/platform/runtime/feature-flags/types.ts` | PORT | Feature flag and kill switch type definitions for the goodvibes-sdk runtime. |
| `sdk/src/platform/runtime/fleet/adapters/acp-host.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/agent.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/automation.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/background-process.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/code-index.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/observed.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/orchestration.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/schedule.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/trigger.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/watcher-trigger.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/watcher.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/adapters/workflow.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/archive.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/emit-bridge.ts` | PORT | Fleet process tree event bridge; the WRFC and workstream node kinds become contract-tree node kinds (fleet stays a route family, intent line 140). |
| `sdk/src/platform/runtime/fleet/headlines.ts` | PORT | headlines.ts, per-node headlines + the stall tell for the fleet read-model. |
| `sdk/src/platform/runtime/fleet/index.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/observed/detect.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/observed/source.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/registry.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/fleet/types.ts` | PORT | Fleet process tree types; the WRFC and workstream node kinds become contract-tree node kinds (fleet stays a route family, intent line 140). |
| `sdk/src/platform/runtime/focus-tracker.ts` | PORT | Tracks whether the terminal has OS-level focus from DECSET focus-reporting escape sequences; stays 'unknown' (null) rather than guessing when the terminal never reports focus. |
| `sdk/src/platform/runtime/forensics/classifier.ts` | PORT | Auto-classifies a session/task failure into a FailureClass from event context (cancellation flag, LLM stop reason, cascade/tool/permission/compaction flags, and the error message), documented in its own header as heuristic. Most rungs are deterministic enum/flag checks; the trailing rungs read the free-text error message. |
| `sdk/src/platform/runtime/forensics/collector.ts` | PORT | ForensicsCollector, subscribes to the RuntimeEventBus and automatically generates FailureReport objects when tasks or turns reach terminal failure states. |
| `sdk/src/platform/runtime/forensics/index.ts` | PORT | Forensics subsystem, public API. |
| `sdk/src/platform/runtime/forensics/registry.ts` | PORT | ForensicsRegistry, in-memory store for FailureReport objects. |
| `sdk/src/platform/runtime/forensics/types.ts` | PORT | Failure Forensics types, core data model for automatic failure reports. |
| `sdk/src/platform/runtime/foundation-clients.ts` | PORT | Composition function building the runtime foundation clients (transport, provider, knowledge, hook, mcp, ops APIs) from a runtime services slice; pure wiring, no decision points. |
| `sdk/src/platform/runtime/foundation-services.ts` | PORT | Composition factories for operator client services, peer client dependencies, and direct transport services built from runtime services; pure wiring. |
| `sdk/src/platform/runtime/guidance.ts` | PORT | Builds contextual guidance items (onboarding, recovery, operational) from session and config state with a dismissal store persisted to JSON; branches on fixed numeric thresholds and booleans, not guesswork over text. |
| `sdk/src/platform/runtime/health/aggregator.ts` | PORT | RuntimeHealthAggregator, tracks health status for all runtime domains and derives composite system health. |
| `sdk/src/platform/runtime/health/cascade-engine.ts` | PORT | CascadeEngine, evaluates declarative cascade rules against live domain health and determines which effects need to be applied when a domain state changes. |
| `sdk/src/platform/runtime/health/cascade-playbook-map.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/health/cascade-rules.ts` | PORT | Declarative cascade rules table for the goodvibes-sdk runtime. |
| `sdk/src/platform/runtime/health/cascade-timing.ts` | PORT | CascadeTimer, timing instrumentation for cascade rule evaluations. |
| `sdk/src/platform/runtime/health/effect-handlers.ts` | PORT | Health Error Propagation, Effect Handlers Implements concrete actions for each CascadeEffect type produced by the CascadeEngine. |
| `sdk/src/platform/runtime/health/index.ts` | PORT | Runtime health monitoring system, barrel exports and factory. |
| `sdk/src/platform/runtime/health/types.ts` | PORT | Core health types for the goodvibes-sdk runtime health monitoring system. |
| `sdk/src/platform/runtime/health/wiring.ts` | PORT | Health Error Propagation, HealthStoreWiring Wires together the RuntimeHealthAggregator, CascadeEngine, and RuntimeEventBus to form a complete error-propagation pipeline. |
| `sdk/src/platform/runtime/home-single-writer.ts` | PORT | Boot-time single-writer guard: claims a surface home via a JSON claim file and refuses a second live process by comparing pid and argv identity; deterministic process matching, not judged. |
| `sdk/src/platform/runtime/host-ui.ts` | PORT | Type definitions and no-op default implementations for host slash commands, keybindings manager and panel manager. |
| `sdk/src/platform/runtime/idempotency/index.ts` | PORT | Idempotency, store and key generation. |
| `sdk/src/platform/runtime/idempotency/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/idle-power-services.ts` | PORT | Wires the idle-time memory consolidation scheduler, host power manager and per-session live-turn control holder from runtime dependencies. |
| `sdk/src/platform/runtime/index.ts` | PORT | Re-exports the runtime module's public namespaces: bootstrap, observability, operations, security, shell, state, transport, ui. |
| `sdk/src/platform/runtime/inspection/state-inspector/hotspot-sampler.ts` | PORT | Selector hotspot sampler for the state inspector. |
| `sdk/src/platform/runtime/inspection/state-inspector/index.ts` | PORT | State inspector subsystem exports. |
| `sdk/src/platform/runtime/inspection/state-inspector/inspector.ts` | PORT | StateInspectorProvider, enhanced runtime state inspector data provider. |
| `sdk/src/platform/runtime/inspection/state-inspector/serialize.ts` | PORT | Shared serialization utility for the state inspector. |
| `sdk/src/platform/runtime/inspection/state-inspector/timeline.ts` | PORT | Timeline buffer for state inspector time-travel. |
| `sdk/src/platform/runtime/inspection/state-inspector/transition-log.ts` | PORT | Bounded transition history log for the state inspector. |
| `sdk/src/platform/runtime/inspection/state-inspector.ts` | PORT | Re-exports ./state-inspector/index.js. |
| `sdk/src/platform/runtime/inspection/state-inspector/types.ts` | PORT | State inspector types, data structures for the StateInspectorProvider. |
| `sdk/src/platform/runtime/install-kind.ts` | PORT | Detects how the running process was installed (binary, bun-global-package, source) from exact path segments of its executable path; deterministic parsing, not guesswork. |
| `sdk/src/platform/runtime/integration/helpers.ts` | PORT | IntegrationHelperService: builds read-only snapshots (session, tasks, automation, routes, approvals, remote, health, settings, worktrees, panels) for review/diagnostic surfaces and opens an SSE event stream over the runtime bus. |
| `sdk/src/platform/runtime/lifecycle-facade.ts` | PORT | Dispatches lifecycle state transitions (task, plugin, mcp, compaction) to each domain's own transition rules over closed sets of named states; deterministic state machine, not guesswork. |
| `sdk/src/platform/runtime/lifecycle.ts` | PORT | Ordered runtime startup and shutdown: fires session lifecycle hooks, persists the session, stops the schedule manager and provider registry watcher. |
| `sdk/src/platform/runtime/llm-observability.ts` | PORT | Telemetry wrapper for LLM calls: redacted-by-default prompt summarization, retry loop, and metric/span recording for request count, duration and token usage. |
| `sdk/src/platform/runtime/mcp/index.ts` | PORT | src/runtime/mcp, MCP lifecycle barrel. |
| `sdk/src/platform/runtime/mcp/lifecycle.ts` | PORT | MCP server lifecycle state machine. |
| `sdk/src/platform/runtime/mcp/manager.ts` | PORT | McpLifecycleManager, drives the MCP server state machine. |
| `sdk/src/platform/runtime/mcp/schema-freshness.ts` | PORT | MCP schema freshness tracking. |
| `sdk/src/platform/runtime/mcp/types.ts` | PORT | MCP lifecycle core type definitions. |
| `sdk/src/platform/runtime/memory/cache-registry.ts` | PORT | CacheRegistry: the single registry of every in-memory cache/pool the daemon retains, with a fail-closed membership check and a trim(level) the memory governor drives to shrink caches under pressure. |
| `sdk/src/platform/runtime/memory-fold.ts` | PORT | Folds a workspace's legacy per-project memory sqlite store into the canonical cross-surface memory store at boot; idempotent id-keyed import. |
| `sdk/src/platform/runtime/memory/index.ts` | PORT | Barrel export for the memory governance layer: CacheRegistry, PauseController, and the governor factory/wiring. |
| `sdk/src/platform/runtime/memory/memory-governor.ts` | PORT | MemoryGovernor: samples RSS/heap on an interval, maps footprint to a tier against a configured budget (percentage thresholds), trims caches and pauses jobs by tier, and exits gracefully with a receipt on a sustained leak or hard-limit breach. All thresholds are numeric percentages of a memory budget, not text judgment. |
| `sdk/src/platform/runtime/memory/pause-controller.ts` | PORT | PauseController: the backpressure seam the memory governor drives to pause/resume deferrable background jobs under memory pressure. |
| `sdk/src/platform/runtime/memory-spine/client.ts` | PORT | client.ts, the SDK memory-spine surface client (host-vs-client access mode). |
| `sdk/src/platform/runtime/memory-spine/index.ts` | PORT | Re-exports ./client.js, ./recall-snapshot.js, ./rest-transport.js, ./wire-verb-availability.js. |
| `sdk/src/platform/runtime/memory-spine/recall-snapshot.ts` | PORT | recall-snapshot.ts, the sync-recall seam for the memory spine. |
| `sdk/src/platform/runtime/memory-spine/rest-transport.ts` | PORT | rest-transport.ts, the memory-spine's REST `MemoryTransport`. |
| `sdk/src/platform/runtime/memory-spine/wire-verb-availability.ts` | PORT | wire-verb-availability.ts, the runtime discriminator that lets a memory wire consumer tell "no such record" apart from "this daemon does not serve this verb". |
| `sdk/src/platform/runtime/memory/status.ts` | PORT | Pure formatting of the memory governor's snapshot and pressure events for the ops/health surface; no decision logic. |
| `sdk/src/platform/runtime/memory/wiring.ts` | PORT | Daemon composition seam that builds the CacheRegistry, PauseController and MemoryGovernor as one unit, registers known caches/jobs, and wires ops emission and the tripwire receipt. |
| `sdk/src/platform/runtime/metrics.ts` | PORT | Named metric instruments (HTTP, LLM, auth, session, transport, telemetry buffer) on the platform meter, the active tracer singleton, and a snapshotMetrics function that reads them into a JSON shape. |
| `sdk/src/platform/runtime/mutable-runtime-state.ts` | PORT | Interface for the mutable runtime state (model, provider, debug mode, system prompt, reasoning effort, session id) host shells update in place. |
| `sdk/src/platform/runtime/network/inbound.ts` | PORT | Exports InboundTlsMode, InboundServerSurface, InboundTlsSnapshot, ResolvedInboundTlsContext, InboundTlsConfigReader, inspectInboundTls, and more. |
| `sdk/src/platform/runtime/network/index.ts` | PORT | Re-exports ./inbound.js, ./outbound.js, ./shared.js. |
| `sdk/src/platform/runtime/network/outbound.ts` | PORT | Exports OutboundTrustMode, OutboundTlsSnapshot, OutboundTlsConfigReader, inspectOutboundTls, applyOutboundTlsToFetchInit, createNetworkFetch, and more. |
| `sdk/src/platform/runtime/network/shared.ts` | PORT | Exports NetworkRootConfig, getGoodVibesRootDir, getDefaultCertDirectory, getDefaultInboundCertPaths, resolvePathFromGoodVibesRoot, readPemEntriesFromDirectory, and more. |
| `sdk/src/platform/runtime/notifications/formatters/index.ts` | PORT | Notification formatters, barrel export. |
| `sdk/src/platform/runtime/notifications/formatters/panel-jump.ts` | PORT | Builds a 'jump to panel' and a 'dismiss' NotificationAction object; pure data construction, no decision logic. |
| `sdk/src/platform/runtime/notifications/formatters/summary.ts` | PORT | Summary formatter, produces condensed single-line summaries for batched or grouped notifications destined for the conversation surface. |
| `sdk/src/platform/runtime/notifications/index.ts` | PORT | Notification routing module, barrel export and factory. |
| `sdk/src/platform/runtime/notifications/policies/batch-policy.ts` | PORT | Batch policy, collapses repeated notifications from the same domain + level within a rolling time window to prevent UI flooding from high- frequency operational events (e.g. |
| `sdk/src/platform/runtime/notifications/policies/burst-policy.ts` | PORT | Burst policy, detects rapid notification floods within a short observation window and collapses them into a batch group key. |
| `sdk/src/platform/runtime/notifications/policies/default-policy.ts` | PORT | Default routing policy, maps notification level + domain verbosity to a NotificationTarget. |
| `sdk/src/platform/runtime/notifications/policies/index.ts` | PORT | Notification policies, barrel export. |
| `sdk/src/platform/runtime/notifications/policies/mode-context-policy.ts` | PORT | Mode-context policy, applies HITL-mode-aware suppression on top of the base routing decision. |
| `sdk/src/platform/runtime/notifications/policies/quiet-typing.ts` | PORT | Quiet-while-typing policy, suppresses non-critical notifications when the user is actively composing input, preventing distracting UI churn mid-keystroke. |
| `sdk/src/platform/runtime/notifications/router.ts` | PORT | NotificationRouter, routes incoming notifications to the appropriate surface (conversation, status_bar, panel_only) based on level, per-domain verbosity, quiet-while-typing state, mode-context, burst detection, and batch |
| `sdk/src/platform/runtime/notifications/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/observability.ts` | PORT | Barrel re-export of the runtime observability surface: diagnostics, eval, forensics, idempotency, perf, health, state inspector, telemetry and metrics. |
| `sdk/src/platform/runtime/operations.ts` | PORT | Large barrel re-export for runtime operations: remote, tasks, tools, mcp, plugins, compaction, ops playbooks, lifecycle, session persistence/recovery, retention, transcript journal, durability, install-kind, reachability, voice/code-index/idle-power composition, workspace registration and trust. No logic of its own. |
| `sdk/src/platform/runtime/operator-client.ts` | PORT | Builds the operator client facade (sessions, tasks, approvals, providers, control plane) as thin typed wrappers over runtime services methods; deterministic wiring with limit normalization, no guesswork. |
| `sdk/src/platform/runtime/operator-token-cleanup.ts` | PORT | Locates workspace-scoped operator-token file paths an older install may have left behind, and resolves the token a process authenticates to its daemon with, honoring an explicit override env var; deterministic file and env handling. |
| `sdk/src/platform/runtime/ops-api.ts` | PORT | Type-only interfaces for the ops task and agent API surface (snapshot, list, get, create, update, complete, fail, cancel, pause, resume, retry). |
| `sdk/src/platform/runtime/ops/control-plane.ts` | PORT | OpsControlPlane, central dispatch point for all operator interventions. |
| `sdk/src/platform/runtime/ops/index.ts` | PORT | Operational runbook (playbook) registry for diagnostics: lookup by id and by tag, plus findPlaybooksBySymptom which ranks playbooks by counting lowercase substring matches of a free-text query against each playbook's static symptom strings. That symptom search is a real decision point (guessed relevance by substring match) but the subsystem here is plain runtime tooling (PORT), not the intake/observe JEV subsystems, so it is reported here for the coordinator rather than converted. |
| `sdk/src/platform/runtime/ops/playbooks/compaction-failure.ts` | PORT | Playbook: Compaction Failure Diagnoses and resolves conversation compaction failures that block new turns from starting. |
| `sdk/src/platform/runtime/ops/playbooks/export-recovery.ts` | PORT | Static playbook for telemetry/OTLP export pipeline failures: symptom list plus diagnostic checks against structured exporter/queue state. |
| `sdk/src/platform/runtime/ops/playbooks/index.ts` | PORT | Barrel export for operational playbooks. |
| `sdk/src/platform/runtime/ops/playbooks/permission-deadlock.ts` | PORT | Static playbook for permission-approval deadlocks: symptom list plus diagnostic checks against pending-approval counts and state. |
| `sdk/src/platform/runtime/ops/playbooks/plugin-degradation.ts` | PORT | Static playbook for a plugin operating in a degraded state: symptom list plus diagnostic checks against plugin health status. |
| `sdk/src/platform/runtime/ops/playbooks/reconnect-failure.ts` | PORT | Static playbook for persistent transport/connection failures: symptom list plus diagnostic checks against transport endpoint health. |
| `sdk/src/platform/runtime/ops/playbooks/session-unrecoverable.ts` | PORT | Playbook: Session Unrecoverable Handles the scenario where session recovery has been exhausted and the runtime has emitted SESSION_UNRECOVERABLE, triggering a full-system cascade. |
| `sdk/src/platform/runtime/ops/playbooks/stuck-turn.ts` | PORT | Static playbook for a stalled turn/task: symptom list plus a diagnostic check computing elapsed time against the configured turn timeout. |
| `sdk/src/platform/runtime/ops/runtime-context.ts` | PORT | AsyncLocalStorage-scoped ops runtime context: tracks last-event time and session-recovery-failure count from the runtime bus, and reads/validates the on-disk recovery file's metadata line. |
| `sdk/src/platform/runtime/ops/safe-check.ts` | PORT | Shared diagnostic check safety wrapper. |
| `sdk/src/platform/runtime/ops/types.ts` | PORT | Type definitions for the operational playbook registry: diagnostic checks, playbook steps, playbooks, and registry entries. |
| `sdk/src/platform/runtime/path-shadow.ts` | PORT | Scans PATH for shadowed copies of maintained commands and classifies each copy's ownership (install target, package link, our binary, unknown) from exact directory structure and a fixed '<command> <semver>' version-line format; deterministic path and format matching, not meaning guesswork. |
| `sdk/src/platform/runtime/peer-client.ts` | PORT | Builds the peer client facade (pairing, peers, work, runners domains, snapshots) as typed wrappers over the distributed runtime manager and remote runner registry; deterministic aggregation and counting, no guesswork. |
| `sdk/src/platform/runtime/perf/budgets.ts` | PORT | Default performance budget definitions for goodvibes-sdk. |
| `sdk/src/platform/runtime/perf/component-contracts.ts` | PORT | Per-component CPU/render resource contract types and thresholds (update rate, render budget, throttle/degrade rules) enforced by the ComponentHealthMonitor; numeric budgets only, no text judgment. |
| `sdk/src/platform/runtime/perf/component-health-monitor.ts` | PORT | ComponentHealthMonitor, enforces per-component resource contracts. |
| `sdk/src/platform/runtime/perf/index.ts` | PORT | Performance budget system, barrel export. |
| `sdk/src/platform/runtime/perf/monitor.ts` | PORT | PerfMonitor, collects metrics from the runtime store and evaluates them against registered performance budgets. |
| `sdk/src/platform/runtime/perf/reporter.ts` | PORT | PerfReporter, formats a PerfReport as a human-readable console table and provides an exit code for CI integration. |
| `sdk/src/platform/runtime/perf/slo-collector.ts` | PORT | SloCollector: tracks four critical-path latency SLOs from runtime events in a capped rolling window and exposes p95 values for PerfMonitor; pure arithmetic over timestamps. |
| `sdk/src/platform/runtime/perf/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/plugins/hot-reload.ts` | PORT | Safe hot-reload protocol for plugins. |
| `sdk/src/platform/runtime/plugins/index.ts` | PORT | Plugin lifecycle system, barrel export and factory. |
| `sdk/src/platform/runtime/plugins/lifecycle.ts` | PORT | Plugin lifecycle state machine. |
| `sdk/src/platform/runtime/plugins/manager.ts` | PORT | PluginLifecycleManager, plugin lifecycle and capability enforcement. |
| `sdk/src/platform/runtime/plugins/manifest.ts` | PORT | Plugin capability manifest validation and resolution. |
| `sdk/src/platform/runtime/plugins/trust.ts` | PORT | Plugin extension trust framework. |
| `sdk/src/platform/runtime/plugins/types.ts` | PORT | Plugin lifecycle system types. |
| `sdk/src/platform/runtime/provider-optimizer-wiring.ts` | PORT | Binds the provider optimizer's enabled state to a feature flag and seeds its persisted routing mode (off, pinned, auto) from config at startup; deterministic config-driven wiring. |
| `sdk/src/platform/runtime/provider-stack.ts` | PORT | Composes the model side of a runtime: capability registry, cache-hit tracker, favorites/benchmark/model-limits stores, provider registry with a live credential refresh chain, tool-call LLM, and provider optimizer bound to its feature flag and config mode. |
| `sdk/src/platform/runtime/reachability-check.ts` | PORT | Boot-time check for whether the running executable is the one the shell actually reaches and whether it is current; wires real filesystem/PATH/version-probe inputs into the path-shadow scan and reachability-notice wording. Deterministic system checks, never blocks boot. |
| `sdk/src/platform/runtime/reachability-notice.ts` | PORT | Turns a completed PATH shadow scan and version comparison into plain-word startup notices (shadowed, not-on-path, behind); pure wording over deterministic version comparison, empty when healthy. |
| `sdk/src/platform/runtime/recovery-snapshot-apply.ts` | PORT | Restores a crash-recovery snapshot the user explicitly confirmed: loads and retires the snapshot file, validates it structurally holds a conversation, applies it, and folds in newer journal records. Deterministic structural validation, never guesses whether to restore. |
| `sdk/src/platform/runtime/remote/capabilities.ts` | PORT | Exports RemoteCapabilityId, RemoteCapabilitySnapshot, deriveRemoteCapabilities. |
| `sdk/src/platform/runtime/remote/distributed-runtime-contract.ts` | PORT | Exports getDistributedNodeHostContract. |
| `sdk/src/platform/runtime/remote/distributed-runtime-manager.ts` | PORT | Exports DistributedRuntimeManager. |
| `sdk/src/platform/runtime/remote/distributed-runtime-pairing.ts` | PORT | Exports requestDistributedPairing, approveDistributedPairRequest, rejectDistributedPairRequest, verifyDistributedPairRequest, rotateDistributedPeerToken, revokeDistributedPeerToken, and more. |
| `sdk/src/platform/runtime/remote/distributed-runtime.ts` | PORT | Re-exports ./distributed-runtime-contract.js, ./distributed-runtime-manager.js. |
| `sdk/src/platform/runtime/remote/distributed-runtime-types.ts` | PORT | Whole-store writes, one at a time, in call order. |
| `sdk/src/platform/runtime/remote/distributed-runtime-utils.ts` | PORT | Exports hashSecret, matchesSecret, randomSecret, fingerprint, coerceStringArray, summarizeValue, and more. |
| `sdk/src/platform/runtime/remote/distributed-runtime-work.ts` | PORT | Exports enqueueDistributedWork, invokeDistributedPeer, claimDistributedWork, completeDistributedWork, cancelDistributedWork. |
| `sdk/src/platform/runtime/remote-execution-composition.ts` | PORT | Builds the paired remote-runner registry/supervisor and the paired sandbox-session registry/mcp registry together so a tool call confined by one is confined by the other; pure construction, opens no connection. |
| `sdk/src/platform/runtime/remote/heartbeat.ts` | PORT | Exports RemoteHeartbeatSnapshot, deriveRemoteHeartbeat. |
| `sdk/src/platform/runtime/remote/identity.ts` | PORT | Remote Substrate, Durable Identity Manager Implements globally unique, stable identifiers for sessionId, taskId, and agentId that survive transport changes and reconnects. |
| `sdk/src/platform/runtime/remote/index.ts` | PORT | Remote Substrate, Public API Barrel export and `createRemoteSubstrate()` factory. |
| `sdk/src/platform/runtime/remote/negotiation.ts` | PORT | Exports RemoteNegotiationSnapshot, deriveRemoteNegotiation. |
| `sdk/src/platform/runtime/remote/observability.ts` | PORT | Remote Substrate, Observability Panel Data Provider Provides introspection data about remote connections for display in diagnostic panels. |
| `sdk/src/platform/runtime/remote/recovery.ts` | PORT | Exports RemoteRecoveryAction, deriveRemoteRecoveryActions. |
| `sdk/src/platform/runtime/remote/runner-registry.ts` | PORT | Exports RemoteRunnerRegistry, exportRemoteArtifactForAgent, importRemoteArtifact. |
| `sdk/src/platform/runtime/remote/session-state.ts` | PORT | Exports RemoteSessionStateSnapshot, buildRemoteSessionStateSnapshot. |
| `sdk/src/platform/runtime/remote/supervisor.ts` | PORT | Exports RemoteSupervisorSnapshot, RemoteSupervisor. |
| `sdk/src/platform/runtime/remote/sync.ts` | PORT | Remote Substrate, State Sync Mirrors remote task and health state into local runtime store domains (AcpDomainState, TaskDomainState). |
| `sdk/src/platform/runtime/remote/transport-contract.ts` | PORT | Remote Substrate, Transport Contract Defines typed message definitions for control/data/ack/failure message classes with retry/backoff policies per class. |
| `sdk/src/platform/runtime/retention/append-only-registry.ts` | PORT | append-only-registry.ts, the single owner of every append-only store the platform writes. |
| `sdk/src/platform/runtime/retention/index.ts` | PORT | retention/index.ts Public barrel for the snapshot retention and pruning policy subsystem. |
| `sdk/src/platform/runtime/retention/legacy-agent-journal-patterns.ts` | PORT | legacy-agent-journal-patterns.ts, how a pre-repoint agent journal is recognised on disk, shared by append-only-registry.ts's session-journals sweep and session-migration.ts's one-time move. |
| `sdk/src/platform/runtime/retention/policy.ts` | PORT | policy.ts `RetentionPolicy`, tracks registered checkpoints and decides which ones must be pruned to satisfy the configured retention limits. |
| `sdk/src/platform/runtime/retention/pruner.ts` | PORT | pruner.ts `SnapshotPruner`, handles safe file-system deletion of expired checkpoint artifacts on behalf of `RetentionPolicy`. |
| `sdk/src/platform/runtime/retention/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/runtime-hook-api.ts` | PORT | Thin pass-through constructing the hook API from the hooks module. |
| `sdk/src/platform/runtime/runtime-knowledge-api.ts` | PORT | Thin pass-through constructing the knowledge API from runtime services (knowledge service, memory registry, code index store). |
| `sdk/src/platform/runtime/runtime-mcp-api.ts` | PORT | Thin pass-through constructing the mcp API from an mcp registry. |
| `sdk/src/platform/runtime/runtime-ops-api.ts` | PORT | Builds the ops task/agent API as typed wrappers over the task manager, tasks read model and ops control plane; deterministic wiring with a control-plane-required guard. |
| `sdk/src/platform/runtime/runtime-provider-api.ts` | PORT | Thin pass-through constructing the provider API from runtime services (provider registry, favorites store, benchmark store). |
| `sdk/src/platform/runtime/sandbox.ts` | PORT | Barrel re-export of the sandbox module (manager, session registry, types), including QEMU-specific session mode and vm backend types. The intent marks QEMU sandboxing out of scope/removed; this file's own underlying sandbox/manager.ts and sandbox/types.ts are not in this file list, so the coordinator should confirm the QEMU backend is dropped where those files are inventoried. |
| `sdk/src/platform/runtime/secrets-composition.ts` | PORT | Constructs the credential store honoring a daemon-home override, and reports which credential tiers (daemon, project, user) are isolated from the machine's real home; deterministic path containment checks, security-relevant but never judged. |
| `sdk/src/platform/runtime/security-settings.ts` | PORT | Static catalog of security-relevant settings (fetch sanitization, permission engine, policy signing, token audit, contract verification, shell AST parsing) with their current state read from the feature flag reporter; deterministic, security checks stay code. |
| `sdk/src/platform/runtime/security.ts` | PORT | Barrel re-export of the permissions/security surface: auth inspection, layered policy evaluator, divergence dashboard, policy bundle signing, and the shell-command AST classifier (catastrophic-command list, command AST parsing and classification). These are the deterministic boundary the intent's gate subsystem keeps as code, not judged. |
| `sdk/src/platform/runtime/self-update.ts` | PORT | The binary self-update mechanism: version compare, release-tag parsing from a redirect header, checksum verification against a manifest, atomic file swap with a kept previous copy, and one-command rollback. All deterministic string/file operations over fixed formats. |
| `sdk/src/platform/runtime/service-queries.ts` | PORT | Barrel re-export of surface-agnostic service query type contracts and two factory functions from ui-service-queries.ts. |
| `sdk/src/platform/runtime/services.ts` | PORT | The runtime services composition root (createRuntimeServices): constructs and wires every platform collaborator (config, secrets, channels, control plane, knowledge, memory, voice, media, providers, mcp, plugins, sessions, workflow, orchestration, remote execution, fleet). Large but pure composition; no keyword lists, regexes, scoring or text-guessed classification found anywhere in the file. |
| `sdk/src/platform/runtime/session-liveness-marker.ts` | PORT | Best-effort marker file signaling a session is open in another process, with staleness and pid-liveness checks and a bounded reap sweep; deterministic pid/timestamp logic, never a lock. |
| `sdk/src/platform/runtime/session-maintenance.ts` | PORT | Computes session maintenance level (stable, watch, suggest-compact, compacting, needs-repair) from numeric context-usage percentages and fixed configured thresholds, plus plain-word reasons and next steps. Deterministic arithmetic over configured thresholds, not text guesswork. |
| `sdk/src/platform/runtime/session-migration.ts` | PORT | One-time idempotent migration of legacy on-disk session/journal/checkpoint layout into the surface-scoped layout, guarded by a content-validated marker file. Classification of which files are legacy agent journals is by fixed filename shape plus first-line JSON structure (isLegacyAgentJournalFile), a deterministic format check, not meaning guesswork. |
| `sdk/src/platform/runtime/session-persistence-scope.ts` | PORT | Shared types and path-resolution helpers for session persistence scope (legacy per-call options vs a declare-once SessionSurface), used by both the durable store and crash-recovery snapshot modules. Deterministic path resolution, no guesswork. |
| `sdk/src/platform/runtime/session-persistence.ts` | PORT | Durable session persistence: saves a conversation via SessionManager, writes and reads the atomically-renamed last-session pointer file, and retires a pointer whose referenced session file is gone. Re-exports the crash-recovery API from session-recovery.ts under the same import path. Deterministic file operations. |
| `sdk/src/platform/runtime/session-pointer-surface.ts` | PORT | Binds writeLastSessionPointer to one SessionSurface so a caller expecting a single-argument callback cannot silently drop the scope options. |
| `sdk/src/platform/runtime/session-recovery.ts` | PORT | Crash-recovery snapshot write/offer/load/retire logic: which snapshot is live crash data decided by mtime comparison against the session's own durable store file and a fixed live-refresh time window. Entirely deterministic timestamp arithmetic, no guesswork over meaning. |
| `sdk/src/platform/runtime/session-return-context.ts` | PORT | Builds a local resume summary (activity/status labels, last prompt/reply, counts) from structured message roles, and optionally asks a helper model to write a one-sentence assisted narrative on top of it. The intent marks runtime PORT overall. Guesswork found at line 84: pendingApprovals falls back to counting system messages by regex /approval/i over their free-text content, a keyword-style guess at message meaning rather than a structured field; flagged here for the coordinator per the PORT-file reporting rule rather than assigned a disposition change. |
| `sdk/src/platform/runtime/session-spine/client.ts` | PORT | client.ts, the SDK session-spine surface client. |
| `sdk/src/platform/runtime/session-spine/index.ts` | PORT | Re-exports ./client.js, ./rest-transport.js, ./union-cache.js. |
| `sdk/src/platform/runtime/session-spine/rest-transport.ts` | PORT | rest-transport.ts, the session-spine's raw-REST `SpineTransport`. |
| `sdk/src/platform/runtime/session-spine/union-cache.ts` | PORT | union-cache.ts, the SDK session read facade (moved from goodvibes-tui). |
| `sdk/src/platform/runtime/session-storage-services.ts` | PORT | Builds the declare-once SessionSurface and the SessionManager built on it, running the one-time storage migration as a side effect of construction. |
| `sdk/src/platform/runtime/session-surface.ts` | PORT | Constructs the SessionSurface (all per-product session/recovery/state/checkpoint paths) from a SurfaceIdentity, validating inputs and triggering the one-time migration pass. Deterministic path derivation. |
| `sdk/src/platform/runtime/settings/control-plane-store.ts` | PORT | Exports SyncSurface, SyncDirection, SettingsSource, SettingsSyncEvent, ManagedSettingLock, SettingsLayerRecord, and more. |
| `sdk/src/platform/runtime/settings/control-plane.ts` | PORT | Settings control plane: records sync events, manages managed-setting locks, stages and applies managed setting bundles, resolves effective settings across default, local, synced and managed layers, and renders review text. |
| `sdk/src/platform/runtime/settings.ts` | PORT | Barrel re-export of the control-plane settings and settings store modules. |
| `sdk/src/platform/runtime/setup-contract.ts` | PORT | The platform's general setup contract (do/propose/ask shapes, solution shapes, instruction prompt) for any 'set this up' request. The intent marks runtime PORT overall. Guesswork found at line 126-128: mentionsUserTypedCommand uses three regexes over free-text reply prose to detect whether a reply tells the user to type a slash command or edit a config key, a text-shape classification used to keep setup replies clean; flagged here per the PORT-file reporting rule as a candidate reply-reading pattern rather than assigned a disposition change. |
| `sdk/src/platform/runtime/shell-command-extensions.ts` | PORT | Composition helper building the command-shell 'extensions' service group (forensics registry, policy registry/runtime state, memory registry, integration helpers, knowledge service, plugin manager, hook workbench) from options. |
| `sdk/src/platform/runtime/shell-command-ops.ts` | PORT | Type interfaces and composition helpers for the command-shell 'ops' service group (agent/acp/automation/mode/plan managers, session orchestration, remote command service, plan runtime), including factories that build the remote command service and the adaptive-planner-gated plan runtime. |
| `sdk/src/platform/runtime/shell-command-platform.ts` | PORT | Composition helper building the command-shell 'platform' service group (read models, service registry, subscription/secrets managers, local user auth, token auditor, replay engine, webhook notifier). |
| `sdk/src/platform/runtime/shell-command-services.ts` | PORT | Top-level composition of the bootstrap command-shell services, combining the workspace, platform, ops and extensions service groups from the sibling shell-command-*.ts files. |
| `sdk/src/platform/runtime/shell-command-workspace.ts` | PORT | Composition helper building the command-shell 'workspace' service group (shell paths, component health monitor, worktree registry, sandbox session registry). |
| `sdk/src/platform/runtime/shell-paths.ts` | PORT | Constructs the ShellPathService: resolves and validates the working/home directories, expands a leading '~' path, and resolves project/user-scoped paths under .goodvibes. Deterministic path arithmetic. |
| `sdk/src/platform/runtime/shell.ts` | PORT | Barrel re-export of the shell-command-*, shell-paths, mutable-runtime-state, provider-accounts registry, surface-root, system-message-policy, worktree registry and ecosystem catalog modules. |
| `sdk/src/platform/runtime/state.ts` | PORT | Barrel re-export of the runtime store, domain dispatch, selectors, feature flags, event bus, event envelope/feed and emitter functions. |
| `sdk/src/platform/runtime/store/domains/acp.ts` | PORT | ACP domain state, tracks the Agent Client Protocol transport layer, active subagent connections, and inter-session ACP sessions. |
| `sdk/src/platform/runtime/store/domains/agents.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/automation.ts` | PORT | Automation domain state, jobs, runs, and source registry. |
| `sdk/src/platform/runtime/store/domains/communication.ts` | PORT | Communication domain state, structured agent-to-agent and operator-to-agent messaging. |
| `sdk/src/platform/runtime/store/domains/control-plane.ts` | PORT | Control-plane domain state, connected clients and live subscription posture. |
| `sdk/src/platform/runtime/store/domains/conversation.ts` | PORT | Conversation domain state, tracks the active turn lifecycle, message buffer, streaming deltas, and tool dispatch state. |
| `sdk/src/platform/runtime/store/domains/daemon.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/deliveries.ts` | PORT | Delivery domain state, outbound delivery attempts and their outcomes. |
| `sdk/src/platform/runtime/store/domains/discovery.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/domain-read-matrix.ts` | PORT | Declares which runtime store domain slices may import from which other domain slices, and looks up the allowed set for a reader domain. |
| `sdk/src/platform/runtime/store/domains/git.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/index.ts` | PORT | Barrel export for all runtime store domain types and initial state factories. |
| `sdk/src/platform/runtime/store/domains/integrations.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/intelligence.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/mcp.ts` | PORT | MCP domain state, tracks all MCP server connections, their lifecycle state, and available tools per server. |
| `sdk/src/platform/runtime/store/domains/model.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/orchestration.ts` | PORT | Orchestration domain state, task graphs, node lifecycles, and bounded recursive execution telemetry for higher-level worker coordination. |
| `sdk/src/platform/runtime/store/domains/overlays.ts` | PORT | Overlays domain state, tracks which full-screen or floating overlays are currently visible and their configuration. |
| `sdk/src/platform/runtime/store/domains/panels.ts` | PORT | Panels domain state, tracks the panel-first operator UX surfaces: which panels are open, their layout, and focus state. |
| `sdk/src/platform/runtime/store/domains/permissions.ts` | PORT | Permissions domain state, tracks the permission mode, session approvals, and the most recent permission decision with full audit trail. |
| `sdk/src/platform/runtime/store/domains/plugins.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/provider-health.ts` | PORT | Type definitions and initial state for the provider health domain that tracks connectivity, error rate and latency per LLM provider. |
| `sdk/src/platform/runtime/store/domains/routes.ts` | PORT | Route binding domain state, external conversation, thread, and session mappings. |
| `sdk/src/platform/runtime/store/domains/session.ts` | PORT | Session domain state, tracks the active host session lifecycle, recovery machine state, lineage, and identity metadata. |
| `sdk/src/platform/runtime/store/domains/surface-perf.ts` | PORT | Surface performance domain state, tracks render performance, frame rates, and input responsiveness metrics across host UIs. |
| `sdk/src/platform/runtime/store/domains/surfaces.ts` | PORT | Surface domain state, Slack, Discord, web, ntfy, webhook, and terminal surfaces. |
| `sdk/src/platform/runtime/store/domains/tasks.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/telemetry.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/store/domains/ui-perf.ts` | PORT | UI performance domain state, tracks TUI render performance, frame rates, and input responsiveness metrics. |
| `sdk/src/platform/runtime/store/domains/watchers.ts` | PORT | Watcher domain state, managed sources that feed automation and routes. |
| `sdk/src/platform/runtime/store/helpers/events.ts` | PORT | Module events.ts. |
| `sdk/src/platform/runtime/store/helpers/index.ts` | PORT | Re-exports ./reducers.js, ./reducers/conversation.js, ./reducers/lifecycle.js, ./reducers/shared.js, ./reducers/sync.js. |
| `sdk/src/platform/runtime/store/helpers/reducers/conversation.ts` | PORT | Exports updateConversationState. |
| `sdk/src/platform/runtime/store/helpers/reducers/lifecycle.ts` | PORT | Exports updateSessionState, updatePermissionState, updateTaskState, updateAgentState, updateOrchestrationState. |
| `sdk/src/platform/runtime/store/helpers/reducers/shared.ts` | PORT | formatPartialToolPreview - The name of the tool call now in flight, or undefined when no tool call has been named yet. |
| `sdk/src/platform/runtime/store/helpers/reducers/sync.ts` | PORT | Returns the transport state for lifecycle events that directly change state, or null for observability-only events. |
| `sdk/src/platform/runtime/store/helpers/reducers.ts` | PORT | Re-exports ./reducers/conversation.js, ./reducers/lifecycle.js, ./reducers/shared.js, ./reducers/sync.js. |
| `sdk/src/platform/runtime/store/index.ts` | PORT | Runtime store, Zustand vanilla store for the GoodVibes platform runtime. |
| `sdk/src/platform/runtime/store/selectors/index.ts` | PORT | Typed selectors for the runtime store. |
| `sdk/src/platform/runtime/store/selectors.ts` | PORT | Re-exports ./selectors/index.js. |
| `sdk/src/platform/runtime/store/state.ts` | PORT | RuntimeState, the canonical top-level state shape for the GoodVibes runtime store. |
| `sdk/src/platform/runtime/surface-feature-flags.ts` | PORT | Maps surface ids to their feature-gate flags and settings keys, and enables a set of capability flags by writing their real domain settings keys. Deterministic id-mapping and set logic, camelCase-to-kebab-case conversion is a fixed string transform, not meaning guesswork. |
| `sdk/src/platform/runtime/surface-root.ts` | PORT | Path helpers for a surface's scoped/shared storage directories, and sanitizing a session id into a safe filename segment (character replacement plus a collision-resistant digest suffix). Deterministic path and string sanitization. |
| `sdk/src/platform/runtime/system-message-policy.ts` | PORT | Host-neutral routing policy for system messages: decides priority, kind and delivery target/shape. The intent marks runtime PORT overall. Guesswork found at lines 13-18 (classifySystemMessagePriority: a keyword/phrase regex over message text - 'fatal', 'crash', 'unhandled exception', bracket tags - deciding high vs low priority) and lines 25-31 (classifySystemMessageKind: regex over a message's leading bracket tag deciding system/operational/wrfc kind). Both are heuristic urgency/kind classification over free text; flagged here per the PORT-file reporting rule as candidate battery/dispatch replacements rather than assigned a disposition change. |
| `sdk/src/platform/runtime/tasks/adapters/acp-adapter.ts` | PORT | Bridges ACP remote subagent tasks into the unified RuntimeTask registry, mapping SubagentStatus to task lifecycle states. |
| `sdk/src/platform/runtime/tasks/adapters/agent-adapter.ts` | PORT | Bridges agent sessions into the unified RuntimeTask registry, wiring runtime bus events and mapping agent lifecycle states to task states. |
| `sdk/src/platform/runtime/tasks/adapters/index.ts` | PORT | Barrel file re-exporting the process, agent, acp and scheduler task adapters. |
| `sdk/src/platform/runtime/tasks/adapters/process-adapter.ts` | PORT | Bridges background OS processes from ProcessManager into the unified RuntimeTask registry by pid and exit code. |
| `sdk/src/platform/runtime/tasks/adapters/scheduler-adapter.ts` | PORT | Bridges scheduled job runs from TaskScheduler into the unified RuntimeTask registry. |
| `sdk/src/platform/runtime/tasks/index.ts` | PORT | Barrel exports and a factory function for creating a UnifiedTaskManager. |
| `sdk/src/platform/runtime/tasks/lifecycle.ts` | PORT | Pure task lifecycle state machine defining which status transitions are valid. |
| `sdk/src/platform/runtime/tasks/manager.ts` | PORT | UnifiedTaskManager: creates tasks, enforces lifecycle transitions, tracks parent/child relationships, emits task events and applies a counted retry policy with optional exponential backoff on failure. |
| `sdk/src/platform/runtime/tasks/registry.ts` | PORT | In-memory index of RuntimeTask records by id, kind, status and parent. |
| `sdk/src/platform/runtime/tasks/types.ts` | PORT | Public parameter and interface types for the TaskManager API. |
| `sdk/src/platform/runtime/telemetry/api-helpers.ts` | PORT | Telemetry helpers: builds attributes, ids, OTLP trace/log/metric documents and redacted views from runtime events. inferSeverity (line 185) and isErrorEventType (line 241) guess an event's severity or error-ness from a regex word list run against the event type string rather than a fixed lookup; flagging for the coordinator since the subsystem stays PORT. |
| `sdk/src/platform/runtime/telemetry/api-ingest.ts` | PORT | Exports ingestExternalTelemetryLogs, ingestExternalTelemetryTraces, ingestExternalTelemetryMetrics. |
| `sdk/src/platform/runtime/telemetry/api-query.ts` | PORT | Exports applyTelemetryRecordFilter, applyTelemetrySpanFilter, telemetryRecordMatches, resolveTelemetryRecordCursor, resolveTelemetrySpanCursor. |
| `sdk/src/platform/runtime/telemetry/api-stream.ts` | PORT | Exports CreateTelemetryStreamInput, createTelemetryEventStream. |
| `sdk/src/platform/runtime/telemetry/api.ts` | PORT | Implement TelemetryIngestSink.ingestLogs, delegates to ingestExternalLogs. |
| `sdk/src/platform/runtime/telemetry/exporters/console.ts` | PORT | ConsoleExporter, development-mode span exporter. |
| `sdk/src/platform/runtime/telemetry/exporters/index.ts` | PORT | Barrel export for telemetry exporters. |
| `sdk/src/platform/runtime/telemetry/exporters/local-ledger.ts` | PORT | LocalLedgerExporter, append-only JSON lines span exporter. |
| `sdk/src/platform/runtime/telemetry/exporters/otlp.ts` | PORT | OTLP HTTP span exporter with fail-safe queue and retry. |
| `sdk/src/platform/runtime/telemetry/exporters/queue.ts` | PORT | Fail-safe, bounded export queue with exponential-backoff retry. |
| `sdk/src/platform/runtime/telemetry/exporters/types.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/runtime/telemetry/index.ts` | PORT | Runtime telemetry module, OTel-compatible tracing and metrics. |
| `sdk/src/platform/runtime/telemetry/instrumentation/domain-bridge-agent-session.ts` | PORT | Exports attachAgentDomain, attachPermissionDomain, attachSessionDomain, attachCompactionDomain. |
| `sdk/src/platform/runtime/telemetry/instrumentation/domain-bridge-plugin-mcp.ts` | PORT | Exports attachPluginDomain, attachMcpDomain. |
| `sdk/src/platform/runtime/telemetry/instrumentation/domain-bridge-shared.ts` | PORT | Exports Env, SpanMap, DomainBridgeHelpers, DomainBridgeAttachmentInput. |
| `sdk/src/platform/runtime/telemetry/instrumentation/domain-bridge-transport-task.ts` | PORT | Exports attachTransportDomain, attachTaskDomain. |
| `sdk/src/platform/runtime/telemetry/instrumentation/domain-bridge.ts` | PORT | DomainBridge, bridges RuntimeEventBus events to OTel span creation. |
| `sdk/src/platform/runtime/telemetry/instrumentation/index.ts` | PORT | Telemetry instrumentation, barrel and factory. |
| `sdk/src/platform/runtime/telemetry/meter.ts` | PORT | RuntimeMeter, lightweight OTel-compatible metric instruments. |
| `sdk/src/platform/runtime/telemetry/redaction-config.ts` | PORT | Telemetry prompt/response redaction configuration. |
| `sdk/src/platform/runtime/telemetry/spans/agent.ts` | PORT | Agent lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/compaction.ts` | PORT | Compaction lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/health.ts` | PORT | Health cascade span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/index.ts` | PORT | Barrel export for span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/llm.ts` | PORT | LLM provider call span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/mcp.ts` | PORT | MCP server lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/permission.ts` | PORT | Permission decision span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/plugin.ts` | PORT | Plugin lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/session.ts` | PORT | Session recovery span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/task.ts` | PORT | Task lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/tool.ts` | PORT | Tool execution span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/transport.ts` | PORT | Transport lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/spans/turn.ts` | PORT | Turn lifecycle span helpers. |
| `sdk/src/platform/runtime/telemetry/tool-format-telemetry.ts` | PORT | Per-model counters of tool-format failure classes (edit not-found, ambiguous, conflict, fallback, exec expectation misses); pure measurement, does not choose tool behavior. |
| `sdk/src/platform/runtime/telemetry/tracer.ts` | PORT | RuntimeTracer, lightweight OTel-compatible span factory. |
| `sdk/src/platform/runtime/telemetry/types.ts` | PORT | OTel-compatible type definitions for the lightweight RuntimeTelemetry layer. |
| `sdk/src/platform/runtime/tools/adapter.ts` | PORT | Execution phases for the phased tool executor. |
| `sdk/src/platform/runtime/tools/context.ts` | PORT | Minimal read/subscribe interface over the Zustand RuntimeStore. |
| `sdk/src/platform/runtime/tools/index.ts` | PORT | src/runtime/tools/index.ts, barrel and factory for the phased tool executor. |
| `sdk/src/platform/runtime/tools/output-policy.ts` | PORT | ToolClass, semantic classification of a tool's output characteristics. |
| `sdk/src/platform/runtime/tools/phased-executor.ts` | PORT | PhasedToolExecutor, runs a ToolCall through the multi-phase execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/budget.ts` | PORT | budget, Budget enforcement phase for the tool execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/execute.ts` | PORT | Default per-call execution timeout (30 seconds). |
| `sdk/src/platform/runtime/tools/phases/index.ts` | PORT | phases/index.ts, barrel export for all tool execution phase functions. |
| `sdk/src/platform/runtime/tools/phases/map-output.ts` | PORT | mapOutput, Phase 5 of the tool execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/permission.ts` | PORT | permission, Phase 3 of the tool execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/posthook.ts` | PORT | posthook, Phase 6 of the tool execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/prehook.ts` | PORT | prehook, Phase 2 of the tool execution pipeline. |
| `sdk/src/platform/runtime/tools/phases/warnings.ts` | PORT | Adds a phase warning to the structured result and to the text the model sees. |
| `sdk/src/platform/runtime/tools/types.ts` | PORT | BudgetExceedReason, typed discriminant for budget breach events. |
| `sdk/src/platform/runtime/transcript-journal-replay.ts` | PORT | Folds a transcript journal's tail back onto a hydrated conversation at resume: selects the authoritative record by newest timestamp, applies it while preserving title identity, persists a fresh snapshot, and rotates the journal. Deterministic timestamp/seq comparison. |
| `sdk/src/platform/runtime/transcript-journal.ts` | PORT | Append-only WAL-style transcript journal: fixed NDJSON header/record format, fsync-per-append durability, corrupt-tail quarantine by structural validation, and an orphaned-journal reap sweep gated on mtime, size and session liveness. Entirely deterministic format and file-age rules. |
| `sdk/src/platform/runtime/transports/backoff.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/client-transport.ts` | PORT | Re-exports @pellux/goodvibes-transport-core. |
| `sdk/src/platform/runtime/transports/contract-http-client.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/daemon-http-client.ts` | PORT | Exports createHttpTransport. |
| `sdk/src/platform/runtime/transports/daemon-http-client-validators.ts` | PORT | Runtime type validators and wire-shape normalizers for daemon HTTP client responses (tasks, approvals, provider snapshots, telemetry, shared sessions), including a known-session-kind fallback for forward/backward wire compatibility. |
| `sdk/src/platform/runtime/transports/direct-client.ts` | PORT | Re-exports @pellux/goodvibes-transport-core. |
| `sdk/src/platform/runtime/transports/direct.ts` | PORT | Exports DirectTransportSnapshot, DirectTransport, createDirectTransportFromServices, createRuntimeDirectTransport, createDirectTransport. |
| `sdk/src/platform/runtime/transports/domain-events.ts` | PORT | Re-exports @pellux/goodvibes-transport-realtime. |
| `sdk/src/platform/runtime/transports/http-auth.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/http-helpers.ts` | PORT | Exports createJsonRequestInit, maybeObject, readArrayResponse, readControlPlaneSnapshot, buildSessionEnsureBody, buildSessionMessageBody, and more. |
| `sdk/src/platform/runtime/transports/http-json-transport.ts` | PORT | Exports HttpJsonTransportOptions, HttpJsonTransport, createHttpJsonTransport. |
| `sdk/src/platform/runtime/transports/http-retry.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/http-types.ts` | PORT | The agent this surface is running for the input, binds the channel reply. |
| `sdk/src/platform/runtime/transports/operator-remote-client.ts` | PORT | Re-exports @pellux/goodvibes-operator-sdk. |
| `sdk/src/platform/runtime/transports/peer-remote-client.ts` | PORT | Re-exports @pellux/goodvibes-peer-sdk. |
| `sdk/src/platform/runtime/transports/realtime.ts` | PORT | Exports RealtimeTransportOptions, RealtimeTransportSnapshot, RealtimeTransport, createRealtimeTransport. |
| `sdk/src/platform/runtime/transports/remote-events.ts` | PORT | Re-exports ./ui-runtime-events.js, @pellux/goodvibes-transport-realtime. |
| `sdk/src/platform/runtime/transports/runtime-events-client.ts` | PORT | Re-exports @pellux/goodvibes-transport-realtime. |
| `sdk/src/platform/runtime/transports/shared.ts` | PORT | Re-exports ./backoff.js, ./http-auth.js, ./http-json-transport.js, ./http-retry.js, ./remote-events.js, ./sse-stream.js. |
| `sdk/src/platform/runtime/transports/sse-stream.ts` | PORT | Re-exports @pellux/goodvibes-transport-core, @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/stream-reconnect.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/transport-paths.ts` | PORT | Re-exports @pellux/goodvibes-transport-http. |
| `sdk/src/platform/runtime/transports/ui-runtime-events.ts` | PORT | Exports createRemoteUiRuntimeEvents. |
| `sdk/src/platform/runtime/transport.ts` | PORT | Barrel re-export of the transports module (direct, http, realtime, contract routes, SSE, operator/peer remote clients, network helpers). |
| `sdk/src/platform/runtime/ui-events.ts` | PORT | Builds the UI-facing runtime event feed bundle (sessions, turns, tools, providers, agents, workflows, planner, ops) as thin wrappers over the runtime event bus. |
| `sdk/src/platform/runtime/ui/index.ts` | PORT | Runtime UI data surface barrel. |
| `sdk/src/platform/runtime/ui/model-picker/data-provider.ts` | PORT | ModelPickerDataProvider, enriched model picker data surface. |
| `sdk/src/platform/runtime/ui/model-picker/health-enrichment.ts` | PORT | Health enrichment for model picker entries. |
| `sdk/src/platform/runtime/ui/model-picker/index.ts` | PORT | Model picker UI data surface barrel. |
| `sdk/src/platform/runtime/ui/model-picker/types.ts` | PORT | Model picker UI data types. |
| `sdk/src/platform/runtime/ui/provider-health/data-provider.ts` | PORT | Provider health runtime data provider. |
| `sdk/src/platform/runtime/ui/provider-health/fallback-visualizer.ts` | PORT | Exports buildFallbackChainData. |
| `sdk/src/platform/runtime/ui/provider-health/index.ts` | PORT | Provider health runtime read model surface. |
| `sdk/src/platform/runtime/ui/provider-health/types.ts` | PORT | Maximum observed latency in ms (max of recent observations, not a percentile). |
| `sdk/src/platform/runtime/ui-read-model-helpers.ts` | PORT | Generic read-model helpers: combining subscription teardowns, building a store-backed read model, and projecting ids/values from a map with an optional sort comparator. Deterministic utilities. |
| `sdk/src/platform/runtime/ui-read-models-base.ts` | PORT | The UiReadModel<TSnapshot> interface (getSnapshot/subscribe) shared by every read model. |
| `sdk/src/platform/runtime/ui-read-models-core.ts` | PORT | Core UI read models (providers, session, agents, tasks) projected from runtime store state, including a fixed-threshold context-usage warning flag. Deterministic projection and arithmetic, no guesswork. |
| `sdk/src/platform/runtime/ui-read-models-observability-maintenance.ts` | PORT | UI read models for settings/continuity/worktree maintenance snapshots, projected directly from integration helper services. |
| `sdk/src/platform/runtime/ui-read-models-observability-options.ts` | PORT | Type-only options interface (forensics registry) for the observability read models. |
| `sdk/src/platform/runtime/ui-read-models-observability-remote.ts` | PORT | UI read model for remote/distributed runtime state (daemon, acp, pools, contracts, artifacts, supervisor, distributed pairing/peers/work), a direct projection of runtime store and remote services state. |
| `sdk/src/platform/runtime/ui-read-models-observability-security.ts` | PORT | UI read models for security/mcp/local-auth observability: token audit, mcp server security snapshots, attack-path review, plugin quarantine/trust filters. Direct deterministic projection from the token auditor, mcp registry and plugin manager, no judged classification performed here (the deterministic security boundary stays code). |
| `sdk/src/platform/runtime/ui-read-models-observability-system.ts` | PORT | UI read models for intelligence, marketplace, cockpit and health observability: counts and status strings filtered from structured enum fields on runtime store state (mcp server status, provider health status, transport state). Deterministic filtering and counting, no text guesswork; recommendations are delegated to ecosystem/recommendations.js (not in this file list). |
| `sdk/src/platform/runtime/ui-read-models-observability.ts` | PORT | Combines the remote/system/security/maintenance observability read models into one UiObservabilityReadModels object. Barrel plus a small composition function. |
| `sdk/src/platform/runtime/ui-read-models-operations.ts` | PORT | UI read models for automation, routes, watchers, orchestration, communication and control-plane, projected from runtime store state with deterministic sort comparators. |
| `sdk/src/platform/runtime/ui-read-models.ts` | PORT | Top-level barrel and composition combining core, operations and observability read models into UiReadModels. |
| `sdk/src/platform/runtime/ui-service-queries.ts` | PORT | Surface-agnostic query type contracts (environment variables, service inspection, subscriptions, local auth, sessions, tools, provider models/runtime, plan dashboard, ops strategy) plus two factory functions. Deterministic pass-through queries. |
| `sdk/src/platform/runtime/ui-services.ts` | PORT | Groups runtime services into UI-facing service buckets (environment, shell, agents, providers, sessions, platform, planning, coordination, runtime) plus events and read models. Pure composition/regrouping. |
| `sdk/src/platform/runtime/ui.ts` | PORT | The curated public barrel for the runtime UI surface: read models, guidance, integration helpers, model-picker and provider-health data providers, notification router and policies. |
| `sdk/src/platform/runtime/update-schedule.ts` | PORT | The periodic update-check loop cadence: boot-settle delay, steady interval, and a busy-retry cadence when an update is deferred. Deterministic timer scheduling with injectable timers for tests. |
| `sdk/src/platform/runtime/voice-setup-services.ts` | PORT | Thin adapter mapping a host's injected seams (config manager, shell paths, voice provider registry) onto the SDK's voice setup service, and optionally wiring boot-time wake-model provisioning. Deterministic composition. |
| `sdk/src/platform/runtime/voice-setup.ts` | PORT | Composes the daemon's managed local-voice setup service: single-flight install, live install-progress folded into status(), ownership-aware config key preconfigure, and a live TTS/STT round-trip proof. Provisioning success is proven by actually running the engines, not guessed from a config classification; deterministic structural checks and admission gating. |
| `sdk/src/platform/runtime/wake-setup.ts` | PORT | The daemon's wake-word model provisioning and chunked same-origin model-serving service, with sha256-pinned artifact identification and single-flight download. Deterministic component-to-path/checksum resolution and byte-offset chunking. |
| `sdk/src/platform/runtime/workspace-registration.ts` | PORT | First-open workspace registration: resolves coverage against the shared cross-surface WorkspaceRegistrationStore, decides whether to offer registration, and records register/decline decisions. Deterministic path-based coverage resolution delegated to the shared store. |
| `sdk/src/platform/runtime/workspace-trust.ts` | PORT | Per-workspace trust gate wrapping the permission machinery's final ask callback: undecided workspaces raise one trust question on the first non-read request and persist the answer; restricted workspaces deny non-read categories. Deterministic category-enum and persisted-state logic, this is the deterministic security boundary, not judged. |
| `sdk/src/platform/runtime/worktree/setup.ts` | PORT | setup.ts Worktree cold-start setup, the per-project provisioning that makes an isolated/worktree agent usable instead of broken-by-default. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/runtime/compaction/quality-score.ts:27` | a fixed list of marker words/phrases ('[Session', 'compaction', 'collapsed', 'summarized', 'condensed', 'context window') matched by substring against message text to decide whether a message is a compaction handoff/summary note | fidelity pattern: check the compacted output's claim that it is a handoff/summary against the source conversation, instead of matching marker words |
| `sdk/src/platform/runtime/compaction/quality-score.ts:123` | a message counts as 'non-trivial retained content' purely because its trimmed text is longer than 20 characters | fidelity pattern: score how much of the source's substance the compacted message actually carries, instead of a character-length cutoff |
| `sdk/src/platform/runtime/compaction/quality-score.ts:149` | semantic retention is the average of four hand-picked boolean signals (handoff marker found, non-trivial length, sane message count, positive token count) with no stated weighting rationale, then blended into the composite score at a fixed 0.45 weight | fidelity pattern rubric score checking the compacted messages' claims against the pre-compaction source, in place of the equal-weight checklist |
| `sdk/src/platform/runtime/forensics/classifier.ts:69` | classifyFailure()'s error-message rungs lower-case the message and keyword-match it: 'timeout'/'timed out' for turn_timeout; 'api error'/'overloaded'/'rate limit'/'quota'/'503'/'500'/'network'/'econnreset'/'fetch failed' for llm_error | ladder pattern: keep the deterministic rungs (cancellation, stop-reason enums, cascade/tool/permission/compaction flags) as code, replace the free-text rungs with a Jev coarsen read of the error message into {turn_timeout, llm_error, other} with confidence, feeding the same ladder |
| `sdk/src/platform/runtime/ops/index.ts:115` | findPlaybooksBySymptom ranks playbooks by counting how many of each playbook's static symptom strings contain the lowercased free-text query as a substring, sorting by that match count descending | a rerank pattern: rank playbooks against the free-text symptom query by relevance, replacing the substring match count |
| `sdk/src/platform/runtime/session-return-context.ts:84` | pendingApprovals falls back, when no hint count is supplied, to counting system messages whose free-text content matches /approval/i, a keyword guess at message meaning rather than a structured field | a yes/no question over each system message: does this message report a pending approval |
| `sdk/src/platform/runtime/setup-contract.ts:125` | mentionsUserTypedCommand runs three regexes over free-text reply prose: a verb (run/type/enter/execute/invoke) near a slash token, a bare leading slash-command shape not inside a URL, and a verb (run/set/update/change/edit) near a dotted config-key shape, to decide whether the reply tells the user to type a command | a yes/no question over the drafted reply text: does this reply tell the user to type a slash command or edit a config key themselves |
| `sdk/src/platform/runtime/system-message-policy.ts:13` | classifySystemMessagePriority decides high versus low priority with HIGH_PRIORITY_RE, a keyword/phrase regex over the message text (fatal, crash, unhandled exception, or specific bracket tags like [Model], [Provider]...switch, [Session]...saved/loaded/restored, [Compaction], [Recovery]...Failed) | a choice question over the message text: high or low priority |
| `sdk/src/platform/runtime/system-message-policy.ts:25` | classifySystemMessageKind decides system versus operational versus wrfc kind by regex matching the message's leading bracket tag against a fixed list ([WRFC] or one of [Scan]/[Local]/[Agents]/[MCP]/[Plugin]/[Hook]/[Tool]/[Exec]/[Remote]/[Bridge]/[Approval]) | a dispatch pattern: route the message to one of the three named kinds by its leading tag |
| `sdk/src/platform/runtime/telemetry/api-helpers.ts:185` | inferSeverity returns 'error' when a NormalizedError is attached, otherwise guesses 'warn' or 'debug' by regex matching known substrings (WARNING, DEGRADED, BLOCKED, DENIED, REJECTED, QUARANTINED for warn; PROGRESS, DELTA, START, STARTED, RUNNING, SYNCING, CONNECTING, INITIALIZING for debug) inside the free-form event type string, defaulting to 'info' | a choice question over the event type string: which of the four severities (error, warn, debug, info) it belongs to |
| `sdk/src/platform/runtime/telemetry/api-helpers.ts:241` | isErrorEventType decides yes/no by regex matching ERROR, FAILED, FAIL, or TERMINAL_FAILURE as a token inside the free-form event type string | a yes/no question: does this event type name describe an error |

## runtime sandbox (QEMU removed, intent lines 49 and 215)

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/runtime/sandbox/backend.ts` | PORT | Local backend probing, launch plans and command execution; the QEMU binary, image and SSH-wrapper plumbing is removed. |
| `sdk/src/platform/runtime/sandbox/manager.ts` | PORT | Sandbox config snapshot, host status, profiles, presets and review, recommendation and inspection renderers; presets and recommendations move from the QEMU backend to local, and /sandbox doctor keeps the local-backend checks. |
| `sdk/src/platform/runtime/sandbox/provisioning.ts` | DROP | QEMU setup: guest bundle, init and setup scaffolds (wrapper, qcow2 image creation, guest bootstrap, SSH config, projection policy) and applying the manifest to settings; removed with QEMU. |
| `sdk/src/platform/runtime/sandbox/qemu-wrapper-template.ts` | DROP | QEMU host-side bash wrapper (host-exec, ssh-guest and launch-qemu-ssh modes); removed with QEMU. |
| `sdk/src/platform/runtime/sandbox/session-registry.ts` | PORT | Sandbox sessions: start, stop, run and export artifacts; the managed QEMU guest launch branch is removed. |
| `sdk/src/platform/runtime/sandbox/types.ts` | PORT | Sandbox model: eval and MCP isolation modes, Windows mode, profiles, presets, sessions, probes and bundles; the QEMU backend, session mode and config fields are removed. |

## sdk published entry points

| File | Disposition | Note |
|---|---|---|
| `sdk/src/auth.ts` | PORT | GoodVibesAuthClient facade: memory and browser localStorage token stores, login/current/token mutation, delegating to TokenStore/SessionManager/PermissionResolver and firing observer auth-transition events. |
| `sdk/src/browser-agent.ts` | PORT | Browser-scoped SDK entrypoint exposing the agent's knowledge/workPlan/artifacts/companion-chat route subset, built on browser-knowledge.ts's factory. |
| `sdk/src/browser-homeassistant.ts` | PORT | Browser-scoped SDK entry point for the Home Assistant Home Graph routes, with status, ask, map and pages helpers. |
| `sdk/src/browser-knowledge.ts` | PORT | Browser-scoped SDK for knowledge, companion chat, artifacts and work-plan routes, plus the DeclaredKeys/OmitDeclared type helpers for open-envelope inputs. |
| `sdk/src/browser-scoped.ts` | PORT | Shared machinery for scoped browser SDKs: route-table-driven operator client, SSE realtime event feeds with turn-lifecycle gating, and the auth shim used by every browser-* entrypoint. |
| `sdk/src/browser.ts` | PORT | createBrowserGoodVibesSdk factory: applies browser-appropriate defaults (location.origin baseUrl, retry/reconnect policy) over createGoodVibesSdk. |
| `sdk/src/client.ts` | PORT | createGoodVibesSdk root factory: wires operator SDK, peer SDK, auth client, auto-refresh middleware and SSE/WebSocket realtime connectors together. |
| `sdk/src/companion-realtime.ts` | PORT | Re-exports forSession from transport-realtime.ts for browser/web/Expo/React Native surfaces. |
| `sdk/src/contracts-node.ts` | PORT | Re-exports the contracts package's Node entrypoint (contract artifact path resolution). |
| `sdk/src/contracts.ts` | PORT | Re-exports the contracts package. |
| `sdk/src/daemon.ts` | PORT | Daemon entrypoint: re-exports goodvibes-daemon-sdk plus the bootDaemon/DaemonServer one-call boot factory and the relay reachability/step-up ceremony exports. |
| `sdk/src/embed.ts` | PORT | The frozen SDK Embedding API 1.0 surface: createEmbeddedSession, permission-callback contract, and typed event subscription re-exports over existing runtime machinery. |
| `sdk/src/errors.ts` | PORT | Re-exports the errors package. |
| `sdk/src/expo.ts` | PORT | Expo entry point: the React Native factory plus the Expo SecureStore token store. |
| `sdk/src/index.ts` | PORT | Root SDK barrel export: re-exports client, auth, browser, web, workers, react-native, expo, observer, events, contracts and error entrypoints under one package. |
| `sdk/src/operator.ts` | PORT | Re-exports the operator-sdk package. |
| `sdk/src/peer.ts` | PORT | Re-exports the peer-sdk package. |
| `sdk/src/react-native.ts` | PORT | React Native entry point: WebSocket-only realtime with retry and reconnect defaults, plus the iOS Keychain and Android Keystore token stores. |
| `sdk/src/transport-core.ts` | PORT | Re-exports the transport-core package. |
| `sdk/src/transport-direct.ts` | PORT | Re-exports the direct client transport type and factory from transport-core. |
| `sdk/src/transport-http.ts` | PORT | Re-exports the transport-http package. |
| `sdk/src/transport-realtime.ts` | PORT | Re-exports the transport-realtime package. |
| `sdk/src/web.ts` | PORT | createWebGoodVibesSdk: a named alias entrypoint wrapping createBrowserGoodVibesSdk. |
| `sdk/src/workers.ts` | PORT | Cloudflare Worker fetch/queue/scheduled handlers that proxy batch-queue requests to the daemon's batch API, with constant-time worker-token auth and a request body size cap. |

## security

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/security/card-fields.ts` | PORT | Classifies whether a form control is a payment field, by standard autocomplete tokens and multilingual name and label regex patterns, so its value is suppressed from browser snapshots. This is the card field classification the intent lists as staying deterministic and never judged, alongside card shape scanning. |
| `sdk/src/platform/security/card-shapes.ts` | PORT | Detects card number, security code and expiry shapes in untrusted text using digit run grouping and the Luhn check, without ever returning the matched characters, for refusing or redacting messages that carry card details. |
| `sdk/src/platform/security/content-taint.ts` | PORT | findContentTaint decides whether an outward action's content derives from untrusted input, using a shared word shingle threshold of 8 words and a shared literal span threshold of 40 characters, with a boilerplate exemption. Flagging for the coordinator: this is a hand tuned text similarity threshold deciding a semantic question (does this content derive from that content), but it is a security check and the intent marks security as a deterministic boundary that stays code and is never judged. |
| `sdk/src/platform/security/generated/public-suffix-data.ts` | PORT | Generated data file: a snapshot of the public suffix list's multi label suffixes, wildcard parent rules and exceptions. |
| `sdk/src/platform/security/http-auth.ts` | PORT | Authenticates an operator HTTP request by per pairing token, shared token (constant time compare) or session cookie, and builds or clears the session cookie. |
| `sdk/src/platform/security/index.ts` | PORT | Barrel file re-exporting the security module's spawn tokens, user auth, http auth, token audit, untrusted content, owner approval, untrusted surface language, turn boundary, content taint and owner identity exports. |
| `sdk/src/platform/security/link-validation.ts` | PORT | validateLinkTarget and followValidatedRedirects gate any link before it is opened: https only, no userinfo, no IP literal host, no mixed script homograph host, registrable domain match against the authorized domain, known shortener refusal, and every redirect hop re-validated. |
| `sdk/src/platform/security/notice-text.ts` | PORT | Sanitizes attacker chosen free text before it appears in a cross channel notice, stripping control characters and the markup or mention trigger characters common to Telegram, Slack and Discord. |
| `sdk/src/platform/security/owner-approval.ts` | PORT | OwnerApprovalStore records and spends short lived, single use, content fingerprint bound approvals that a human gave out of band, the only thing that clears an outward effect refusal. |
| `sdk/src/platform/security/owner-identity.ts` | PORT | Resolves the owner's own mail addresses from configuration only, and checks whether every recipient of an outward send is the owner alone, the one taint exemption. |
| `sdk/src/platform/security/public-suffix.ts` | PORT | registrableDomain computes the eTLD+1 of a host from the bundled public suffix list snapshot, used for domain identity comparison in link validation. |
| `sdk/src/platform/security/spawn-tokens.ts` | PORT | SpawnTokenManager issues and HMAC verifies bounded depth orchestrator and agent spawn tokens and enforces the recursive orchestration policy and capacity gates. |
| `sdk/src/platform/security/token-audit.ts` | PORT | ApiTokenAuditor audits registered API tokens against a scope policy (minimum scope violation) and a rotation cadence (age thresholds), optionally blocking out of policy tokens in managed mode. |
| `sdk/src/platform/security/turn-boundary.ts` | PORT | Decides when the untrusted content exposure window resets: only on an explicit owner request, or input whose origin is attested owner direct or on the fixed 'operator' source list. |
| `sdk/src/platform/security/untrusted-content.ts` | PORT | The untrusted content policy: labels content by surface trust tier, retains a per process ledger of what was read this turn, and evaluateOutwardEffect refuses an outward action whose content derives from untrusted text (via content-taint.ts) unless a matching owner approval clears it. |
| `sdk/src/platform/security/untrusted-surface-language.ts` | PORT | Deterministic per surface wording templates naming what an untrusted source is and who controls it, for refusal messages. |
| `sdk/src/platform/security/user-auth.ts` | PORT | UserAuthManager handles local operator accounts: scrypt password hashing, bootstrap admin credential generation, sessions, and escalating account lockout after repeated failed logins. |
| `sdk/src/platform/tools/fetch/host-utils.ts` | PORT | Glob-style host pattern matcher shared by the fetch tool's trust-tier and network-scope checks; deterministic, never judged. |
| `sdk/src/platform/tools/fetch/sanitizer.ts` | PORT | Deterministic response sanitizer for the fetch tool with three fixed modes (none, safe-text, strict) stripping HTML/script/control characters; never judged. |
| `sdk/src/platform/tools/fetch/trust-tiers.ts` | PORT | Classifies an outbound fetch host into trusted/unknown/localhost/blocked using IP-range, metadata-hostname and allow/block-list checks (SSRF protection); deterministic, never judged. |
| `sdk/src/platform/tools/fetch/untrusted-ingest.ts` | PORT | Records each successfully fetched page's origin and text into the process untrusted-content ledger so the outward-effect gate can check later sends against it; deterministic recording, no judgment made here. |

## sessions, bookmarks, rewind, export, artifacts

| File | Disposition | Note |
|---|---|---|
| `daemon-sdk/src/artifact-upload.ts` | PORT | Daemon route handler for artifact upload; parses multipart form-data and content-type/header text, all fixed MIME formats, not meaning guesses. |
| `daemon-sdk/src/sessions.ts` | PORT | Daemon HTTP route dispatcher for the shared-session API family (create/register/close/reopen/detach/messages/inputs/steer/follow-up/events). Pure URL-path routing by fixed regex, no decision points. |
| `sdk/src/platform/artifacts/index.ts` | PORT | Barrel file re-exporting the ArtifactStore class and artifact type helpers. |
| `sdk/src/platform/artifacts/store.ts` | PORT | ArtifactStore manages creating, fetching, listing and pruning artifact files on disk, including remote fetch with SSRF host-trust checks. |
| `sdk/src/platform/artifacts/types.ts` | PORT | Artifact type definitions plus deterministic mime-type and kind lookup tables (file extension to mime type, mime type to a file, image, audio, video, document, data or archive category). |
| `sdk/src/platform/bookmarks/index.ts` | PORT | Barrel file re-exporting BookmarkManager. |
| `sdk/src/platform/bookmarks/manager.ts` | PORT | BookmarkManager toggles and lists in memory bookmarks for the session and saves or loads bookmarked block content to disk. |
| `sdk/src/platform/export/index.ts` | PORT | Barrel file re-exporting the markdown and session export helpers. |
| `sdk/src/platform/export/markdown.ts` | PORT | exportToMarkdown formats a conversation's messages, tool calls and token usage into a Markdown document. |
| `sdk/src/platform/export/session-export.ts` | PORT | Exports a conversation to JSON, Markdown or a styled self contained HTML document, with optional redaction of sensitive fields. |
| `sdk/src/platform/rewind/conversation-host-broker.ts` | PORT | ConversationRewindHostBroker lets a surface register as the live host of a session's conversation and answers rewind preview or apply requests by asking that host over its own connection, with lease expiry and bounded pending requests. |
| `sdk/src/platform/rewind/index.ts` | PORT | Barrel file re-exporting the unified rewind service, token store, conversation host broker and turn anchor helpers. |
| `sdk/src/platform/rewind/service.ts` | PORT | UnifiedRewindService plans and applies a message anchored rewind of files and/or conversation, using a confirm token and recording an undo point. |
| `sdk/src/platform/rewind/tokens.ts` | PORT | RewindTokenStore issues and consumes single use, short lived confirm tokens bound to a rewind plan's fingerprint. |
| `sdk/src/platform/rewind/turn-anchors.ts` | PORT | Records and persists the conversation message count boundary at each completed turn, so a rewind can truncate the conversation to match a workspace checkpoint; also reaps orphaned sidecar files by age. |
| `sdk/src/platform/rewind/types.ts` | PORT | Type definitions for the rewind service's ports, plan and receipt payloads. |
| `sdk/src/platform/sessions/change-tracker.ts` | PORT | SessionChangeTracker records which files were written or edited during the current runtime session. |
| `sdk/src/platform/sessions/index.ts` | PORT | Barrel file re-exporting the change tracker, session manager and cross session orchestration module. |
| `sdk/src/platform/sessions/manager.ts` | PORT | SessionManager saves, loads, lists, renames, deletes and searches JSONL session files, with atomic writes and a sticky user/auto save source stamp. |
| `sdk/src/platform/sessions/orchestration/graph.ts` | PORT | SessionTaskGraph is the in memory cross session task graph: task refs, dependency edges with cycle detection, handoffs, subtree collection and scoped cancellation. This is session task bookkeeping, not the dropped agents/orchestration WRFC subsystem. |
| `sdk/src/platform/sessions/orchestration/index.ts` | PORT | Barrel file re-exporting the cross session task graph types, SessionTaskGraph and CrossSessionTaskRegistry. |
| `sdk/src/platform/sessions/orchestration/registry-housekeeping.ts` | PORT | Pure content validation and age/count bounded reaping of the persisted cross session task graph file (refs, edges, handoffs), plus quarantine of unreadable or future versioned files. |
| `sdk/src/platform/sessions/orchestration/registry.ts` | PORT | CrossSessionTaskRegistry persists SessionTaskGraph to disk, hydrates and reaps it on load, and sweeps it periodically. |
| `sdk/src/platform/sessions/orchestration/types.ts` | PORT | Type definitions for cross session task refs, dependency edges, handoff records, cancellation requests and the graph snapshot. |

## skills

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/skills/index.ts` | JEV | Barrel re-export of the skill model, store and service. |
| `sdk/src/platform/skills/model.ts` | JEV | Parses and serializes a skill's Markdown-plus-frontmatter document (a small fixed subset of YAML) and validates skill name slugs; fixed-format parsing, not guesswork. Contains no skill-relevance decision itself; the rerank pattern applies wherever a caller picks which skill's description matches the current need, which is not implemented in this file. |
| `sdk/src/platform/skills/service.ts` | JEV | Transport-neutral CRUD service over an injectable SkillStore, owning name/description validation and honest not-found/already-exists errors; no relevance decision here. |
| `sdk/src/platform/skills/store.ts` | JEV | Storage seam for skills: a filesystem store (one Markdown file per skill in a directory) and an in-memory store; plain file and map I/O, no decision. |

## state

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/state/canonical-memory.ts` | PORT | canonical-memory.ts, the ONE cross-surface memory identity (see CHANGELOG 1.0.0). |
| `sdk/src/platform/state/code-index-chunking.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/state/code-index-db.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/state/code-index-reindex.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/state/code-index-store.ts` | PORT | SQLite and sqlite-vec backed store for the repo code index: builds, reindexes and searches tree-sitter chunked code by embedding distance, with a deterministic token-overlap lexical fallback when the vector path is unavailable or provider-mismatched. The distance-to-similarity and token-overlap ratios are standard nearest-neighbor search math, not natural-language judgment. |
| `sdk/src/platform/state/code-index-types.ts` | PORT | Type definitions for the code index: chunk shape, search result (distance, similarity, semantic/lexical label) and build options. |
| `sdk/src/platform/state/consolidation-receipt.ts` | PORT | A one-line receipt for a consolidation run that changed something, or null when the run merged/archived/decayed/proposed nothing (a quiet idle pass, no notice, matching the check-in "stayed quiet" discipline). |
| `sdk/src/platform/state/file-cache.ts` | PORT | A cache entry tracking file read history and content state. |
| `sdk/src/platform/state/file-undo.ts` | PORT | Absolute resolved path to the file. |
| `sdk/src/platform/state/file-watcher.ts` | PORT | Default paths to watch relative to project root. |
| `sdk/src/platform/state/index.ts` | PORT | Re-exports ./canonical-memory.js, ./code-index-reindex.js, ./code-index-store.js, ./consolidation-receipt.js, ./file-cache.js, ./file-undo.js. |
| `sdk/src/platform/state/json-file-store.ts` | PORT | JsonFileStore, generic JSON file persistence with atomic writes. |
| `sdk/src/platform/state/knowledge-injection.ts` | PORT | Selects and ranks memory records to inject into a task prompt as project knowledge, and formats the injection block. scoreKnowledge (line 98) is a hand-weighted score adding fixed points for review state and for each keyword token found in the record text; determineReason (line 48) and determineIngestMode (line 86) explain relevance by the same keyword-token matching plus a semantic-similarity percentage; flagging all three for the coordinator since state stays PORT, they read like the knowledge subsystem's relevance/quality batteries. |
| `sdk/src/platform/state/kv-state.ts` | PORT | Reserved keys that cannot be set by callers. |
| `sdk/src/platform/state/memory-consolidation-config.ts` | PORT | Config shape and resolver for idle-time memory consolidation settings (intervals, merge/decay/proposal caps, decay age and confidence step), reading the learning.consolidation config block with typed fallbacks to fixed defaults. |
| `sdk/src/platform/state/memory-consolidation-scheduler.ts` | PORT | memory-consolidation-scheduler.ts, the daemon-side driver that makes the consolidation engine actually run. |
| `sdk/src/platform/state/memory-consolidation.ts` | PORT | Idle-time memory consolidation: groups active records by a normalized summary key (line 108, lowercase and strip punctuation) to find duplicates, merges or flags contradictions, decays never-referenced aged records by a fixed confidence step, and proposes stale deletes; the normalized-key grouping is a hand-built text-equality stand-in for the knowledge subsystem's duplicate-by-entity-alignment battery, flagging for the coordinator since state stays PORT. |
| `sdk/src/platform/state/memory-embedding-http.ts` | PORT | Exports createBuiltinMemoryEmbeddingProviders. |
| `sdk/src/platform/state/memory-embeddings.ts` | PORT | Exports DEFAULT_MEMORY_EMBEDDING_DIMS, MemoryEmbeddingProviderState, MemoryEmbeddingUsage, MemoryEmbeddingRequest, MemoryEmbeddingResult, MemoryEmbeddingProviderStatus, and more. |
| `sdk/src/platform/state/memory-file-projection.ts` | PORT | Projects standing project/team memory records to one git-backed markdown file per record and reads user edits back as review-queue proposals, never a silent store write; parses a fixed markdown front-matter format. |
| `sdk/src/platform/state/memory-ingest.ts` | PORT | Builds MemoryAddOptions for incident, policy-preflight, MCP-security and plugin-security records from already-classified structured fields, assigning each a fixed hand-picked confidence number (60-90) by category; the risk/fact split reads a known enum or boolean, not free text, so it is deterministic rather than guesswork, flagging the hard-coded confidence numbers anyway for the coordinator. |
| `sdk/src/platform/state/memory-recall-contract.ts` | PORT | The cross-surface recall-honesty contract: a fixed confidence floor (60) and flagged-state exclusion decide prompt-injection eligibility, and search degrades honestly with a stated reason when the semantic index is unavailable; all gates are against fixed numbers and enum states, not free-text judgment. |
| `sdk/src/platform/state/memory-registry.ts` | PORT | Thin observable wrapper around MemoryStore: forwards add/search/update/review/delete/link calls and notifies subscribers on writes. |
| `sdk/src/platform/state/memory-store-helpers.ts` | PORT | SQLite schema setup, row-to-record parsing and field normalizers for memory records. reviewQueueScore (line 153) and scoreRecord (line 164) are hand-weighted scores, review-state and tag/provenance counts for queue priority, and a lowercased substring match on the query against summary/detail text for search relevance, flagging both for the coordinator since state stays PORT. |
| `sdk/src/platform/state/memory-store.ts` | PORT | The SQLite-backed MemoryStore: add/get/update/review/delete, literal and semantic search, bundle export/import and doctor checks. Ranks both literal and semantic search results through scoreRecord (memory-store-helpers.ts) and, for semantic hits, combines vector similarity and the lexical score with hand-picked weights (similarity*100 + lexicalScore*0.25, line 437); flagging for the coordinator since state stays PORT. |
| `sdk/src/platform/state/memory-temporal.ts` | PORT | memory-temporal.ts, temporal validity windows for memory records. |
| `sdk/src/platform/state/memory-usage-detection.ts` | PORT | Classifies whether a model's response 'referenced' or merely had 'present' an injected memory, by stopword-filtered distinctive-token and two-word-phrase overlap between the memory text and the response (classify, line 67); a heuristic relevance judgment explicitly labelled as non-authoritative, flagging for the coordinator since state stays PORT. |
| `sdk/src/platform/state/memory-usage-stats.ts` | PORT | memory-usage-stats.ts, per-memory usage counters (HOISTED to the SDK). |
| `sdk/src/platform/state/memory-vector-store.ts` | PORT | sqlite-vec backed vector index for memory records: resolves the db path, builds the embedding source hash and text, and converts vector distance to a similarity score with the same deterministic formula as the code index. |
| `sdk/src/platform/state/mode-manager.ts` | PORT | Switch the active HITL mode. |
| `sdk/src/platform/state/persistent-store.ts` | PORT | PersistentStore, generic JSON file persistence with atomic writes. |
| `sdk/src/platform/state/project-index.ts` | PORT | A file entry in the flat in-memory index. |
| `sdk/src/platform/state/sqlite-store.ts` | PORT | Human store name for honest versioning messages. |
| `sdk/src/platform/state/sqlite-vec-loader.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/state/store-snapshots.ts` | PORT | Store snapshots: point-in-time copies of the SQLite files the platform writes, kept beside each store under `snapshots/<db-file-name>/`. |
| `sdk/src/platform/state/store-versioning.ts` | PORT | SQLite schema versioning for every store the platform writes. |
| `sdk/src/platform/state/store-write-queue.ts` | PORT | StoreWriteQueue, one whole-file write at a time, in call order. |
| `sdk/src/platform/state/telemetry.ts` | PORT | Exports ToolCallRecord, TelemetryFilter, TelemetrySummary, TelemetryDB. |
| `sdk/src/platform/state/vibe-projection.ts` | PORT | vibe-projection.ts, VIBE.md as a PROJECTION of memory records (see CHANGELOG 1.0.0). |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/state/knowledge-injection.ts:48` | determineReason explains why a memory record was injected by checking whether a task token or write-scope token appears as a substring in the lowercased summary/detail/tags/provenance text, or by reporting a semantic-similarity percentage, falling back to a fixed phrase when none match | part of a rerank pattern: a short justification field on each ranked candidate stating which evidence (task match, scope match, semantic match) put it in the result |
| `sdk/src/platform/state/knowledge-injection.ts:76` | hasKeywordMatch decides yes/no relevance by substring-testing task/scope tokens against the lowercased summary/detail/tags/provenance text; determineIngestMode (line 86) labels the record hybrid-ranked, semantic-ranked or keyword-ranked from that same yes/no plus whether a semantic similarity score is present | a yes/no question, part of the same rerank pattern: does this record's text match the task or write scope |
| `sdk/src/platform/state/knowledge-injection.ts:98` | scoreKnowledge computes a hand-weighted relevance score: the record's confidence, plus 40/20/-30 for reviewed/fresh/stale review state, plus 20 per matching task token and 15 per matching scope token found as a substring in the record text; selectKnowledgeForTaskScored (line 185) adds semantic similarity times 70 on top | a rerank pattern: rank candidate memory records against the task and write scope by relevance, replacing the hand-tuned point totals with a ranked judgment |
| `sdk/src/platform/state/memory-consolidation.ts:108` | normalizeKey lowercases and strips non-alphanumeric characters to build a grouping key from a record's summary; planAndApplyMerges (line 199-201) also compares two records' normalizeKey(detail) for exact string equality to decide whether they are true duplicates versus a contradiction, a hand-built text-equality stand-in for real duplicate detection | an alignment pattern: score whether two memory records refer to the same entity/fact on a 3-level match (duplicate, contradiction, unrelated) instead of normalized-string equality |
| `sdk/src/platform/state/memory-store-helpers.ts:164` | scoreRecord ranks search results by starting from the record's confidence, then adding 30 if the lowercased query is a substring of the summary, 20 if it is a substring of the detail, 15 if the search used semantic matching, up to 25 for tag overlap count, and subtracting 20 if the record is flagged for review | a rerank pattern: rank memory records against the search query by relevance, replacing the hand-tuned point totals with a ranked judgment over the query and each record's text |
| `sdk/src/platform/state/memory-store.ts:437` | searchSemantic combines the vector index's similarity score with scoreRecord's lexical score using hand-picked weights (similarity*100 + lexicalScore*0.25) to rank semantic search hits | a rerank pattern: rank candidate memory records against the query by relevance, folding vector similarity and lexical relevance into one ranked judgment instead of a hand-picked weighted sum |
| `sdk/src/platform/state/memory-usage-detection.ts:67` | classify decides whether a model response 'referenced' or merely had 'present' an injected memory by stopword-filtered distinctive-token overlap (needs 2 shared distinctive tokens, or 1 shared token of length >=6) or a shared distinctive two-word phrase (distinctiveTokens line 48, distinctivePhrases line 60) between the memory text and the response text | a yes/no question: does the model's response show it actually used this specific memory, not just that the memory was present in the prompt |

## sub-agents

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/agents/archetypes.ts` | PORT | Loads named agent archetypes from .goodvibes/agents/*.md or built-in templates. |
| `sdk/src/platform/agents/communication-policy.ts` | PORT | Decides which agent roles may message which, by template role. |
| `sdk/src/platform/agents/completion-answer.ts` | PORT | Renders what a finished agent says, as opposed to what it did. |
| `sdk/src/platform/agents/completion-report.ts` | PORT | Structured per-archetype completion reports agents include in their final output; the contract runner reads them instead of the WRFC controller. |
| `sdk/src/platform/agents/conversational-contract.ts` | PORT | The text standard a conversational turn is held to, shared by every surface. |
| `sdk/src/platform/agents/conversational-reply-recovery.ts` | PORT | What to do when a run that owes a person an answer produces nothing. |
| `sdk/src/platform/agents/conversation-continuation.ts` | JEV | Continuation half of the spawn gate: whether a follow-up message escalates to work. |
| `sdk/src/platform/agents/conversation-gate.ts` | JEV | Conversation-first spawn gate: decides whether an inbound message gets a reply or spawns work. |
| `sdk/src/platform/agents/index.ts` | PORT | Barrel for the sub-agent modules. |
| `sdk/src/platform/agents/message-bus-core.ts` | PORT | AgentMessageBus: messages between running agents, with caller-supplied ids. |
| `sdk/src/platform/agents/message-bus.ts` | PORT | Re-export of the agent message bus. |
| `sdk/src/platform/agents/orchestrator-prompts.ts` | PORT | Builds the orchestrator and layered system prompts for agent runs. |
| `sdk/src/platform/agents/orchestrator-runner-context-window.ts` | PORT | Keeps a single agent turn inside the active model context window. |
| `sdk/src/platform/agents/orchestrator-runner.ts` | PORT | runAgentTask: runs one spawned agent task with its turn ceiling. |
| `sdk/src/platform/agents/orchestrator.ts` | PORT | AgentOrchestrator: spawns and supervises sub-agents, with cancellation and conversation snapshots. |
| `sdk/src/platform/agents/orchestrator-utils.ts` | PORT | Helpers for the agent runner: compaction after context warnings, tool-argument summaries. |
| `sdk/src/platform/agents/planner-decomposition-runner.ts` | PORT | Runs a bounded read-only planner agent to decompose work; the contract runner uses it for planning. |
| `sdk/src/platform/agents/progress-audience.ts` | PORT | Decides who a progress line is written for, so owners are not sent internal progress. |
| `sdk/src/platform/agents/session.ts` | PORT | AgentSession: isolated conversation, KV namespace and message log per spawned agent. |
| `sdk/src/platform/agents/turn-budget.ts` | PORT | Resolves the configurable per-agent turn ceiling. |
| `sdk/src/platform/agents/turn-knowledge-injection.ts` | JEV | Chooses knowledge and code snippets to inject into each agent turn within a token budget. |
| `sdk/src/platform/agents/work-proposal-store.ts` | PORT | Stores pending work proposals the owner may answer later. |
| `sdk/src/platform/agents/worktree.ts` | PORT | IsolatedWorktree: per-agent git worktree create, commit and integrate. |
| `sdk/src/platform/runtime/orchestration/fleet-count.ts` | PORT | Counts running agents in the fleet. |
| `sdk/src/platform/runtime/orchestration/spawn-policy.ts` | PORT | Policy for when and how many sub-agents may spawn. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/agents/conversation-gate.ts:214` | REQUEST_PREAMBLES regex list guesses whether a message asks for work | intake intent-to-handler battery (choice: converse, propose work, direct request) |
| `sdk/src/platform/agents/conversation-gate.ts:332` | UNAMBIGUOUS_AFFIRMATIVE regex reads a reply as yes | reply pattern (approve, reject, amend, unclear) with bands |
| `sdk/src/platform/agents/conversation-gate.ts:350` | UNAMBIGUOUS_NEGATIVE regex reads a reply as no | reply pattern (approve, reject, amend, unclear) with bands |
| `sdk/src/platform/agents/turn-knowledge-injection.ts:44` | relevance floor of 95 on a hand-weighted scoreKnowledge sum decides what is injected | knowledge rerank (one yes/no per turn and candidate) with an existence check |

## terminal shell

| File | Disposition | Note |
|---|---|---|
| `terminal-shell/src/ansi-sanitize.ts` | PORT | ANSI sanitizer for untrusted content entering a terminal renderer. |
| `terminal-shell/src/bookmark-modal.ts` | PORT | BookmarkModal, state management for the /bookmarks command modal. |
| `terminal-shell/src/bottom-bar.ts` | PORT | Exports BottomBarStyle, createBottomBarLine, writeBottomBarText. |
| `terminal-shell/src/cli-catalog-types.ts` | PORT | cli-catalog-types.ts, the generic argument-parsing engine's catalog contract: what a product declares to get argv parsing, independent of which commands or flags it has. |
| `terminal-shell/src/cli-command-catalog.ts` | PORT | cli-command-catalog.ts, WHAT a terminal-shaped front-end's command line understands. |
| `terminal-shell/src/cli-config-overrides.ts` | PORT | cli-config-overrides.ts, applying `--config key=value`, `--enable`/ `--disable`, `--hostname`/`--port`, and a front-end's own launch-time settings defaults onto a live ConfigManager. |
| `terminal-shell/src/cli-endpoints.ts` | PORT | cli-endpoints.ts, the shared config keys, defaults, and display resolution for the three network endpoints a front-end's daemon exposes: the control plane, the plain HTTP listener, and the web UI. |
| `terminal-shell/src/cli-feature-settings.ts` | PORT | cli-feature-settings.ts, a front-end's own helpers over the SDK's FEATURE_SETTINGS surface. |
| `terminal-shell/src/cli-network-posture.ts` | PORT | Exports BindPostureKind, BindPosture, isLoopbackHost, classifyBindPosture, isNetworkFacing. |
| `terminal-shell/src/cli-parser-engine.ts` | PORT | cli-parser-engine.ts, the argument engine. |
| `terminal-shell/src/cli-parser.ts` | PORT | cli-parser.ts, parses a terminal-shaped front-end's argv into a command word and the flags its vocabulary shares. |
| `terminal-shell/src/cli-redaction.ts` | PORT | Masks credential-bearing values out of config dumps and free text before a diagnostic bundle is written: a trailing-word path pattern plus an explicit backstop key list decide which config paths are sensitive, and a set of known secret-token shape regexes (sk-, ghp_, xox tokens, etc.) redact matching substrings in text; this is credential/security redaction, a deterministic boundary the intent keeps as code, never judged. |
| `terminal-shell/src/cli-types.ts` | PORT | cli-types.ts, the shared shape of a `goodvibes` front-end's command line: every recognized command word, every global flag, and the parse result a caller consumes. |
| `terminal-shell/src/cluster-commands.ts` | PORT | goodvibes-daemon cluster CLI: parses cluster subcommand arguments and flags, calls the corresponding daemon verb over HTTP, and renders the response; the module holds no policy of its own (the daemon decides), and the interactive join flow matches a typed group id/name/prefix against an exact user answer, not a meaning guess. |
| `terminal-shell/src/cluster-remote-daemon-target.ts` | PORT | cluster-remote-daemon-target.ts, how a `cluster` subcommand reaches a daemon. |
| `terminal-shell/src/cluster-render.ts` | PORT | cluster-render.ts, turning a daemon's `cluster` answers into lines a person reads. |
| `terminal-shell/src/conformance.ts` | PORT | conformance.ts, the descriptor/handler drift gate. |
| `terminal-shell/src/conversation-fold-policy.ts` | PORT | conversation-fold-policy.ts, the ONE statement of what a folded transcript block is, shared by every terminal product. |
| `terminal-shell/src/conversation-history.ts` | PORT | InfiniteBuffer - Manages the complete conversation history as a list of lines. |
| `terminal-shell/src/conversation-tree.ts` | PORT | conversation-tree.ts, column geometry for the transcript's branch tree. |
| `terminal-shell/src/delete-key-policy.ts` | PORT | Returns true when `key` should perform a backward-delete (remove the character before the cursor / at end of an end-anchored buffer). |
| `terminal-shell/src/gateway-verbs.ts` | PORT | gateway-verbs.ts, attach handlers for every ws-only gateway verb group, and build the archive-aware fleet registry, in one shared place both daemon front-ends consume. |
| `terminal-shell/src/index.ts` | PORT | Re-exports ./ansi-sanitize.js, ./bookmark-modal.js, ./bottom-bar.js, ./cli-catalog-types.js, ./cli-command-catalog.js, ./cli-config-overrides.js. |
| `terminal-shell/src/layout-engine.ts` | PORT | Exports ShellLayoutRequest, Rect, ShellLayout, SplitPaneLayout, createShellLayout, createSplitPaneLayout. |
| `terminal-shell/src/mcp-runtime-reload.ts` | PORT | Exports McpRuntimeReloadHandle, McpRuntimeReloadOptions, startMcpConfigAutoReload. |
| `terminal-shell/src/model-picker-provider-filter.ts` | PORT | Splits a provider id list into a curated popular group (fixed known ids) and everything else for the model picker's display order, then supports a substring filter query; membership in the popular set only changes display order, not capability, routing or tier, so it does not conflict with the intent's no-vendor-names-in-routing rule, and is not a meaning-guess decision point. |
| `terminal-shell/src/overlay-viewport.ts` | PORT | Exports OverlayWidthClass, getOverlayWidthClass, OverlayViewportBudgetOptions, getOverlayContentBudget, getOverlayMaxWidth, OverlaySurfaceMetricsOptions, and more. |
| `terminal-shell/src/prompt-content-width.ts` | PORT | Computes the footer input box's available text width from terminal column count minus fixed margin/padding/prefix constants, floored at 1; pure layout arithmetic. |
| `terminal-shell/src/render-scheduler.ts` | PORT | render-scheduler.ts, same-tick render coalescing for the terminal shell. |
| `terminal-shell/src/surface-layout.ts` | PORT | Exports SurfaceViewportRequest, VisibleWindow, getSurfaceContentRows, getVisibleWindow, getTrackedVisibleWindow, sliceVisibleWindow. |
| `terminal-shell/src/term-caps.ts` | PORT | term-caps.ts, Terminal capability detection and color downsampling. |
| `terminal-shell/src/terminal-lifecycle.ts` | PORT | terminal-lifecycle.ts, shared terminal enter/restore sequencing for GoodVibes daemon front-ends. |
| `terminal-shell/src/terminal-output-guard.ts` | PORT | Intercepts direct stdout/stderr/console writes while a full-screen TUI renderer owns the screen, logging and rate-limiting a notice instead of letting the write corrupt the display; matching is on stream identity and ANSI-stripped text length, not meaning. |
| `terminal-shell/src/text-layout.ts` | PORT | text-layout.ts, column-arithmetic helpers for laying text out in a fixed-width terminal. |
| `terminal-shell/src/text-selection.ts` | PORT | SelectionManager - Owns text selection state. |
| `terminal-shell/src/transcript-layout.ts` | PORT | transcript-layout.ts, the margin grid every transcript row is measured against. |

## toolchain

| File | Disposition | Note |
|---|---|---|
| `toolchain/src/bin/build-binaries.ts` | PORT | Copy the native addon beside the binary; same-host miss is fatal, cross-target miss fetches via npm pack + tar. |
| `toolchain/src/bin/changelog-gate.ts` | PORT | Module changelog-gate.ts. |
| `toolchain/src/bin/coverage-gate.ts` | PORT | Module coverage-gate.ts. |
| `toolchain/src/bin/package-install-check.ts` | PORT | Module package-install-check.ts. |
| `toolchain/src/bin/per-job-green.ts` | PORT | Module per-job-green.ts. |
| `toolchain/src/bin/post-build-smoke.ts` | PORT | Module post-build-smoke.ts. |
| `toolchain/src/bin/publish-package.ts` | PORT | Read the value that follows a `--flag <value>` argument, or undefined when absent. |
| `toolchain/src/bin/release-cut.ts` | PORT | Module release-cut.ts. |
| `toolchain/src/bin/sdk-pin-gate.ts` | PORT | Module sdk-pin-gate.ts. |
| `toolchain/src/bin/sha256sums.ts` | PORT | Module sha256sums.ts. |
| `toolchain/src/bin/toolchain.ts` | PORT | Dispatcher bin, named after the package itself (`goodvibes-toolchain`). |
| `toolchain/src/bin/train-status.ts` | PORT | goodvibes-train-status, read-only release-train cycle table across the family's local checkouts. |
| `toolchain/src/bin/verification-ledger.ts` | PORT | Module verification-ledger.ts. |
| `toolchain/src/config.ts` | PORT | toolchain.config contract. |
| `toolchain/src/index.ts` | PORT | Re-exports ./config.js, ./lib/build-binaries.js, ./lib/changelog-gate.js, ./lib/coverage-gate.js, ./lib/effects.js, ./lib/load-config.js. |
| `toolchain/src/lib/build-binaries.ts` | PORT | build-binaries, compiles standalone binaries for the configured matrix. |
| `toolchain/src/lib/changelog-gate.ts` | PORT | changelog-gate, asserts CHANGELOG.md carries a section for a version. |
| `toolchain/src/lib/coverage-gate.ts` | PORT | coverage-gate, aggregate (single-process) coverage ratchet. |
| `toolchain/src/lib/effects.ts` | PORT | Injectable effect boundaries. |
| `toolchain/src/lib/load-config.ts` | PORT | Disk loader for toolchain.config. |
| `toolchain/src/lib/optional-externals.ts` | PORT | optional-externals, a compiled build must survive a package the manifest says is optional, and must not survive one it says is required. |
| `toolchain/src/lib/package-install-check.ts` | PORT | package-install-check, static verification of a package as it would install. |
| `toolchain/src/lib/per-job-green.ts` | PORT | per-job-green, the by-reference validation primitive. |
| `toolchain/src/lib/post-build-smoke.ts` | PORT | post-build-smoke, proves a freshly compiled binary boots. |
| `toolchain/src/lib/publish-package.ts` | PORT | publish-package, idempotent npm publish + post-publish propagation poll. |
| `toolchain/src/lib/release-cut.ts` | PORT | release-cut, local release preparation ONLY. |
| `toolchain/src/lib/sdk-pin-gate.ts` | PORT | sdk-pin-gate, verifies a consumer repo pins the SDK correctly. |
| `toolchain/src/lib/sha256sums.ts` | PORT | sha256sums, generate and verify a SHA256SUMS manifest over release assets. |
| `toolchain/src/lib/train-status.ts` | PORT | train-status, one read-only table per release-train cycle showing what the cycle actually involves across the family's local checkouts. |
| `toolchain/src/lib/verification-ledger.ts` | PORT | verification-ledger, aggregation + rendering of a per-area verification inventory. |

## tools

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/runtime/tools/contract-verifier.ts` | PORT | Registration-time contract checks for tools across five dimensions (schema, timeout, permission class, output policy, idempotency). checkSchema (line 173) flags a tool description as too thin using a fixed character-count cutoff rather than judging whether it actually explains the tool; flagging for the coordinator since tools stays PORT. |
| `sdk/src/platform/runtime/tools/phases/validate.ts` | PORT | Phase 1 of the tool execution pipeline: structural pre-flight checks that a tool call has an id, name, object args and a real implementation. |
| `sdk/src/platform/tools/agent/cancel-all.ts` | PORT | Cancels every pending or running agent run over AgentManager's public surface on shutdown; deterministic status filter and cancel loop. |
| `sdk/src/platform/tools/agent/child-failure-envelope.ts` | PORT | Assembles a structured failure envelope for a dead child agent from its own record and transcript. classifyChildFailureReason (line 53) guesses WHY a child died by matching the record's free-text error message against regex keyword groups (max_turns, circuit_breaker, watchdog_timeout, budget_exhausted, claim_unverified, api_error) rather than reading a structured error code; a coarsen/classify pattern (closed set of failure-reason labels) could replace this. |
| `sdk/src/platform/tools/agent/index.ts` | PORT | The agent tool's mode router: spawn, status, cancel, list, templates, get, budget, plan, wait, message, batch-spawn, wrfc-chains, wrfc-history, cohort-status, cohort-report. Deterministic dispatch and formatting; the 'budget' mode's token estimate is a fixed per-call arithmetic guess (200/300 tokens), not a meaning classification. |
| `sdk/src/platform/tools/agent/manager.ts` | PORT | AgentManager: spawns, tracks and cancels in-process subagents, wires orchestration events and WRFC chain creation, and calls into wrfc-batch-policy.ts and root-spawn-chain-decision.ts for the task-prose based WRFC normalization noted in those files' entries. No independent guesswork of its own. |
| `sdk/src/platform/tools/agent/model-routing.ts` | PORT | Resolves a spawn-time model reference (bare id or provider-qualified key) against the live provider registry; deterministic parsing and lookup, no guesswork. |
| `sdk/src/platform/tools/agent/predicates.ts` | PORT | isActiveAgent, a one-line predicate for running-or-pending status; deterministic. |
| `sdk/src/platform/tools/agent/root-spawn-chain-decision.ts` | PORT | Decides whether a parentless agent spawn should be rewritten into a WRFC owner chain, combining a declared role template with taskProseReadsAsRootReviewRole (from wrfc-batch-policy.ts, see that file's note) as a wording-based guess at whether the task text reads like a reviewer/tester role. |
| `sdk/src/platform/tools/agent/schema.ts` | PORT | JSON Schema and TypeScript input type for the agent tool; schema definition only. |
| `sdk/src/platform/tools/analyze/git-modes.ts` | PORT | Git-ref based analyze modes: diff, breaking-change signature comparison, semantic diff summary, and npm upgrade check. runSemanticDiff (line 256) sends the raw diff to a helper model and asks it to rate risk as low/medium/high in free-text JSON (prompt at line 281, parsed at parseSemanticDiffResponse line 21); when the model is unavailable, buildSemanticDiffFallback (line 52) guesses the same low/medium/high risk tier by regex-matching the diff text for async/export/signature/behavior-shaped changes (lines 56-62). This is a free-text-prompt-parsed-into-a-classification plus a hand-tuned keyword-scored fallback, exactly the kind of decision point the brief describes; flagged for the coordinator since tools stays PORT. |
| `sdk/src/platform/tools/analyze/index.ts` | PORT | The analyze tool's mode router, dispatching to the scan-modes.ts and git-modes.ts implementations; deterministic wiring. |
| `sdk/src/platform/tools/analyze/scan-modes.ts` | PORT | Static-analysis analyze modes: impact, dependencies, dead code, security, coverage, bundle, surface, preview, permissions, env audit, test find. runSecurity's SECRET_PATTERNS (line 313) and runPermissions's DANGEROUS_PATTERNS (line 604) are fixed regex lists over source code matching known secret shapes and known dangerous API calls (eval, exec, chmod 777, innerHTML) with a hand-assigned severity per pattern; these are shape/signature scans over code syntax (like a catastrophic-command or card-shape list) rather than natural-language meaning judgments, so they read as deterministic to me, but flagged since DANGEROUS_PATTERNS assigns a hand-tuned severity score (high/medium/low) per matched pattern rather than reading a fixed spec. |
| `sdk/src/platform/tools/analyze/schema.ts` | PORT | JSON Schema for the analyze tool's input across all 14 modes; schema definition only. |
| `sdk/src/platform/tools/analyze/shared.ts` | PORT | Shared helpers for the analyze modes: file collection, path validation, diff-stat parsing, semver comparison, env-key parsing, test-file candidate generation; deterministic utilities, no guesswork. |
| `sdk/src/platform/tools/analyze/types.ts` | PORT | TypeScript input and result types for the analyze tool; type definitions only. |
| `sdk/src/platform/tools/auto-repair.ts` | PORT | Repairs a malformed tool call by inferring a missing agent mode from which params are present, coercing string-to-number/boolean and enum casing, and filling a missing required string param from a spare one. _findStringCandidate (line 181) guesses which spare argument fills a missing required param by substring overlap between the two key NAMES (line 199), a string-similarity-for-identity heuristic over parameter names rather than natural-language prose; flagged for the coordinator since tools stays PORT. |
| `sdk/src/platform/tools/channel/agent-tools.ts` | PORT | Registers every channel plugin's agent-exposed tools into the shared tool registry; deterministic wiring loop. |
| `sdk/src/platform/tools/channel/index.ts` | PORT | The channel tool: inspects and operates channel surfaces (accounts, directory, resolve target, capabilities, run tool/action, authorize) over the channel plugin registry; deterministic mode dispatch, no guesswork. |
| `sdk/src/platform/tools/context-accounting/index.ts` | PORT | Read-only tool reporting the session's own context composition (turn injections, recall contract, token budget, compaction state) honestly, labeling estimated fields as estimates; deterministic reporting, no meaning classification. |
| `sdk/src/platform/tools/control/index.ts` | PORT | The control tool: dispatches on a closed mode enum to list packaged commands, panels, subscription providers or sandbox presets. |
| `sdk/src/platform/tools/control/schema.ts` | PORT | JSON Schema and TypeScript input type for the control tool's mode enum. |
| `sdk/src/platform/tools/edit/core.ts` | PORT | The edit tool's execute path: reads the target file, runs the requested match mode through match.ts, applies replacements, and builds phased and non-phased results, using classifyEditFailure to label failures. |
| `sdk/src/platform/tools/edit/index.ts` | PORT | Barrel export for the edit tool. |
| `sdk/src/platform/tools/edit/match.ts` | PORT | The edit tool's matching engine: exact, fuzzy-line, AST-symbol and ast-grep pattern matching, occurrence selection and replacement. findFuzzyLineMatch (line 39) uses a fixed 0.7 line-similarity threshold to accept a fuzzy match, and classifyEditFailure (line 514) classifies an edit failure by matching fixed phrases the same code emits elsewhere ('not found', 'Ambiguous', 'OCC conflict'); flagging both for the coordinator since tools stays PORT, though both work over program-generated text and code structure rather than free natural language. |
| `sdk/src/platform/tools/edit/notebook.ts` | PORT | Jupyter notebook cell edit support for the edit tool: locates, inserts, replaces and deletes notebook cells by index or id. |
| `sdk/src/platform/tools/edit/phased.ts` | PORT | Wraps the edit tool as a PhasedTool with its category and cancellation metadata. |
| `sdk/src/platform/tools/edit/schema.ts` | PORT | JSON Schema for the edit tool's parameters, deliberately avoiding the oneOf keyword some providers reject. |
| `sdk/src/platform/tools/edit/types.ts` | PORT | Type definitions for edit items, occurrence specs and edit results. |
| `sdk/src/platform/tools/exec/ast-guard.ts` | PORT | Integrates the shell AST normalization pipeline with the exec tool: parses each command, applies the frozen catastrophic-command block, and gates by command classification tier. The classification itself (highestClassification, catastrophicReason) is imported from runtime/permissions/normalization, outside this file; per the intent that exec risk classification moves to the gate, this is the exec-side call site that would repoint at it. |
| `sdk/src/platform/tools/exec/containment.ts` | PORT | Decides whether a command may run given a composition's containment posture (required vs host-allowed) and the resolved sandbox plan; deterministic, no guesswork. |
| `sdk/src/platform/tools/exec/credential-env.ts` | PORT | Scrubs credential-bearing environment variable names (by fixed name-shape patterns) out of a spawned command's environment; deterministic security hygiene, not natural-language classification. |
| `sdk/src/platform/tools/exec/file-ops.ts` | PORT | Executes copy/move/delete file operations ahead of exec commands and rewrites TS/JS import specifiers after a move; deterministic filesystem and text-substitution logic. |
| `sdk/src/platform/tools/exec/index.ts` | PORT | Re-exports createExecTool from runtime.ts. |
| `sdk/src/platform/tools/exec/interactive.ts` | PORT | PTY-backed prompt-answer path for exec: detects a likely terminal prompt in a quiet output tail and routes it through the approval/attention machinery. findPendingPrompt (line 137) guesses whether an unterminated output tail 'looks like a question' via PROMPT_TAIL_PATTERNS (line 126), three regexes over the command's own output text (ends with : or ?, a [y/N]-style bracket, or a (yes/no) choice); flagged for the coordinator since tools stays PORT. |
| `sdk/src/platform/tools/exec/owner-terminal-guard.ts` | PORT | Refuses an exec command that would drive a tmux session the platform did not create, by parsing tmux's own argv syntax (a fixed command-line format), never natural language; deterministic. |
| `sdk/src/platform/tools/exec/phased.ts` | PORT | Wraps the exec tool as a phased tool with a 2-minute executing-phase timeout; wiring only. |
| `sdk/src/platform/tools/exec/policy.ts` | PORT | Bundles a composition's exec postures (sandbox, interaction, containment, owner-terminal) and their refusal builders into one object; deterministic wiring, no guesswork. |
| `sdk/src/platform/tools/exec/result-format.ts` | PORT | Shapes an exec command's result for the caller's verbosity, always disclosing what was dropped; deterministic formatting. |
| `sdk/src/platform/tools/exec/runtime.ts` | PORT | The exec tool's runtime: command decoding, working-directory resolution, retry loop, sandbox and PTY wiring, and the call into the AST guard's risk classification (see ast-guard.ts) before a command runs. isRetryableExecResult (line 671) guesses whether a failure is transient by matching stderr text against fixed error-name patterns (ECONNRESET, ENOTFOUND, EBUSY, ENOMEM, "Resource temporarily unavailable", "Out of memory", etc.) grouped into network/lock/busy/oom categories; flagged for the coordinator since the intent only calls out automation/scheduler for a JEV failure-transience reading, not exec retries. |
| `sdk/src/platform/tools/exec/sandbox.ts` | PORT | Per-command OS sandbox (bubblewrap) availability detection and argv construction; deterministic host probing, explicitly not a permission or risk decision. |
| `sdk/src/platform/tools/exec/schema.ts` | PORT | JSON Schema and TypeScript types for the exec tool's input and result shape, including the retry-on-category enum (network/lock/busy/oom); schema definition only. |
| `sdk/src/platform/tools/fetch/extract.ts` | PORT | HTML content extraction for the fetch tool: strips or rewrites HTML into plain text or markdown, and applies a CSS-like selector, all fixed regex-based transforms over markup structure, not meaning. |
| `sdk/src/platform/tools/fetch/index.ts` | PORT | Barrel export for the fetch tool. |
| `sdk/src/platform/tools/fetch/phased.ts` | PORT | Wraps the fetch tool as a PhasedTool with its category and cancellation metadata. |
| `sdk/src/platform/tools/fetch/runtime.ts` | PORT | The fetch tool's execution runtime: resolves hosts, classifies trust tier via trust-tiers.ts, sets headers, follows redirects, applies sanitization and extraction, and builds the per-URL result. |
| `sdk/src/platform/tools/fetch/schema.ts` | PORT | JSON Schema and types for the fetch tool's parameters (urls, extract mode, sanitize mode, headers, timeouts). |
| `sdk/src/platform/tools/fetch/types.ts` | PORT | Type definitions for a fetch tool URL result and overall output. |
| `sdk/src/platform/tools/find/content.ts` | PORT | Content-search mode for the find tool: matches a pattern across files and, in ranked mode, sorts hits by a hand-weighted score (line 204: +10 exact match, +5 export line, +3 recently modified), flagging that score for the coordinator since tools stays PORT. |
| `sdk/src/platform/tools/find/executor.ts` | PORT | Builds the find tool object, routing each query mode (files, content, symbols, references, structural) to its handler. |
| `sdk/src/platform/tools/find/files.ts` | PORT | Files-mode for the find tool: glob and gitignore-aware file listing. |
| `sdk/src/platform/tools/find/index.ts` | PORT | Barrel export of find tool types and the tool factory. |
| `sdk/src/platform/tools/find/phased.ts` | PORT | Wraps the find tool as a PhasedTool marked read-only and cancellable. |
| `sdk/src/platform/tools/find/references.ts` | PORT | References-mode for the find tool: locates symbol usages via the code intelligence facade. |
| `sdk/src/platform/tools/find/schema.ts` | PORT | JSON Schema and types for the find tool's query modes and output options, documenting the ranked-content scoring weights. |
| `sdk/src/platform/tools/find/shared.ts` | PORT | Shared find tool runtime service, types and helpers: gitignore matching, glob collection, binary detection, warning capping. |
| `sdk/src/platform/tools/find/structural.ts` | PORT | Structural (ast-grep) search mode for the find tool, parsing by file extension and running a structural pattern match. |
| `sdk/src/platform/tools/find/symbols.ts` | PORT | Symbols-mode for the find tool: lists code symbols via the code intelligence facade. |
| `sdk/src/platform/tools/goodvibes-runtime/config-routing.ts` | PORT | Ownership-aware read/write routing for the goodvibes_settings and goodvibes_context tools: sends each config key to its one owning runtime (daemon, client or shared tier) using a fixed key-ownership table, never a guess. |
| `sdk/src/platform/tools/goodvibes-runtime/index.ts` | PORT | The goodvibes_settings and goodvibes_context built-in tools: read/write config through config-routing.ts and report which store answered. |
| `sdk/src/platform/tools/index.ts` | PORT | Assembles and wires the full built-in tool set (read, write, edit, find, exec, repo-map, context accounting, and the rest) into a ToolRegistry for a session. |
| `sdk/src/platform/tools/inspect/executor.ts` | PORT | Routes an inspect tool call to its mode handler (project, frontend) and formats the result. |
| `sdk/src/platform/tools/inspect/frontend.ts` | PORT | Frontend inspection analyzers (component tree, hook dependencies, a11y, layout, stacking, responsive, events) that parse source and JSX structure with fixed pattern matching, not natural-language judgment. |
| `sdk/src/platform/tools/inspect/index.ts` | PORT | The inspect tool definition, validating the mode argument against a fixed set of valid modes. |
| `sdk/src/platform/tools/inspect/project.ts` | PORT | Project inspection: detects test framework, package manager and API routes by matching known literal substrings in package.json scripts and route file conventions. |
| `sdk/src/platform/tools/inspect/schema.ts` | PORT | JSON Schema and types for the inspect tool's modes and options. |
| `sdk/src/platform/tools/inspect/shared.ts` | PORT | Shared types and helpers used across the inspect tool's project and frontend analyzers. |
| `sdk/src/platform/tools/mcp/index.ts` | PORT | The mcp tool: inspects registered MCP server security posture (connected, trust mode, schema freshness, quarantine) and MCP decision records. |
| `sdk/src/platform/tools/mcp/schema.ts` | PORT | JSON Schema and types for the mcp tool's parameters. |
| `sdk/src/platform/tools/packet/index.ts` | PORT | The packet tool: CRUD for structured planning packets (goals, constraints, risks) stored as JSON files under the surface root. |
| `sdk/src/platform/tools/packet/schema.ts` | PORT | JSON Schema and types for the packet tool's parameters. |
| `sdk/src/platform/tools/profile/index.ts` | PORT | The profile tool that records what the owner says about themselves; authority to write is bound by the composition root from the turn's channel, never decided by the model or the tool. |
| `sdk/src/platform/tools/profile/schema.ts` | PORT | JSON Schema and types for the profile tool's parameters. |
| `sdk/src/platform/tools/query/index.ts` | PORT | The query tool: CRUD for open questions raised to the owner or another party, stored as JSON records under the surface root. |
| `sdk/src/platform/tools/query/schema.ts` | PORT | JSON Schema and types for the query tool's parameters. |
| `sdk/src/platform/tools/read/file-readers.ts` | PORT | File-type-specific readers for the read tool (PDF and other non-text formats detected by extension) that extract content into a common shape. |
| `sdk/src/platform/tools/read/index.ts` | PORT | The read tool: reads a file or symbol window from disk or the project index and formats it per the requested extract mode and output format. |
| `sdk/src/platform/tools/read/media.ts` | PORT | Media handling for the read tool: detects image/video type by file extension and magic bytes and converts formats as needed for model consumption. |
| `sdk/src/platform/tools/read/phased.ts` | PORT | Wraps the read tool as a PhasedTool marked read-only and cancellable. |
| `sdk/src/platform/tools/read/schema.ts` | PORT | JSON Schema and types for the read tool's parameters and extract/output modes. |
| `sdk/src/platform/tools/read/text.ts` | PORT | Text extraction helpers for the read tool: windowed reads and code-signature detection using fixed language-keyword regex patterns (export function/class/interface/type). |
| `sdk/src/platform/tools/registry-tool/index.ts` | PORT | The registry tool: search/recommend/dependencies/content modes over skills, agents and tools. search and recommend rank candidates by Fuse.js fuzzy string matching with hand-set field weights (name 3, path 2, description 1, threshold 0.4, lines 137-169) or, without a task, a word-overlap keyword score (line 368); this is the skills subsystem's relevance-by-rerank spot the intent calls out for JEV, flagging for the coordinator since tools stays PORT. |
| `sdk/src/platform/tools/registry-tool/schema.ts` | PORT | JSON Schema and types for the registry tool's search/recommend/dependencies/content modes. |
| `sdk/src/platform/tools/registry-tool/skill-loader.ts` | PORT | Loads a skill's markdown body by an exact case-insensitive match of an input string against the skill's declared trigger phrases or its slash name; no fuzzy or relevance ranking here. |
| `sdk/src/platform/tools/registry.ts` | PORT | Central ToolRegistry: registers tools (optionally through contract verification), repairs malformed tool calls via auto-repair.ts, and executes a tool by name. |
| `sdk/src/platform/tools/remote-trigger/index.ts` | PORT | The remote-trigger tool: inspects and summarizes remote runner pools, contracts and artifacts from the RemoteRunnerRegistry. |
| `sdk/src/platform/tools/remote-trigger/schema.ts` | PORT | JSON Schema and types for the remote-trigger tool's parameters. |
| `sdk/src/platform/tools/repl/index.ts` | PORT | The repl tool: evaluates JS/TS/Python/SQL/GraphQL expressions inside the sandbox, parsing the GraphQL operation shape by fixed regex over GraphQL's own syntax, not natural language. |
| `sdk/src/platform/tools/repl/schema.ts` | PORT | JSON Schema and types for the repl tool's parameters. |
| `sdk/src/platform/tools/repo-map/index.ts` | PORT | repo_map tool: builds a token-budgeted repository map from the import graph, ranking files by dependent count and extracting top-level exports with a regex over source text; the regex is a structural export scanner over code syntax, not a meaning guess over prose. |
| `sdk/src/platform/tools/shared/auto-heal.ts` | PORT | AutoHealer runs a three-stage pipeline (formatter, linter, then an LLM repair call) to fix content that failed write/edit validation, verifying each stage's output by re-parsing it; the LLM call generates replacement code and is checked by transpile success, not a parsed classification, so it is not a decision point. |
| `sdk/src/platform/tools/shared/overflow.ts` | PORT | OverflowHandler spills large tool output to a pluggable backend (file, ledger, or diagnostics log) and returns a truncated head-and-tail excerpt with a typed reference; retention cleanup and label sanitizing are deterministic size/age/count rules. |
| `sdk/src/platform/tools/shared/post-edit-diagnostics.ts` | PORT | Runs a tree-sitter based syntax-only diagnostics provider over a file just written or edited and formats the errors for the tool result; no type checking, no process spawn. |
| `sdk/src/platform/tools/shared/process-manager.ts` | PORT | ProcessManager tracks background processes spawned by the exec tool: spawn, stream output live, timeout watchdog with SIGTERM then SIGKILL, status/output/stop/list commands; this file only tracks and manages processes, it does not classify exec risk (that classification lives in tools/exec, not in this file list). |
| `sdk/src/platform/tools/shared/read-access.ts` | PORT | Shared seam so search/list/map tools apply the same injected read-permission filter the read tool uses, so a restricted file's content is withheld consistently across tools; the filter itself is supplied by the gate, this file only wires and partitions results by it. |
| `sdk/src/platform/tools/shared/schema-fingerprint.ts` | PORT | Computes a stable SHA-256 (or FNV-1a fallback) fingerprint from a tool result's sorted key set and a canonical shape-id table, appended to results as metadata when a feature flag is on; pure hashing over key names, not content. |
| `sdk/src/platform/tools/shared/validators.ts` | PORT | Runs typecheck/lint/test/build validator commands via Bun.spawn with a timeout and formats failures; fixed command table and exit-code based pass/fail, deterministic. |
| `sdk/src/platform/tools/state/index.ts` | PORT | The state tool: get/set/list/clear on KVState, budget and context reporting, memory file read/write with a mirrored retrievable record, telemetry, hooks list/enable/disable/add/remove, output-mode get/set/list, and analytics record/query/summary/export/dashboard/sync; all mode dispatch is a closed enum switch and key sanitizing is a fixed character-class regex, not a meaning guess. |
| `sdk/src/platform/tools/state/schema.ts` | PORT | JSON Schema and TypeScript input types for the state tool's modes and sub-actions. |
| `sdk/src/platform/tools/task/index.ts` | PORT | The task tool: durable cross-session task refs, dependencies, cancellation and handoff, keyed by a host-resolved real session id rather than a model-supplied one; closed-enum mode dispatch, no free-text interpretation. |
| `sdk/src/platform/tools/task/schema.ts` | PORT | JSON Schema and TypeScript input type for the task tool's modes and fields. |
| `sdk/src/platform/tools/team/index.ts` | PORT | The team tool: create/list/show/delete teams and add/remove/set-lanes members, persisted as a JSON file under a scoped storage root; closed-enum mode dispatch over a fixed record shape. |
| `sdk/src/platform/tools/team/schema.ts` | PORT | JSON Schema and TypeScript input type for the team tool's modes and fields. |
| `sdk/src/platform/tools/web-search/index.ts` | PORT | The web_search tool: thin wrapper that forwards query and options to the web-search service and returns its normalized ranked results as JSON. |
| `sdk/src/platform/tools/web-search/schema.ts` | PORT | JSON Schema for the web_search tool's query, provider, verbosity, recency and evidence-extraction options. |
| `sdk/src/platform/tools/workflow/index.ts` | PORT | The workflow tool: a fixed state-machine registry (WRFC loop, fix loop, etc.) plus in-process trigger and schedule managers that spawn shell commands on timer ticks; state transitions are validated against a fixed table, interval parsing is a fixed-format duration string, not a meaning guess. |
| `sdk/src/platform/tools/workflow/schema.ts` | PORT | JSON Schema for the workflow tool's modes, workflow definitions, trigger and schedule fields. |
| `sdk/src/platform/tools/worklist/index.ts` | PORT | The worklist tool: create/list/show worklists and add/complete/reopen/remove checklist items, persisted as a JSON file under a scoped storage root; closed-enum mode dispatch. |
| `sdk/src/platform/tools/worklist/schema.ts` | PORT | JSON Schema and TypeScript input type for the worklist tool's modes and fields. |
| `sdk/src/platform/tools/write/index.ts` | PORT | The write tool: batch file writes with fail_if_exists/overwrite/backup modes, atomic write-then-rename, notebook JSON structure validation, optional atomic-transaction rollback, auto-heal on JS/TS syntax errors, post-write validators, post-edit diagnostics, undo snapshots and change tracking; base64 and encoding checks are fixed-format validation, not meaning guesses. |
| `sdk/src/platform/tools/write/phased.ts` | PORT | Thin adapter wrapping createWriteTool as a PhasedTool in the write concurrency category, non-cancellable. |
| `sdk/src/platform/tools/write/schema.ts` | PORT | JSON Schema and TypeScript input types for the write tool's files, verbosity, dry_run, validate and transaction fields. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/runtime/tools/contract-verifier.ts:173` | checkSchema flags a tool description as too thin using a fixed character-count cutoff (under 10 characters) rather than judging whether the description actually explains what the tool does | a yes/no question over the tool description text: does this description clearly explain what the tool does and when to use it |
| `sdk/src/platform/tools/edit/match.ts:37` | findFuzzyLineMatch (line 39) slides the find text's line count across the file, scores each window by the fraction of normalized lines that match exactly, and accepts the best window as a fuzzy match only when its similarity clears the fixed FUZZY_MATCH_THRESHOLD of 0.7 | a yes/no question, part of an alignment pattern: is this window of file lines close enough to the requested find text to be the same edit target |
| `sdk/src/platform/tools/find/content.ts:206` | ranked mode scores each matched file with hand-picked point values: +3 if the file's mtime is within 95% of the most recently modified match, +10 per matching line whose text contains the exact search pattern, +5 per matching line that starts with 'export', then sorts files by that total | a rerank pattern: rank matched files against the search intent by relevance, replacing the fixed point totals with a ranked judgment |
| `sdk/src/platform/tools/registry-tool/index.ts:148` | fuzzyFilter ranks skills/agents/tools against a query using Fuse.js fuzzy string matching with hand-set field weights (name 3, path 2, description 1) and a fixed match threshold of 0.4, falling back to a plain lowercase substring test over name+path+description when fuse.js is unavailable | a rerank pattern: rank candidate skills, agents, or tools against the query by relevance, replacing the hand-set field weights and threshold with a ranked judgment |
| `sdk/src/platform/tools/registry-tool/index.ts:368` | runRecommend's no-task branch scores each candidate by counting how many words of the (empty) task string appear as a substring in its name+description, a word-overlap keyword score; as written this branch runs only when task is empty, so it always scores 0 and the result is really an alphabetical sort, but the scoring logic is present and would activate word-overlap guesswork if that condition changes | a rerank pattern: rank candidates by relevance to the task text (when one is given), replacing the word-overlap point count |

## transports

| File | Disposition | Note |
|---|---|---|
| `transport-core/src/client-transport.ts` | PORT | Exports ClientTransport, createClientTransport. |
| `transport-core/src/direct.ts` | PORT | Exports DirectClientTransport, createDirectClientTransport. |
| `transport-core/src/event-envelope.ts` | PORT | Exports EventEnvelope, EventEnvelopeContext, createEventEnvelope. |
| `transport-core/src/event-feeds.ts` | PORT | Minimal structural constraint for runtime events. |
| `transport-core/src/index.ts` | PORT | Re-exports ./client-transport.js, ./direct.js, ./errors.js, ./event-envelope.js, ./event-feeds.js, ./middleware.js. |
| `transport-core/src/middleware.ts` | PORT | Transport middleware (Koa-style) for the HTTP transport layer. |
| `transport-core/src/observer.ts` | PORT | TransportObserver, first-class observability interface at the transport layer. |
| `transport-core/src/otel-state.ts` | PORT | Exports SpanContext, Span, OtelApi, readCachedOtelApi, cacheOtelApi, readOtelModuleOverride, and more. |
| `transport-core/src/otel.ts` | PORT | Injects W3C traceparent/tracestate headers from an active OpenTelemetry span when the optional @opentelemetry/api package is present, bundler-opaque dynamic import with sync and async variants; no meaning guessing, pure protocol propagation. |
| `transport-core/src/relay/crypto.ts` | PORT | Runtime-neutral cryptographic primitives for the relay's end-to-end channel: ECDH P-256 key agreement, HKDF-SHA-256 derivation, AES-256-GCM seal/open, and base64url encode/decode, all thin wrappers over Web Crypto; deterministic cryptographic operations, not meaning guessing. |
| `transport-core/src/relay/handshake.ts` | PORT | Derived per-direction session keys plus the transcript binding. |
| `transport-core/src/relay/identity.ts` | PORT | Serializable form of a relay identity, safe to hand to a secret store. |
| `transport-core/src/relay/index.ts` | PORT | Re-exports ./crypto.js, ./handshake.js, ./identity.js, ./pairing.js, ./protocol.js, ./secure-channel.js. |
| `transport-core/src/relay/pairing.ts` | PORT | Self-describing prefix so a scanner can recognize a relay pairing string. |
| `transport-core/src/relay/protocol.ts` | PORT | Wire protocol version. |
| `transport-core/src/relay/secure-channel.ts` | PORT | An authenticated, ordered channel between one client and one daemon, established from a completed handshake. |
| `transport-core/src/relay/tunnel.ts` | PORT | A tunneled HTTP request (surface → daemon). |
| `transport-core/src/uuid.ts` | PORT | Exports createUuidV4. |
| `transport-http/src/auth.ts` | PORT | Normalizes any supported auth-token input form (string, {token}, sync/async function, undefined) into a canonical async resolver, and merges header inputs into a Headers instance or a lower-case plain record; pure normalization, no meaning guessing. |
| `transport-http/src/backoff.ts` | PORT | Return the retry delay for a one-based attempt number. |
| `transport-http/src/client-plumbing.ts` | PORT | The required keys of a contract input. |
| `transport-http/src/contract-client.ts` | PORT | When true, this route is safe to retry on 5xx even for mutating HTTP verbs. |
| `transport-http/src/http-core.ts` | PORT | createHttpJsonTransport: the JSON HTTP request engine with auth, middleware, idempotency keys, retry/backoff and observer hooks; inferTransportHint and the network-error recoverability check classify by exact HTTP status code and by exact-match POSIX/undici error codes on a structured error.code field, a fixed lookup not a meaning guess over prose, so there is no decision point. |
| `transport-http/src/http.ts` | PORT | Exports HttpTransportOptions, HttpTransport, normalizeTransportError, createHttpTransport. |
| `transport-http/src/index.ts` | PORT | Re-exports ./auth.js, ./backoff.js, ./client-plumbing.js, ./contract-client.js, ./http-core.js, ./http.js. |
| `transport-http/src/paths.ts` | PORT | Builds and validates the daemon's fixed URL path table from a base URL, and isPrivateNetworkHost classifies a hostname as private-network (loopback, RFC 1918 ranges, .local mDNS, wildcard bind) to decide whether plain http is allowed; the classification is deterministic CIDR/hostname matching, a security boundary the intent keeps as code, not a meaning guess. |
| `transport-http/src/reconnect.ts` | PORT | Maximum reconnect attempts when reconnect is enabled and the caller does not set a limit. |
| `transport-http/src/retry.ts` | PORT | Per-method retry policy overrides keyed by method ID. |
| `transport-http/src/sse-stream.ts` | PORT | Every `id:` this stream reads, as it reads it. |
| `transport-http/src/sse.ts` | PORT | Exports ServerSentEventOptions, openServerSentEventStream. |
| `transport-realtime/src/connector-options.ts` | PORT | connector-options.ts, the option and observability types both runtime-event connectors (SSE and WebSocket) are configured with. |
| `transport-realtime/src/domain-events.ts` | PORT | Builds lazily-connecting domain event feeds over a pluggable connector (SSE/WebSocket), dispatches to per-type payload/envelope listeners with per-listener error containment, and forSession filters an existing feed to one session id; pure pub-sub plumbing, no meaning guessing. |
| `transport-realtime/src/event-source-connector.ts` | PORT | event-source-connector.ts, the SSE runtime-event connector. |
| `transport-realtime/src/index.ts` | PORT | Re-exports ./domain-events.js, ./relay-transport.js, ./runtime-events.js, ./turn-lifecycle-gate.js. |
| `transport-realtime/src/relay-transport.ts` | PORT | Minimal structural WebSocket shape the relay client needs (browser/Bun/Node). |
| `transport-realtime/src/runtime-events.ts` | PORT | Returns a filtered view of a { |
| `transport-realtime/src/turn-lifecycle-gate.ts` | PORT | turn-lifecycle-gate.ts, which turn a frame belongs to, and whether this consumer is the one rendering it. |

## types, errors, utils, node

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/node/capabilities.ts` | PORT | Exports GoodVibesRuntimeSurface, GoodVibesRuntimeRequirement, GoodVibesRuntimeCapability, GOODVIBES_CLIENT_SAFE_ENTRYPOINTS, GOODVIBES_NODE_RUNTIME_ENTRYPOINTS, GOODVIBES_RUNTIME_CAPABILITIES, and more. |
| `sdk/src/platform/node/index.ts` | PORT | Re-exports ./capabilities.js, ./runtime-boundary.js. |
| `sdk/src/platform/node/runtime-boundary.ts` | PORT | Exports NodeRuntimeBoundaryStatus, NodeRuntimeBoundaryOptions, getNodeRuntimeBoundaryStatus, isNodeLikeRuntime, assertNodeLikeRuntime. |
| `sdk/src/platform/types/daemon-error-contract.ts` | PORT | Module daemon-error-contract.ts. |
| `sdk/src/platform/types/errors.ts` | PORT | Defines AppError/ConfigError/ProviderError/ToolError/AcpError/PermissionError/RenderError and error-classification helpers; this PORT file guesses error meaning from message text by regex in several places (inferErrorCategory line 71, BILLING_MESSAGE_PATTERN line 69, isBillingOrCreditError line 272, isRateLimitOrQuotaError line 292, isContextSizeExceededError line 309, isTransportFailureMessage/TRANSPORT_FAILURE_MESSAGE_PATTERNS line 334-363, isNonTransientProviderFailure line 397); flagged for the coordinator since the intent keeps this subsystem PORT, not JEV, but a failure-transience battery (per the brief's own worked example) would fit these regex classifiers. |
| `sdk/src/platform/types/foundation-contract.ts` | PORT | Exports GatewayMethodTransport, GatewayMethodSource, GatewayMethodAccess, GatewayEventTransport, DistributedPeerKind, DistributedWorkType, and more. |
| `sdk/src/platform/types/generated/foundation-client-types.ts` | PORT | Module foundation-client-types.ts. |
| `sdk/src/platform/types/grid.ts` | PORT | Cell - The atomic unit of the terminal surface grid. |
| `sdk/src/platform/types/index.ts` | PORT | Re-exports ./errors.js, ./grid.js. |
| `sdk/src/platform/types/tools.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/atomic-json-store.ts` | PORT | atomic-json-store, the two file mechanics every on-disk JSON store in this platform shares, in one place. |
| `sdk/src/platform/utils/clipboard.ts` | PORT | ClipboardWriteFunction - Type for surface-specific clipboard write implementations. |
| `sdk/src/platform/utils/concurrency.ts` | PORT | Run async work with a fixed concurrency cap while preserving input order. |
| `sdk/src/platform/utils/error-display.ts` | PORT | Normalizes any thrown value into a NormalizedError (category, source, hint, summary) for logging and daemon error responses; duplicates the same message-text regex classification as types/errors.ts (inferCategory line 122, NETWORK_ERROR_PATTERNS line 14, BILLING_MESSAGE_PATTERN line 120), explicitly kept as a second copy rather than shared; flagged for the coordinator for the same reason as its twin, subsystem stays PORT per the intent. |
| `sdk/src/platform/utils/fetch-with-timeout.ts` | PORT | Sensitive query-parameter keys to strip from logged URLs. |
| `sdk/src/platform/utils/glob-to-regex.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/index.ts` | PORT | Re-exports ./clipboard.js, ./concurrency.js, ./error-display.js, ./fetch-with-timeout.js, ./glob-to-regex.js, ./logger.js. |
| `sdk/src/platform/utils/logger.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/markdown-disclosure.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/notebook.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/notify.ts` | PORT | Fires a terminal bell and a desktop notification (notify-send/osascript) on turn completion past fixed duration thresholds, suppressed under test; thresholds are fixed numeric cutoffs, not a meaning guess. |
| `sdk/src/platform/utils/open-external.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/optional-dependency.ts` | PORT | optional-dependency.ts, loading a package the SDK declares it can live without, and saying so when it is not there. |
| `sdk/src/platform/utils/path-safety.ts` | PORT | Resolves an input path against the provided project root and validates it is contained within the project root. |
| `sdk/src/platform/utils/prompt-loader.ts` | PORT | Reads and chain-loads system prompt files (SYSTEM.md, GOODVIBES.md, nearest AGENTS.md, project file, config-specified file) with recursive @include resolution and cycle/depth guards; purely file-path and include-directive parsing, no meaning classification. |
| `sdk/src/platform/utils/reachable-base-url.ts` | PORT | Rewrites a notification click-target URL's host so a wildcard or loopback bind address becomes a reachable one, based on the control plane's bind mode and where the link is going; WILDCARD_HOSTS/LOOPBACK_HOSTS are fixed sets of literal known host strings (0.0.0.0, 127.0.0.1, etc.), a deterministic lookup rather than a meaning guess over prose. |
| `sdk/src/platform/utils/record-coerce.ts` | PORT | Two small type-cast/type-guard helpers (toRecord, isRecord) for generic dispatch; no runtime decision logic. |
| `sdk/src/platform/utils/redaction.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/request-body.ts` | PORT | Reads and discards the remainder of a request body reader. |
| `sdk/src/platform/utils/retry.ts` | PORT | Configuration for retry behaviour with exponential backoff. |
| `sdk/src/platform/utils/ring-buffer.ts` | PORT | Generic fixed-capacity ring buffer (circular buffer). |
| `sdk/src/platform/utils/safe-regex.ts` | PORT | Exports SafeRegExpOptions, compileSafeRegExp, assertSafeRegexInput, safeRegExpTest, safeRegExpExec. |
| `sdk/src/platform/utils/shell-split.ts` | PORT | Split a shell command string into an argument array. |
| `sdk/src/platform/utils/single-flight.ts` | PORT | single-flight.ts, collapse concurrent invocations of an async operation into one in-flight execution: while a run is in progress every caller joins its promise; the next call after settlement starts a fresh run. |
| `sdk/src/platform/utils/terminal-width.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/url-safety.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/utils/walk-dir.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/version.ts` | PORT | Exports VERSION. |
| `sdk/src/platform/types/pdfjs-dist.d.ts` | PORT | Type declarations for the pdfjs-dist module used by document extraction. |
| `sdk/src/platform/types/peer-deps.d.ts` | PORT | Type declarations for the optional peer dependencies (expo-secure-store, react-native-keychain). |
| `sdk/src/platform/types/sql-js.d.ts` | PORT | Type declarations for sql.js, published as the ./sql-js subpath. |
| `sdk/src/platform/types/vendor-deps.d.ts` | PORT | Type declarations for vendored and optional third-party modules. |
| `sdk/src/platform/types/wasm-files.d.ts` | PORT | Module declarations that let .wasm files be imported as assets. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/types/errors.ts:71` | inferErrorCategory: BILLING_MESSAGE_PATTERN (line 69) picks billing over bad_request/rate_limit for 400/429, then a ladder of regex phrase lists (auth/token/credential, forbidden/access denied, billing/credit/quota, rate limit, timeout, network codes, not found, bad request, protocol) guesses one of the same ten categories from the lowercased message when status alone does not decide it | a dispatch pattern: route the error message text (and status) to one of the ten named categories, with a billing-versus-default choice question for the 400/429 case |
| `sdk/src/platform/types/errors.ts:272` | isBillingOrCreditError falls back, for a plain Error with no structured category or 402 status, to testing BILLING_MESSAGE_PATTERN against the lowercased message to decide yes/no | a yes/no question: does this error message describe a billing or spent-account failure |
| `sdk/src/platform/types/errors.ts:292` | isRateLimitOrQuotaError checks statusCode 429/402 then, for ProviderError and plain Error alike, falls back to a keyword regex (rate limit, too many requests, quota exceeded, throttl, depleted, credits) or a literal '429'/'402' substring in the message to decide yes/no | a yes/no question: does this error message indicate a rate limit or quota exhaustion |
| `sdk/src/platform/types/errors.ts:309` | isContextSizeExceededError decides yes/no by testing the lowercased message against a list of context-window phrases (context_length_exceeded, context length/size/window exceeded, maximum context length, prompt/input too long, tokens exceed, exceeds the model, or both 'context' and 'exceed' present) | a yes/no question: does this error message indicate the model's context window was exceeded |
| `sdk/src/platform/types/errors.ts:334` | TRANSPORT_FAILURE_MESSAGE_PATTERNS, a list of network/transport substrings (fetch failed, econnrefused, enotfound, network error/timeout, econnreset, etimedout, socket hang up, dns, connection lost, epipe, ehostunreach, closed unexpectedly, socket), tested by isTransportFailureMessage (line 361) to decide yes/no when no structured classification is available | a yes/no question, part of a failure-transience battery: does this error message describe a transient network or transport failure |
| `sdk/src/platform/types/errors.ts:397` | isNonTransientProviderFailure checks statusCode 401/402/403 then falls back to testing the lowercased message for econnrefused, enotfound, timeout, or fetch failed substrings to decide whether a provider failure is permanent rather than transient | a yes/no question, part of the same failure-transience battery: is this provider failure non-transient (permanent) rather than transient |
| `sdk/src/platform/utils/error-display.ts:122` | inferCategory: BILLING_MESSAGE_PATTERN (line 120) picks billing over bad_request/rate_limit for 400/429, then a ladder of regex phrase lists (auth/token/credential, forbidden/access denied, billing/credit/quota, rate limit, timeout, network codes, not found, bad request, protocol) guesses one of ten categories from the lowercased message; this duplicates types/errors.ts inferErrorCategory line for line | a dispatch pattern: route the error message text (and status) to one of the ten named categories, with a billing-versus-default choice question for the 400/429 case; one shared implementation instead of two copies |
| `sdk/src/platform/utils/error-display.ts:178` | inferSource guesses the error source is 'transport' when the error is a TypeError whose message matches /fetch/i, a small text-pattern guess layered under the explicit AppError.source and the caller override | folded into the same category/source dispatch: a choice question resolving source from the same evidence used for category, rather than a standalone regex |

## voice, multimodal, media

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/media/builtin-generation-providers.ts` | PORT | Exports builtinGenerationProviders. |
| `sdk/src/platform/media/builtin-image-understanding.ts` | PORT | Built-in and per-vendor image-understanding MediaProvider: prompts a vision model and parses its JSON-shaped reply (fenced or bare braces) into description, text and labels. The 'lowercased text' flag is a mime-type prefix check (image/), a fixed-format check, not guesswork. |
| `sdk/src/platform/media/builtin-providers.ts` | PORT | Exports ensureBuiltinMediaProviders. |
| `sdk/src/platform/media/index.ts` | PORT | Re-exports ./builtin-image-understanding.js, ./builtin-providers.js, ./provider-registry.js. |
| `sdk/src/platform/media/provider-registry.ts` | PORT | SDK-owned platform module. |
| `sdk/src/platform/multimodal/index.ts` | PORT | Re-exports ./service.js. |
| `sdk/src/platform/multimodal/service.ts` | PORT | Coordinates image, audio, video and document analysis across providers and builds a token-budgeted summary packet for a session. Guesswork found (reported per the PORT-file rule): topKeywords() decides which words become 'entities' with a hardcoded stopword list and a token-length-3 cutoff, then ranks by raw frequency. |
| `sdk/src/platform/multimodal/types.ts` | PORT | Type definitions for multimodal analysis requests, results, segments and packets; no logic. |
| `sdk/src/platform/voice/builtin-providers.ts` | PORT | voice.local.* config reader, registers the free local-engine provider when present. |
| `sdk/src/platform/voice/capture/device-binding.ts` | PORT | device-binding.ts, a configured input device is a HINT, not a guarantee. |
| `sdk/src/platform/voice/capture/frames.ts` | PORT | frames.ts, the arithmetic between a device and a consumer. |
| `sdk/src/platform/voice/capture/index.ts` | PORT | voice/capture, microphone capture as a platform capability. |
| `sdk/src/platform/voice/capture/noise-suppression.ts` | PORT | noise-suppression.ts, `voice.wake.noiseSuppression`, as a stage that runs. |
| `sdk/src/platform/voice/capture/push-to-talk.ts` | PORT | push-to-talk.ts, the voice-input session both surfaces drive. |
| `sdk/src/platform/voice/capture/recorder-command.ts` | PORT | recorder-command.ts, which recorder to run, and the exact argv for it. |
| `sdk/src/platform/voice/capture/recorder-source.ts` | PORT | Opens an audio capture stream from a spawned recorder subprocess (pw-record/parecord/arecord/ffmpeg/sox), slices PCM16 output into frames, and classifies a stopped recorder's captured stderr into a failure kind for the caller. |
| `sdk/src/platform/voice/capture/types.ts` | PORT | types.ts, the audio-capture boundary, shared by every voice consumer. |
| `sdk/src/platform/voice/capture/vendor/speexdsp-wasm.ts` | PORT | speexdsp-wasm.ts , GENERATED. |
| `sdk/src/platform/voice/capture/voice-input.ts` | PORT | voice-input.ts, turning captured frames into ONE utterance to transcribe. |
| `sdk/src/platform/voice/diagnostics.ts` | PORT | diagnostics.ts, where a voice failure is written down. |
| `sdk/src/platform/voice/index.ts` | PORT | Re-exports ./builtin-providers.js, ./capture/index.js, ./diagnostics.js, ./model-download.js, ./provider-registry.js, ./providers/local.js. |
| `sdk/src/platform/voice/model-download.ts` | PORT | model-download.ts, atomic download of a local voice model (piper/kokoro .onnx voices and their .json configs). |
| `sdk/src/platform/voice/provider-registry.ts` | PORT | Resolve the provider an UNNAMED request should use. |
| `sdk/src/platform/voice/providers/deepgram.ts` | PORT | Exports createDeepgramProvider. |
| `sdk/src/platform/voice/providers/elevenlabs.ts` | PORT | ElevenLabs voice provider: TTS synthesis (plain and streaming), STT transcription, and realtime session setup against the ElevenLabs API; output-format and mime-type resolution are fixed lookup tables over known technical format names (mp3, pcm, opus, etc.), not a meaning guess over prose. |
| `sdk/src/platform/voice/providers/google.ts` | PORT | Exports createGoogleProvider. |
| `sdk/src/platform/voice/providers/local.ts` | PORT | providers/local.ts, the local voice provider: free, offline STT + TTS behind the exact same seams as the cloud providers. |
| `sdk/src/platform/voice/providers/microsoft.ts` | PORT | The DRM constants and token generator live in a deep subpath of the same optional package, so they get the same treatment as the package itself: no static specifier on the module graph, resolved at the call that needs it |
| `sdk/src/platform/voice/providers/openai.ts` | PORT | OpenAI voice provider: TTS synthesis, STT transcription, and realtime client-secret session setup against the OpenAI audio API; format resolution is a fixed lookup table over known technical format names, not a meaning guess. |
| `sdk/src/platform/voice/providers/shared.ts` | PORT | Shared voice-provider helpers: reading env vars, normalizing base URLs, resolving audio input bytes, fixed lookup tables mapping file extensions/format names to MIME types, and a formula converting a log-probability into a confidence number (deterministic math, not judged). |
| `sdk/src/platform/voice/providers/vydra.ts` | PORT | Exports createVydraProvider. |
| `sdk/src/platform/voice/provisioning/config-preconfigure.ts` | PORT | After provisioning, points voice.local.* config keys at a managed install, using an ownership-tracking install stamp to decide set/skip/supersede per key; the rules are deterministic path-boundary and exact-value comparisons against recorded prior writes, not a meaning guess over prose. |
| `sdk/src/platform/voice/provisioning/download-verified.ts` | PORT | download-verified.ts, atomic, checksum-verified download of one managed voice-runtime component (engine archive or model file). |
| `sdk/src/platform/voice/provisioning/index.ts` | PORT | voice/provisioning, SDK-owned managed provisioning of the local voice runtime (piper TTS + a default voice), atomic + checksum-verified, resumable, with honest states. |
| `sdk/src/platform/voice/provisioning/install-progress.ts` | PORT | install-progress.ts, live per-component progress for the ACTIVE voice.local.install run. |
| `sdk/src/platform/voice/provisioning/managed-root.ts` | PORT | managed-root.ts, where the managed voice tree lives, resolvable without a runtime. |
| `sdk/src/platform/voice/provisioning/manifest.ts` | PORT | manifest.ts, the PINNED local-voice runtime manifest: exact versions, URLs, byte sizes, and sha256 checksums for the managed engines + default models the provisioner installs. |
| `sdk/src/platform/voice/provisioning/provisioner.ts` | PORT | provisioner.ts, managed one-act provisioning of the local voice runtime. |
| `sdk/src/platform/voice/provisioning/round-trip-proof.ts` | PORT | round-trip-proof.ts, provisioning ends by PROVING the runtime works. |
| `sdk/src/platform/voice/provisioning/wake-word-manifest.ts` | PORT | wake-word-manifest.ts, the PINNED wake-word classifier manifest. |
| `sdk/src/platform/voice/service.ts` | PORT | VoiceService: dispatches status/listVoices/synthesize/synthesizeStream/transcribe/openRealtimeSession to the resolved provider and records billable usage (characters for TTS, seconds for STT); pure orchestration and metering, no meaning guessing. |
| `sdk/src/platform/voice/setup-chain.ts` | PORT | Resolves a voice setup request (wake/stt/tts) into a plan of done/propose/ask steps using the platform's shared setup contract shape; branching is over structured boolean context flags (wakeEnabled, sttReady, cloudVoiceProviders, etc.), not a guess over natural-language meaning. |
| `sdk/src/platform/voice/spoken-turn/audio-sink.ts` | PORT | AudioSink, the injectable I/O boundary the spoken-turn policy engine plays through. |
| `sdk/src/platform/voice/spoken-turn/controller.ts` | PORT | SpokenTurnController: shared spoken-output policy that chunks a streamed turn's text, merges it into bounded synthesis requests with retry/backoff, and drives an injected audio sink; isTransientSynthesisError (line 448) decides retry-worthiness by matching keywords (429, rate limit, http 5xx, network, timeout) in the error message text, a failure-transience guess flagged for the coordinator even though this subsystem stays PORT per the intent (the automation/scheduler subsystem is the one the intent marks for a JEV failure-transience reading; this is a second, unlisted site of the same guess). |
| `sdk/src/platform/voice/spoken-turn/index.ts` | PORT | Spoken-turn, the shared spoken-output (live TTS) policy engine. |
| `sdk/src/platform/voice/spoken-turn/speech-markdown.ts` | PORT | Strips markdown syntax (headings, lists, tables, emphasis, links, code fences) out of assistant text before TTS, and a streaming code-fence filter that swallows fenced code blocks from a live delta stream; all regex here is fixed markdown-syntax parsing, not a meaning guess over prose. |
| `sdk/src/platform/voice/spoken-turn/text-chunker.ts` | PORT | TtsTextChunker, turns a stream of provider content deltas into speech-sized chunks at sentence boundaries, with a max-length cut and a latency flush so a long unpunctuated run still starts speaking. |
| `sdk/src/platform/voice/stt-routing.ts` | PORT | stt-routing.ts, which runtime turns captured audio into words. |
| `sdk/src/platform/voice/types.ts` | PORT | Type definitions for the voice provider interface: status, descriptors, synthesis/transcription requests and results, and realtime sessions. |
| `sdk/src/platform/voice/wake/capture-watchdogs.ts` | PORT | capture-watchdogs.ts, the bounds that turn silence into a report. |
| `sdk/src/platform/voice/wake/detector.ts` | PORT | detector.ts, turning a stream of per-frame scores into wake events. |
| `sdk/src/platform/voice/wake/engine.ts` | PORT | engine.ts, the wake-word detector, front end plus classifiers plus rules. |
| `sdk/src/platform/voice/wake/feature-pipeline.ts` | PORT | feature-pipeline.ts, audio in, classifier features out. |
| `sdk/src/platform/voice/wake/index.ts` | PORT | voice/wake, wake-word detection, SDK-owned and isomorphic. |
| `sdk/src/platform/voice/wake/install-provision.ts` | PORT | install-provision.ts, putting the wake-word model on disk AS PART OF INSTALLING, and retrying it at boot. |
| `sdk/src/platform/voice/wake/listener.ts` | PORT | WakeListener: runs the wake-word detector over one capture stream, opening/closing the device, switching to utterance recording on detection, watchdogs for stalled starts and silent streams, and device-pin fallback/recheck; all branching is on structured capture state (frame timestamps, stream errors, device binding), not a meaning guess. |
| `sdk/src/platform/voice/wake/listener-types.ts` | PORT | Type declarations for the wake listener's public contract: phases, state snapshot, start refusals/outcomes, handlers and options. Pure declarations, no logic. |
| `sdk/src/platform/voice/wake/listening-claim.ts` | PORT | Derives what a status surface may claim about wake listening (listening/starting/no-audio/not-listening) purely from structured capture-truth fields (captureOpen, framesFlowing, phase), never from the listener's stated intent; a deterministic mapping, not a meaning guess. |
| `sdk/src/platform/voice/wake/melspectrogram.ts` | PORT | melspectrogram.ts, the wake-word front end's first stage, computed in code. |
| `sdk/src/platform/voice/wake/provisioning.ts` | PORT | provisioning.ts, managed, checksum-pinned download of the wake-word models. |
| `sdk/src/platform/voice/wake/recovery.ts` | PORT | recovery.ts, housekeeping for everything the wake-word feature persists. |
| `sdk/src/platform/voice/wake/runtime.ts` | PORT | runtime.ts, the wake-word detector, minus everything that needs a filesystem. |
| `sdk/src/platform/voice/wake/settings.ts` | PORT | settings.ts, every `voice.wake.*` row, resolved into runtime behaviour once. |
| `sdk/src/platform/voice/wake/supervisor.ts` | PORT | WakeSupervisor: restart/backoff and crash-window latch policy for the wake-word detector process, pure state over crash timestamps and counts against a fixed policy (maxRestarts, backoff, window); deterministic arithmetic, no meaning guessing. |
| `sdk/src/platform/voice/wake/types.ts` | PORT | types.ts, the wake-word engine's boundary types. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `sdk/src/platform/multimodal/service.ts:50` | topKeywords decides which words become an analysis result's 'entities' by tokenizing the combined summary/text/labels, dropping tokens under 3 characters and a small hardcoded stopword list (https, www, the, and, for, with, from, this, that, into, over), then ranking the rest by raw frequency count | an extraction pattern: pull the entities/keywords that matter out of the analyzed text, replacing the frequency-count-over-a-stopword-list heuristic |
| `sdk/src/platform/voice/capture/recorder-source.ts:83` | classifyRecorderFailure() keyword-matches the recorder's captured stderr text for 'permission denied'/'access denied' (permission-denied), 'no such device'/'no target node available'/'unknown pcm' (device-missing), and 'device or resource busy'/'audio open error' (device-unavailable) | coarsen pattern: classify the recorder's stderr text into {permission-denied, device-missing, device-unavailable, other} with confidence, replacing the three keyword groups |
| `sdk/src/platform/voice/spoken-turn/controller.ts:448` | isTransientSynthesisError decides whether a synthesis failure is worth a bounded retry by testing the lowercased error message for '429', 'rate limit'/'rate_limit', 'too many requests', 'concurrent', an 'http 5xx' pattern, or network/timeout words (fetch failed, network, timed out, timeout, econnreset, socket) | a yes/no question, part of a failure-transience battery: is this synthesis failure transient and worth a retry |

## web search

| File | Disposition | Note |
|---|---|---|
| `sdk/src/platform/web-search/index.ts` | PORT | Re-exports ./provider-registry.js, ./providers/brave.js, ./providers/duckduckgo.js, ./providers/exa.js, ./providers/firecrawl.js, ./providers/perplexity.js. |
| `sdk/src/platform/web-search/provider-registry.ts` | PORT | Exports WebSearchProviderRegistry. |
| `sdk/src/platform/web-search/providers/brave.ts` | PORT | Exports createBraveSearchProvider. |
| `sdk/src/platform/web-search/providers/duckduckgo.ts` | PORT | Exports DuckDuckGoProviderOptions, createDuckDuckGoProvider. |
| `sdk/src/platform/web-search/providers/exa.ts` | PORT | Exports createExaSearchProvider. |
| `sdk/src/platform/web-search/providers/firecrawl.ts` | PORT | Exports createFirecrawlSearchProvider. |
| `sdk/src/platform/web-search/providers/perplexity.ts` | PORT | Exports createPerplexitySearchProvider. |
| `sdk/src/platform/web-search/providers/searxng.ts` | PORT | Exports createSearxngSearchProvider. |
| `sdk/src/platform/web-search/providers/shared.ts` | PORT | Exports SearchProviderContext, SearchProviderConfig, JsonRequestConfig, JsonRequestResult, resolveDomain, trimSnippet, and more. |
| `sdk/src/platform/web-search/providers/tavily.ts` | PORT | Exports createTavilySearchProvider. |
| `sdk/src/platform/web-search/service.ts` | PORT | Exports WebSearchServiceStatus, WebSearchService. |
| `sdk/src/platform/web-search/types.ts` | PORT | Exports WebSearchVerbosity, WebSearchSafeSearch, WebSearchTimeRange, WebSearchResultType, WebSearchProviderCapability, WebSearchEvidence, and more. |
