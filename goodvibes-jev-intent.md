# goodvibes-jev: the intended scope of the work

This document sets out what goodvibes-jev is meant to be, how it is built, and the complete list of work. It is self-contained. The only other sources it relies on are the existing goodvibes repos in `~/Projects`:

| Old repo | What it holds |
|---|---|
| `goodvibes-sdk` | The platform library |
| `goodvibes-daemon` | The daemon |
| `goodvibes-tui` | The terminal UI |
| `goodvibes-agent` | The agent product |
| `goodvibes-webui` | The web UI |

The TypeSafe documentation at `https://docs.typesafe.ai/llms-full.txt` describes Jev and its patterns.

## The goal

goodvibes-jev is the goodvibes platform with Jev (TypeSafe's System One judgment model) built in wherever it fits. Everything goodvibes does today carries over. Jev replaces the places where the old code made decisions with guesswork: keyword lists, regexes over prose, length cutoffs and guessed classifications.

The work is a new monorepo at `~/Projects/goodvibes-jev`. It never modifies the old repos.

## How each piece is handled

Go through everything goodvibes does, systematically. Every module in the old repos gets exactly one disposition:

| Disposition | Meaning |
|---|---|
| PORT | The old code comes across with its behaviour and interface intact. Only its imports change, to point at the engine. |
| JEV | The old code comes across, and the decisions it makes by guesswork become Jev readings. The rest of the module stays as it was. |
| HOIST | A module in a product that is really platform behaviour. It moves into the engine, and the product calls it from there. |
| DROP | Not carried forward. What replaces it is named below. |

**The UI is not redesigned.** Every screen, panel, command, style and interaction in the TUI, agent and web UI looks and behaves as it does in the old products.

## Structure

```
packages/judgment   the level 0 Jev foundation
packages/engine     the platform library (the old sdk, renamed "the engine")
products/daemon     composition root, verbs, CLI, packaging
products/tui        the goodvibes terminal UI over the engine
products/agent      the goodvibes agent over the engine
products/webui      the goodvibes web UI over the daemon contract
```

A product holds its rendering, input capture, composition root and packaging. Platform behaviour lives in the engine.

Out of scope:
- **Other products:** goodvibes-app, goodvibes-homeassistant, goodvibes-plugin, goodvibes-codex and goodvibes-desktop.
- **QEMU sandboxing:** removed.
- **Mobile client surfaces:** expo, react-native, and the Android and iOS token stores. There is no mobile product.

## Jev: the level 0 foundation and how it is used

**Level 0 foundation (`packages/judgment`).** This is built first and uses everything Jev offers:
- **Batteries:** named decisions defined with fixtures, run live against Jev, with thresholds and bands.
- **Typed readings:** yes/no, choice over fixed options, and score on a rubric.
- **Patterns:** routing (dispatch over closed sets), judging output against a goal, rerank, existence checks, reply reading, entity alignment, fidelity checks, and policy checklists.
- **Compound patterns:** combinations of the above, plus patterns of the project's own.
- **Infrastructure:** a decision log recording every reading, and calibration tooling that runs every battery's fixtures.

**Everywhere it fits.** Every decision point and workflow step is a candidate:
- **While porting:** each decision point is given its disposition (Jev, compound, or plain code) at the moment it is read.
- **After each part:** once a part closes, it is audited again for further places the foundation applies, and those are implemented before the next part starts.

**Rules for judgment:**
- **No fallbacks.** The judgment port is required everywhere, and no site keeps the old heuristic as a backup. Outage handling is the model provider failover chain.
- **No vendor names.** Routing and tier rules describe the work, never a vendor or model. The route planner picks from the whole catalog of providers and models, with failover.
- **Local option.** A configurable setting points the platform at a local System One model instead of the hosted Jev key, with the same wire protocol.
- **Deterministic boundaries stay code.** Security checks, money arithmetic and fixed formats are never judged.

## Replacing WRFC: the contract runner

The old write, review, fix, check loop, the WRFC controller, workstreams and attempt judging are replaced by quantized work that is judged as it happens:

1. The planning model sets a goal and acceptance criteria for the whole task.
2. It breaks the work into groups and units, each with its own goal and criteria. Units go as small as the task needs.
3. Jev judges each unit against its criteria the moment it is done, so problems are corrected mid-stream.
4. Each group is judged when its units complete, and the whole deliverable is judged at the end.

Correctness emerges from the structure: when every part below is right, the part above is likely right, and Jev still confirms the top. Small units let cheap models from any provider do most of the work under a stronger planner. The runner works as a CLI and as the daemon's hosted-session host. The fleet and workstream views in the products become views of the contract tree.

## The engine (`packages/engine`, from `goodvibes-sdk`)

### Platform subsystems

| Subsystem | What it does | Disposition and Jev use |
|---|---|---|
| types, errors, utils, node | Shared types, error kinds, logging, async helpers, runtime detection | PORT |
| state | SQLite and KV stores, file cache, undo log, watcher, vector store, project index, telemetry recorder | PORT; gains the decision-log store |
| config | Config manager, secrets, secret refs, service registry, API keys, subscription auth, OAuth listener, schema domains, migrations | PORT |
| presentation | Glyphs, tone tokens and waiting-state wording shared by TUI and agent | PORT |
| security | Input sanitization, CSP, private-host policy, content taint, untrusted-content framing, link validation | PORT; deterministic, never judged |
| providers | Provider registry, adapters, stop-reason mapping, optimizer, cache planner | PORT; hoists provider classification, fallback, health, and model comparison and routing |
| routing (new) | Classifies each request to a tier and handler before tokens are spent | JEV: tier, intent, difficulty, risk, domain and language batteries; dispatch for closed-set commands; hoists the agent route planner and the TUI error classifier |
| profiles, templates | Named config profiles; agent archetypes | PORT |
| batch | Daemon batch queue and provider batch adapters | PORT |
| gate (replaces permissions) | One path for every side effect: a deterministic boundary, then graduated autonomy | JEV: the boundary stays code (catastrophic-command list, surface authority, card-shape scanner, outward-effect checks, trust-gated approvals); side-effect, risk-family and sandbox-advisory batteries; permission modes become presets over a stakes table; hoists TUI policy dispatch and permission runtimes, and the agent's tool policy, exec posture, execution ledger and operator policy |
| tools | Built-in tools, the per-session tool list, the exec AST guard | PORT; exec risk classification moves to the gate |
| control plane | Gateway, approval broker, message relay | JEV: approval and proposal replies read with the reply pattern |
| core | Orchestrator loop, conversation manager, tool registry, compaction, intent classifier, planner, decomposition | JEV: the loop becomes the contract runner; intent is a choice; planner risk is a score; compaction keeps a fidelity check |
| agents, orchestration | Sub-agents, WRFC controller, workstreams, attempt judging, budgets | DROP: replaced by the contract runner, with best-of-N as candidate selection |
| hosted sessions | A conversation loop inside the daemon | JEV: becomes the contract runner's daemon host |
| sessions, bookmarks, rewind, export, artifacts | Persistence, save points, rewind, exporters, blobs | PORT; sessions gain the contract tree |
| runtime | Store, event bus, compaction strategies, session memory, diagnostics, perf | PORT; compaction quality uses the fidelity pattern |
| hooks, workflow, triggers, watchers | Lifecycle hooks, trigger executor, stream watchers, process triggers | PORT; model-free by design |
| skills | Skill documents, progressive disclosure, CRUD | JEV: relevance by rerank; hoists the agent skill registry, discovery, standard, draft proposer and runner; drafts screened by policy checklist |
| discovery, mcp, plugins, acp | Workspace and MCP scanning, MCP client, plugin loader, agent control protocol | PORT; hoists the agent capability index, probes, snapshot and sources |
| intelligence, git, workspace | Tree-sitter and LSP facade, git service, worktrees | PORT |
| channels, adapters, channel profiles, channel sync | Surface registry, delivery router, adapters, profile bindings, mirrors | PORT; hoists the daemon routing resolver, route store and drafts, and the agent's channel delivery, drafts and profile routing |
| intake (new) | Classifies everything that enters before it reaches a session | JEV: provenance, hostility, intent-to-handler, urgency and action, and entity batteries; hoists the daemon triage scorer, pipeline and tagger, the inbox aggregator, poller, cursor store, mapping and adapters, and the agent's unified inbox |
| email, google | IMAP and SMTP; Gmail and Calendar | PORT; inbound mail flows through intake |
| principals | Channel identity to a named principal | JEV: cross-channel identity merge by entity alignment; hoists the agent principal attribution |
| companion, push, pairing, relay, remote access | Companion routes, browser push, device pairing, relay and step-up, Tailscale serve | PORT; hoists the daemon remote backends, dispatcher, peer registry and service |
| cluster | LAN leader election per surface | PORT; hoists the daemon ws call and raw reply route |
| knowledge | Ingestion, query, projections, consolidation, source and fact quality, enrichment, answer synthesis, Home Graph triage | JEV: gated writes; rerank and existence check on retrieval; quality scored on a specificity rubric; enrichment verified per field; triage as a choice; duplicates by entity alignment; pairwise contradiction detection; hoists the agent learning curator, consolidation, memory prompt, and the note, document, research-run and research-source registries, plus TUI recall and the consolidation gateway |
| owner profile, personal capture | The owner read model and capture authority | PORT; the write gate stays code; hoists the agent owner-profile gateway |
| occasions | Dated facts the daemon raises on its own | JEV: solemn or celebratory as a gated choice; hoists the agent occasions gateway and nudge |
| calendar | iCalendar reader and subscriptions | PORT; hoists the agent calendar modules |
| automation, scheduler | Jobs, runs, missed runs, cron | PORT, plus a JEV reading of failure transience before retry, cooldown or dead-letter; hoists the agent autonomy, reminder and routine schedules and TUI schedule parsing |
| check-in | Proactive contact on a cadence | JEV: a worth-interrupting battery; silence stays the default |
| payments | Decision order, budget pools, approval and veto windows, taint gate, merchant judge, entry surface | JEV: arithmetic and taint stay code; merchant qualification, recourse category, and approval and veto reply readings; hoists the daemon payment stores, checkout, journal, ledger, notifier and merchant judge, the TUI and agent card intake, and the agent channel card guard |
| CI watch, power | CI watching with per-job verdicts; sleep ownership and keep-awake | PORT |
| voice, multimodal, media | TTS, STT, realtime voice, image encoding, media providers | PORT; transcripts flow through intake and the gate; hoists agent media generation |
| browser, devices | Playwright browser capability; paired-device tools | PORT; outward effects through the gate |
| web search | Search provider registry | PORT; results reranked where a session asks for the best source |
| cloudflare, integrations | Cloudflare control plane; third-party connectors | PORT; hoists the TUI Cloudflare runtime |
| daemon server | HTTP bootstrap, router, policy, route groups, updater, receipts | PORT; gains plan, dispatch, status, override and receipt verbs |
| embed | Hosting a session inside another app | PORT, over the contract runner |
| observe (new) | Judgment analytics over the decision log, threshold tuning, calibration, drift, question discovery, semantic CI lints | JEV; hoists the TUI eval registry and cost tracking |

### Packages outside the platform layer

All of these are PORT unless marked otherwise:
- **Published entry points:** auth, browser, browser-agent, browser-knowledge, browser-scoped, client, companion-realtime, contracts, contracts-node, daemon, embed, errors, index, operator, peer, the transports, web and workers. The browser-homeassistant, expo and react-native entry points are DROP.
- **Client auth:** token store, auto-refresh and its middleware, control-plane auth snapshot, OAuth types, permission resolver and session manager. The mobile token stores are DROP.
- **Events:** every typed event domain. The orchestration, planner and permissions domains become contract, gate and judgment domains.
- **Contracts:** all 507 old methods, each with its request and response schemas. The peer contract comes across, along with typed method maps (input, output and the method-id union) that the operator client, peer client and web UI are generated from.
- **Daemon routes (from daemon-sdk):** every old route family, served with writes gated:
  - calendar, email, occasions, check-in and tasks, CI watches, permission rules;
  - fleet, models and cost, owner profile, payment cards;
  - pairing and step-up, power, principals and channel profiles, push;
  - session controls, voice wake and local voice;
  - knowledge packets and candidates, devices activity;
  - the judgment proxy the browser uses, and telemetry.
- **The relay:** registration client, relay server and server entry.
- **Error contract, operator and peer clients, observer, toolchain and transports** (core, HTTP and realtime).
- **The terminal shell,** the renderer core shared by the TUI and agent: ANSI sanitizing, the bookmark modal, bottom bar, CLI catalog, parser, completion and help, feature settings, network posture, cluster commands, conversation fold, history and tree, the layout engine, overlay viewport, render scheduler, terminal caps, lifecycle and output guard, text layout, text selection, transcript layout, and the transcript history buffer.

## The daemon (`products/daemon`, from `goodvibes-daemon`)

**PORT.** Carried over as they were:
- **CLI:** the command catalog, completion, help, parser and surface catalog.
- **Send:** the pairing banner and the send command.
- **Handler registration:** handler context, contracts, errors, registration and the SQLite store.
- **Runtime composition:** boot tasks, the browser checkout seam, cluster and cluster-group composition, the conversation rewind port, and credential, handler and device-posture composition. Also disposal wiring, fleet services and needs-input push, hosted-session composition, knowledge services, mail composition, notification dispatch, payments and plugin composition, services, trigger services, update check, workspace checkpointing, and version.

**HOIST into the engine.** Credentials, drafts, the inbox, payments, remote execution, routing, triage, cluster call plumbing, and the trust-gated approvals.

**JEV.** The merchant judge and notifier (merchant qualification and reply reading) and the triage scorer, which becomes the intake battery.

**DROP.** The legacy daemon migration and reconcile.

The composed daemon serves every route group:
- cluster, companion chat, MCP, models, planning, batch, Cloudflare, OpenAI-compatible;
- the surface registry (Telegram, ntfy, socket, inbound mail), channel health and triggers;
- the inbound intake pipeline (IMAP, Gmail, Slack and Discord sources, profile routing, inbox and routing routes);
- drafts with encrypted bodies, triage write-back as gated effects, remote execution, hosted-session trust and the idle reaper;
- self-update, `--provider` and `--model` at serve, the webhook listener, and payments on a real merchant through a browser checkout.

The state root and on-disk layout stay as the old daemon has them.

## The TUI (`products/tui`, from `goodvibes-tui`)

The full terminal UI carries over and looks and behaves as it does today.

**PORT.**
- **Entry and basics:** main, CLI flags, version, config, utils, scripts, the widget, the renderer (including onboarding), onboarding input, the gist uploader and MCP runtime reload.
- **Audio:** activation sound, capture, player, spoken-turn routing and wiring, voice capture, the voice input session, wake inference and wake runtime. Wake auto-submit consults an advisory gate battery.
- **CLI commands:** bundle, completions, doctor, gitignore setup, hooks and hooks report, auto-update, management, network posture, package verification, plugin bundles and plugins, provider auth routes, service and service posture, status, surface, and TUI startup.
- **Core:** the whole conversation model and its notifiers. That covers composer state, conversation, fold, line cache, render context, rendering, search expansion, splash state, turn structure, user receipts, the event navigation and bookmark navigation, compaction receipt and render, context usage, and model identity and routing chip. It also covers the approval, budget-breach and long-task notifiers, memory diagnostics and provenance, the pairing Tailscale gateway, the power chip and status, the rewind receipt, the scriptable statusline, session resume, stream wiring and stall watchdog, system message noise and routing, the terminal notifier, turn budget and cancellation, and voice and wake provisioning and status. Workstream notification becomes contract-tree notification.
- **Shell:** blocking input, recovery input helpers, the retry affordance, service settings sync, UI openers, voice capture shell.
- **Verification:** the live verifier and the verification ledger.
- **Panels:** every panel and its base classes, plus the builtin agent, development, knowledge, operations, session and shared panels:
  - the panel manager, base, expandable and scrollable list panels, confirm overlay, modals, polish and search focus;
  - agent inspector, cost tracker, token budget, diff and diff review, git, hosted sessions, local auth, notifications, plugins, session maintenance and skills.
  - The fleet panels become the contract-tree views.
- **Permissions:** the approval card, hunk selection, prompt and sandbox exec gate, as views over the engine gate. Also the reasoning-effort surface.
- **Runtime:** bootstrap and all its parts, client, context, daemon attach notices, diagnostics, disposal, install self-check, interaction seams, onboarding, path shadow, perf, keep-awake, process lifecycle, recovery (autosave, decisions, offer, prompt), relay reachability, release artifacts, resume notice, services, session ambience, continuity, inbound inputs, resume liveness, the store, UI read models, UI services and update check.
- **Input:** the input handler and its routes, keybindings, history, command registry, autocomplete, file picker, concealed input, paste guard, the kill ring (with yank-pop and word motions), selection and picker modals, the settings modal and transcript search.
- **Command runtimes:** all of them, as wrappers over engine verbs:
  - acp, branch, calendar, channel pairing, channel, check-in, checkpoint, CI, Cloudflare, cluster, config, connection status, context window, control room, conversation;
  - cost and cost attribution, devices, diff, discovery, editor, eval, experience, git, graph, guidance, health and health metrics, hooks, hosted, image, incident, intelligence;
  - knowledge, local auth, local provider, local, local setup (review and transfer), mail, managed, marketplace, MCP, memory and memory product, notify, onboarding;
  - operator panel, RPC and runtime, palette, platform access, platform, platform sandbox, platform services, plugin, power, principals, product, profile (render, runtime, sync, types), provider, provider accounts;
  - QR code, queue, quit, relay, remote (pool, setup), replay, rewind, runtime services, schedule, secret, services, session (content, picker filter, workflow), settings sync, share, shell core, skills;
  - subscription, tasks, teamwork, teleport, test, TTS, update, web search, worktree.

**HOIST.**
- To engine providers: provider classification, provider fallback, provider health.
- To engine routing, as a JEV classify reading: the user error formatter.
- To engine generation: the session auto-titler.
- To the engine gate and contract runner: sandbox gaps and orchestrator services.
- To engine knowledge: memory governance, knowledge services, the consolidation gateway, and the recall commands.
- To engine state, transports, Cloudflare and channels: workspace checkpointing, the memory and session spine transports, the Cloudflare control plane, and notification dispatch.
- To the engine scheduler, as a JEV date-parts reading: natural-language schedule parsing.
- To the engine gate: policy, policy dispatch and the permissions runtimes. The TUI keeps the cards.
- To engine payments: payment card intake.
- To engine observe: the eval registry.
- To the contract runner, as a JEV yes/no reading: project planning answer actions.

**DROP.**
- **Permission mode:** replaced by the gate presets.
- **The WRFC agent guard, WRFC panel format and WRFC persistence:** replaced by the contract runner.
- **The legacy daemon migration and reconcile.**
- **QEMU sandbox templates and the QEMU sandbox runtime.**
- **The planning, work-plan, workstream, review and codebase runtimes:** replaced by the contract-runner verbs and views.

**Packaging.** `bin/goodvibes`, the launcher support, the platform packages, and the install, postinstall and Bun check scripts. Themes carry over too: the dark and light palettes and background detection.

## The agent (`products/agent`, from `goodvibes-agent`)

The full agent product carries over and looks and behaves as it does today.

**PORT.**
- **Entry and renderer:** main, CLI flags, version, provider auth route display, utils and the full renderer (theme, escapes, status glyphs, primitives, layout, progress, thinking, compositor, conversation surface, overlays, markdown, code blocks, tool calls, diffs and modals).
- **Core:** activity feed, away digest, bookmark navigation, composer state, conversation, fold, message snapshot, render context, rendering, turn structure, hardware profile, last-seen store, plain language, setup-incomplete hint, system message noise and routing, thinking overlay, and voice and wake status.
- **Audio:** activation sound, capture, input devices, player, spoken-turn routing and wiring, voice capture, wake inference, wake runtime, and the wake surface.
- **CLI:**
  - knowledge (args, command, format, methods, runtime), browser, bundle, channel profiles, CI, completion, config overrides, connected host metrics, endpoints, entrypoint, external runtime;
  - fleet, help, import, auto-update, local library, management, memory, OpenClaw import, operator args, owner profile, package verification, parser;
  - personas, principals, profiles, provider auth routes, redaction, relay, resume notice, routines, run turn, service posture, skill bundles, skills, status, temporal label, TUI startup and workspaces.
- **Config:** settings policy, checkpoint settings, connected host dial, credential scope and status, daemon config and credential routing, payments money format, provider model, secrets, settings search, surface, update settings, the wake enablement companion, and workspace registration. The two migration modules are DROP.
- **Permissions:** approval posture, broker approval and prompt, as views over the gate. Also the reasoning-effort surface.
- **Shell:** workspace fullscreen, approvals panel, autonomy surfacing, blocking input, command context UI, daemon repair prompt, first render follow-ups, hosted turn activity, remote conversation wiring, service settings sync, continuity hints, startup wiring, terminal focus, paint window and size, transcript navigation, UI openers and voice capture shell.
- **Verification:** live verifier, settings behaviour coverage, consumed keys, and the verification ledger with its surfaces.
- **Runtime:**
  - bootstrap and all its parts (agent tools, capability wiring, command context, core, external services, Google tool, hook bridge, shell, shutdown);
  - browser driver profile, calendar boot refresh, client and build compatibility, connected host auth, context, conversation rewind port;
  - daemon build compatibility, CLI service, receipts and repair, diagnostics, feature enablement, LAN scan consent, MCP lazy start and suggestion scan, occasions boot and nudge surface, onboarding;
  - operator token cleanup, path shadow, periodic update, process fault capture, provider account snapshot, provider boot, release artifacts, rewind anchors, self-update receipt, services, store, tar archive, UI read models and services, the unhandled rejection guard and update check;
  - the agent browser, conversational capture, conversation sender and runtime events.
- **The agent surface:** operator actions, contract routes, gateway call and daemon operator client, harness control and mutation format, the assistant cockpit, prompt context receipts and journal, project context files, runtime profile and starters, the setup wizard with its receipts and checkpoint, and signup. The vibe file and vibe confirmation routes also carry over; they are screened by the engine policy checklist, which is a JEV use.
- **The product tools:** every harness tool over engine verbs. That covers metadata, text, schema, catalog filters and search, connected host setup, setup describe, handoffs, plan, posture and smoke, and local model benchmarks, cookbook, endpoints, smoke and URL. It also covers local operations and registry, connected host capabilities and status, remote and remote read models, pairing and service posture, session metadata, settings catalog, prompt context, mode catalog, keybinding metadata, interactive runtime records, UI surface metadata, release evidence and readiness, and operator methods and vocabulary. The rest are the operator method, action and briefing tools, vibe health and vibe tool, and the profile, settings, settings import, sessions, session write ledger, setup, support, audit, capability, host, context and inventory disclosure tools.
- **Input:** the handler and its routes, keybindings, history, command registry, autocomplete, file picker, paste guard, settings modal, transcript search and the roughly 90 agent-workspace files. The workspace's review-packet, work-plan and delegation editors submit contract-runner verbs.
- **Command runtimes:**
  - local library, runtime profile, skills, workspace, brief, calendar connect, calendar, calendar subscriptions, channels, command errors, compat, config, confirmation, connected host admin, conversation, delegation, email;
  - experience, Google connection and runtime, guidance, health, knowledge (flags, format), local provider, local, local setup review, MCP, memory, network scan, notify, onboarding, operator actions;
  - operator, owner profile, personas, platform access, product, provider accounts, QR code, routines, runtime services, schedule, security, session (content, workflow), shell core, subscription, support bundle, tasks, TTS, update and vibe.

**HOIST into the engine.** Where marked JEV, the move also brings a Jev reading:
- **Provider classification.** The exec posture, operator policy, execution ledger and tool permission safety go to the gate and contract runner.
- **The spine transports and memory usage wiring.**
- **The trust modules:** outward approvals, untrusted content, surface authority, memory safety and the payments channel guard. These stay deterministic.
- **Capabilities:** builtin capabilities, boot check, index, probes, snapshot, sources, known service evidence, the capability registry and summary.
- **Skills** (JEV, with drafts screened by policy checklist).
- **The persona, routine, note, document, research-run and research-source registries** (JEV, with research-source credibility scored).
- **Memory:** memory consolidation proposals, the memory prompt, the behaviour discovery summary and the competitive feature inventory.
- **Calendar and scheduling modules;** the occasions and owner profile gateways.
- **Channels and intake:** principal attribution, channel delivery, drafts, profile routing and the unified inbox. Also media generation.
- **The route planner and route tool** (JEV: a choice over routes with yes/no pre-checks replaces the keyword ladder).
- **The learning curator and consolidation** (JEV: proposal targets and memory classes as choices, usefulness as a score, duplicates by entity alignment).
- **The autonomy intake, queue and watchers, and the schedule and reminder tools** (JEV: date-parts extraction).
- **The tool policy guard and every policy and posture tool,** to the gate.
- **Model comparison, catalog, readiness, routing and provider health.** Model comparison judgment is JEV, with candidate selection replacing the prompt-and-parse judge.
- **The memory, knowledge, research and document tools.** The document reviewer readiness is a JEV verification reading.
- **The personal ops harness, Google and accounts tools** (JEV: lane classification is a choice).
- **The occasions, channels, notify and comms tools.**
- **The execution, process, command, file recovery, computer, browser, device, media, MCP and artifacts tools.** Every side effect goes through the gate.
- **The recall commands and payment card intake.**

**DROP.** The delegation, agent orchestration, work plan, workspace action and editor runners, the workspace tool and the review packet tools. The contract runner replaces them.

**Release.** Verification, scripts, bin, the release files (release notes, performance snapshot, readiness, live verification) and the docs.

## The web UI (`products/webui`, from `goodvibes-webui`)

The full web UI carries over with the same look, and the whole of it is PORT except the items marked DROP below.

- **Page shell and assets:**
  - `index.html` with its icons and manifest links, and `public/` (favicons, app icons, manifest), plus the wasm assets;
  - every CSS file verbatim (tokens, styles, skeleton, component styles, the font import);
  - the service worker with its cache rules, and the build gates for cache-busting, internal identifiers and typecheck coverage.
- **Views:**
  - admin, chat and every chat part, knowledge, providers;
  - approvals (including permission rules), calendar, check-in, checkpoints, CI, dates, fleet (including attempt comparison), knowledge candidates, jobs, map and packet;
  - mail, memory and every memory part, phone, principals;
  - sessions (hosted sessions, hunk action, comment and revert sheets, changes, rewind, steer composer);
  - the workstream view, which becomes the contract-tree view.
- **Components:**
  - accounts, credential status, data blocks, markdown messages, record lists, status badges;
  - the auth gates and step-up host, the command palette and shortcut cheat sheet, confirm sheets, the diff multibuffer, feedback states and onboarding;
  - fleet node tells and task graph, modal, the model workspace, motion, pairing (handoff offers, posture notice, QR scanner), peek panel, pricing;
  - every settings panel, the app shell, the status strip parts, toasts, and the voice controls (mic, speak, voice settings, wake banner, chip, indicator and wake word settings).
- **Hooks:** every one.
- **Library modules:** every one, with `lib/generated` regenerated from the engine contracts.
- **Scripts:** bundle packing and the live daemon smoke test.

**DROP.** The permission mode sheet and `lib/permission-mode`, replaced by the gate presets sheet.

## Failover settings

The failover feature already specified for goodvibes carries over:
- **Tiers:** free, subscription and API, defaulting to today's any-to-free behaviour.
- **Failover paths:** API to API, subscription to subscription, API to subscription and subscription to API, each with its own toggle.
- **Preference ranking:** defaults to free, then subscription, then API.
- **Targets:** a specific provider or model, a synthetic model, a specific subscription, or best available (from models.dev data cross-checked against available accounts).
- **Synthetic models:** keep their own failover until they are exhausted.
- **Local models:** count as free, fail over to local, and never fail over mid-reasoning.
- **The `/failover` command** opens the settings menu at the failover category, with clear, low-friction instructions.

## Quality bar and working rules

**Quality:**
- **Supercov** is used as a review tool on the code, never built into the product, and every finding is fixed.
- **No leftovers:** nothing is deferred or left for a later round, and fixes land in the pass that finds them.
- **No dead tooling:** tests and scripts must earn their place; nothing is added that nothing uses.

**Working rules:**
- Commit continually, authored as Mike Davis, with no attribution trailers.
- Answer questions immediately and plainly.
- Pause at once when asked; a resume scheduled for a set time is not a deferral.
- Run heavy work in the background.
- Do not ask for rulings that the sources or standing rules already answer.
- No em dashes in any prose.

## What "done" means

A product is done only when all four of these hold:

1. **Every module in its old repo is accounted for.** It is ported, rewritten with Jev at its decision points, hoisted into the engine, or dropped as listed above.
2. **It matches the old product when run side by side:** the same screens, commands, styles and behaviour.
3. **Jev readings replace the guesswork** at every decision point, with no fallbacks.
4. **The whole tree passes its gates:** all type-checks, a runnable proof for each area, the pattern audit, and supercov with zero findings.
