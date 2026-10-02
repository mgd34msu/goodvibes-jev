# Harness Pay-Its-Way Design Review (W4-H1)

> **REVISION NOTE (same day):** the prior revision of this document misstated the
> surface doctrine it was ruling under — it said the "scrap 99%" directive targets
> "observability chrome," which is inverted. The actual doctrine: the old DOMAIN
> panels' chrome gets scrapped so panels can **become** the live agent/process
> observability layer (observability is the *future* of panels, not what gets
> scrapped), and configuration surfaces move to **modals**. Every classification below
> has been re-checked file-class by file-class against the correctly-stated doctrine;
> the classifications that changed as a result are called out explicitly in the
> "observability-shaped subset" row of the verdict table and in the conclusion.

Investigation-only ruling. No code changed. Repo: goodvibes-agent main @ c5fa750c.
Honors WO-0D's finding (2026-07-04, agent main): the ~44-candidate "rot" premise was
refuted — all candidates are product read-models over SDK surfaces, presentation
deliberately consumer-owned, 0 deletions was the correct outcome. This review does
**not** revisit that question. It asks a different one: through the observability-layer
lens (panels/surfaces should earn their footprint as live process/config affordances,
not as scaffolding that thinks for a human or a model that no longer needs it), does the
agent-workspace-* scaffolding and the three over-cap exemption files still pay their way
today, and what (if anything) should a follow-on wave do about it.

## Grounding correction (reality wins over the brief's cited counts)

The brief cites "83 files, 17,847 lines (81 in src/input, 2 in src/renderer)." Live
recount as of this investigation:

- `find src/input src/renderer -iname '*agent-workspace*' -type f` → **86 files, 19,414
  lines** (83 in `src/input`, 3 in `src/renderer`: `agent-workspace.ts`,
  `agent-workspace-context-lines.ts`, `agent-workspace-style.ts`).
- The delta (roughly +3 files, +1,567 lines since the brief's snapshot) is consistent
  with same-day churn on `agent main` (multiple commits landed today, including the
  W3-A1 session-spine REST adapter work touching `runtime/services.ts`). Not a
  discrepancy worth chasing further — the top files the brief names
  (`agent-workspace-types.ts` 766, `-basic-command-editors.ts` 697, `-settings.ts` 678,
  `-snapshot.ts` 651, `renderer/agent-workspace-context-lines.ts` 627) all matched
  exactly on re-verification.
- The three exemption line counts matched exactly: `package-verification.ts` 3718,
  `local-library-command.ts` 825. `runtime/services.ts` is now **1005** lines, up from
  the 966 recorded at WO-0D (2026-07-04) — it grew ~39 lines in the last day as part of
  active session-spine work, confirming it's a live, actively-touched file, not a
  frozen legacy blob.
- `bun scripts/check-architecture.ts` run read-only: **passes clean** (615 non-test
  source files, 0 violations) — the exemption Set is doing its job; there is no silent
  gate failure hiding here.

## The observability-layer lens, applied honestly

The TUI's observability-layer vision (memory: `observability-layer-vision.md`) has an
explicit **surface doctrine**: "modals become a configuration surface (which they
mostly are now) and panels are an observability surface" — sort by updates-while-you-
watch (→ panel: the observability layer) vs open-change-close (→ modal: configuration)
vs look-something-up (→ overlay/transcript). The "scrap 99%" directive targets the old
**domain-panel chrome** (panels organized around domain nouns — git, tokens,
marketplace, ...) so that panels can be **rebuilt as the live agent/process
observability layer**: session tabs (detach ≠ kill), a hierarchy tree with per-agent
tokens/tool-calls/recent-output, in-panel steering. Observability is the *future* of
panels, not what gets scrapped. The scrapped domain panels' DATA SOURCES survive as
APIs consumed by the model and the fleet view; configuration/browsing surfaces are
kept and relocated to modals. The correct sorting question for each file here is
therefore: is its content configuration-shaped (belongs in a modal — fine as an editor
today) or observability-shaped (live process/agent state — under the doctrine that
content belongs to the observability-layer direction, not a domain admin console)?

Sampling the agent-workspace-* scaffolding against that doctrine (representative reads:
`agent-workspace-task-command-editors.ts`, `-task-command-editor-submission.ts`,
`agent-workspace-basic-command-editors.ts`, `-snapshot.ts`, `-categories.ts`,
`-settings.ts`, `-channels.ts`, `agent-workspace.ts`) shows every editor file follows
one shape: a declarative field-spec factory (`{title, message, fields: [{id, label,
value, required, multiline, hint}]}`) plus a submission step that reads the filled
fields and builds a slash-command string handed to the shell-owned command router
(`quoteSlashCommandArg(...)`, `kind: 'dispatch'`). That is **configuration-shaped**
(open-change-close → modal home under the doctrine) — it is the stepped-form
equivalent of typing a slash command by hand, with validation and correct quoting. It
does not duplicate anything the live process/fleet tree would show, so the
observability-layer direction does not claim it.

Cross-checked against the model's own capability surface: `src/tools/` already exposes
`agent-memory-tool.ts`, `agent-knowledge-tool.ts`, `agent-channels-tool.ts`,
`agent-channel-send-tool.ts`, `agent-research-*-tool.ts` etc. — the model calls these
domains **directly**, entirely bypassing the agent-workspace-* editor scaffolding. That
confirms the workspace editors are a **human-only admin console**, not "scaffolding
that thinks for the model" (the harness-evolution-thesis critique targets the latter —
orchestration/memory/interface built for a model that couldn't think for itself; it
does not indict a human configuration UI that the model never touches).

**Conclusion (revised after the doctrine correction): the configuration-shaped
majority stands, but an observability-shaped subset changes classification.** The
editor/submission/wizard/browse scaffolding is configuration-shaped and correctly so —
its KEEP/CONSOLIDATE verdicts stand under the correctly-stated premise (it belongs to
the modal/configuration future, and WO-0D already confirmed it is real product surface,
not rot). However, re-checking every file class against the *correct* doctrine surfaced
a subset whose content is live process/agent state — updates-while-you-watch — which
under the doctrine belongs to the observability-layer direction, not a domain admin
console. A silent KEEP-as-admin-console verdict for these would be wrong; they are
**FLAGGED for the observability-layer ruling** (Wave-4/5) instead:

- `agent-workspace-context-snapshot.ts` — two of its six builders are
  observability-shaped: `buildProcessSupervisionSummary` (:315-349: live
  tracked/running/completed process counts from `processManager.list()/getStatus()`,
  with routes pointing at `process-monitor` and `live-tail` surfaces — this *is* the
  process half of "observability everywhere") and `buildPromptContextReceiptTimeline`
  (:216: a live timeline of agent prompt-context decisions — the same family as the
  doctrine's "approval history becomes fleet-tree drill-down"). The other builders
  (vibe/project-context/research-contract summaries) are look-something-up
  read-models, not affected.
- `agent-workspace-channel-triage.ts` (481 lines) — live delivery attempts, inbound
  feed, receipts, per-route readiness. Updates-while-you-watch delivery/process state;
  observability-shaped.
- `agent-workspace-snapshot.ts` (the runtime counters: memory count, routine starts,
  rendered in the workspace header) — live state display; its *staleness* is already
  routed to W4-A6 (live disk-mirror fix), and additionally its *surface home* is
  observability-shaped under the doctrine.
- `renderer/agent-workspace-context-lines.ts` — the assistant-cockpit lane/status
  rendering (`buildAssistantCockpitFromWorkspaceSnapshot`, lane states
  ready/attention/setup, live process-supervision lines) is live-status chrome;
  observability-shaped. Its setup-checklist rendering is configuration-adjacent and
  unaffected.

The flag is a *direction* ruling, not a defect: the agent currently has no fleet/panel
observability layer at all (single sidebar; the sidebar-vs-fleet divergence is ratified
INTENTIONALLY-DIFFERENT in the W4-R1 matrix), so there is nowhere for this content to
move *today*. The ruling is that when the observability layer arrives (the One-Platform
direction), these four files' live-state content is claimed by it — they must not be
grandfathered into a consolidated admin-console redesign as if they were configuration.
Borderline call recorded honestly: `agent-workspace-voice-media.ts` reports provider
readiness states (`needs-secret` / `not-registered` / `ready`) — that is setup-state
reporting in service of configuration, not live process observability; it stays
configuration-shaped (KEEP).

## Per-cluster verdicts

| Cluster | Files (approx) | Verdict | Why |
|---|---|---|---|
| Editor+submission pairs (access, basic, channel, knowledge, library, media, memory, mcp/skill-bundle, operations, provider, session, task) | ~26 files | **CONSOLIDATE** (non-urgent) | Every pair follows the identical shape: a switch/if-chain returning `{title, message, fields}` literals, and a submission builder that reads fields → slash-command string. The domains' *field contents* genuinely differ (real product value, not spurious duplication), but the *structural pattern* is boilerplate that could become one generic schema-driven engine (a `Record<Kind, EditorSpec>` data table + one shared `createEditorFromSpec` / `buildSubmissionFromSpec`) instead of ~26 near-identical files. This is a DX/maintainability win, not a capability change — follow-on wave, not urgent. |
| Giant single-function assemblers: `agent-workspace-snapshot.ts` (`buildAgentWorkspaceRuntimeSnapshot`, ~540 of 651 lines), `agent-workspace-basic-command-editors.ts` (`createAgentWorkspaceBasicCommandEditor`, ~600 of 697 lines) | 2 files | **CONSOLIDATE** (non-urgent, both under the 800 cap) — `-snapshot.ts` additionally carries the observability flag below | Same "one big function assembling many cases" shape as the exempted `runtime/services.ts`. Splitting into cohesive sub-builders (per-domain snapshot builders merged by the top-level function; a data table for the basic-editor cases) would reduce single-function size without changing behavior. Not urgent — both are comfortably under cap today; flag for the same follow-on wave as the editor/submission consolidation since they'd likely be touched together. |
| **Observability-shaped subset (classification CHANGED under the corrected doctrine)**: `agent-workspace-context-snapshot.ts` (the `buildProcessSupervisionSummary` + `buildPromptContextReceiptTimeline` builders), `agent-workspace-channel-triage.ts`, `agent-workspace-snapshot.ts` (the live runtime counters), `renderer/agent-workspace-context-lines.ts` (the cockpit lane/status rendering) | 4 files (2 partially) | **FLAG FOR THE OBSERVABILITY-LAYER RULING** (Wave-4/5) — was silently KEEP in the prior revision | Live process/agent state (running-process counts, delivery attempts, receipt timelines, live status lanes) is updates-while-you-watch content: under the correctly-stated doctrine it belongs to the future observability layer (fleet tree / session tabs / drill-down), not a domain admin console. Nothing moves today (the agent has no observability layer yet; sidebar-vs-fleet is ratified intentionally-different in W4-R1) — but these files' live-state content is claimed by that direction and must not be folded into a configuration-console consolidation. |
| Data-table / registry files: `agent-workspace-categories.ts` (2 top-level declarations / 560 lines — the category+action menu), `agent-workspace-types.ts` (42 declarations / 766 lines — pure type catalog) | 2 files | **KEEP as-is** | These are legitimately data-shaped (a route/menu table and a type catalog). WO-0D already established line-count-alone is not the verdict; splitting a single coherent registry or type catalog for line-count reasons would fragment one authority into several without a functional or readability gain. |
| Renderer files: `agent-workspace.ts` (renderer, 736 lines), `agent-workspace-context-lines.ts` (627), `agent-workspace-style.ts` (34) | 3 files | **KEEP** (context-lines.ts's cockpit/status portion additionally carries the observability flag above) | Presentation for the workspace surface — per WO-0D, "presentation deliberately consumer-owned." No evidence of duplication with anything else in the codebase. |
| Domain-specific standalone logic (configuration/browse-shaped): `settings.ts`, `channels.ts`, `activation.ts`, `model-compare-*` (4 files), `review-packet-*` (2 files), `research-*-editor` (3 files), `subscription-editor.ts`, `onboarding-*` (4 files), `local-*` (4 files), `config-reader.ts`, `navigation.ts`, `search.ts`, `token.ts`, `learned-behavior.ts`, `artifact-*` (2 files), `voice-media.ts`, `host-category.ts`, `requirements.ts`, `category-actions.ts`, `command-editor.ts`, `editors.ts` (dispatcher), plus the non-observability builders of `context-snapshot.ts` — remainder of the ~86 after the observability subset above | ~51 files | **KEEP** | Sampled representatives (settings.ts: 34 top-level declarations — real per-setting read/derive/apply logic, not a spec table; channels.ts: 26 declarations — genuine channel-domain behavior; voice-media.ts: setup-state readiness reporting in service of configuration) are configuration- or browse-shaped, which under the corrected doctrine is kept (modal/overlay home); consistent with WO-0D's file-level classification. No mechanical or structural red flag distinct from the categories above. |
| `agent-workspace.ts` (input orchestrator, **797/800 lines**) | 1 file (subset of the above, called out separately) | **WATCH** | Not a violation today, but the closest file in the entire codebase to tripping the line-cap gate (3 lines of headroom). Recommend a follow-on wave proactively split or trim it before it forces an emergency exemption under time pressure. |

## Over-cap exemption ruling (`scripts/check-architecture.ts:9-13`)

| File | Lines | Verdict | Reasoning |
|---|---|---|---|
| `src/cli/package-verification.ts` | 3718 (4.6x cap) | **RATIFY** | 116 independent `verify*` functions (avg ~32 lines each) covering distinct release-facing checks: tarball contents, package-facing text, CLI help/slash-command catalog cross-checks, release-readiness/live-verification/performance-snapshot manifests, harness-mode/model-access policy. Already function-level modular internally — this is a data-heavy verification checklist/manifest, not a tangled monolith (matches WO-0D's own characterization). 52 commits, most recent yesterday (SDK 0.38.0 bump + gate wiring) — actively maintained, not abandoned. Splitting now would fragment a single release gate that must cross-reference its own sub-checks (e.g., the slash-command catalog check validates against the package-facing-text check) across module boundaries for cosmetic benefit, and risks merge churn exactly as Wave-6 release-train work is starting. Ratify; if it keeps growing, the natural future split is along its four visible clusters (`verifyRelease*` / `verifyPackageFacing*` / `verifyHarness*` / catalog-building helpers) — not urgent today. |
| `src/cli/local-library-command.ts` | 825 (1.03x cap, only 25 lines over) | **SHRINK** | Only 9 commits total, last touched 2026-06-03 (a month stable — low risk to refactor now, unlike the other two which are mid-flight). The file cleanly contains three independent command handlers (`handlePersonasCommand`, `handleSkillBundleCommand`, `handleSkillsCommand`) each with their own render/summarize helpers, plus a small shared option-parsing prelude. This is the textbook "three domains glued into one file" case explicitly named in the over-cap-files scope item. Recommend: split into `personas-command.ts`, `skills-command.ts`, `skill-bundle-command.ts` sharing a `local-library-command-shared.ts` (option parsing, `jsonOrText`/`success`/`failure` helpers, registry accessors). Each resulting file lands comfortably under 300 lines. This is the one exemption where shrinking now is both cheap and low-risk — recommend a follow-on wave item, not permanent grandfathering. |
| `src/runtime/services.ts` | 1005 (1.26x cap) | **RATIFY-WITH-WATCH** | `createRuntimeServices` (lines 495-1005, ~510 lines) is the runtime's dependency-injection composition root: it wires ~30 services (keybindings, route bindings, secrets, channels, memory, providers, worktree registries, etc.) in a required construction order. This is inherent DI-wiring code — splitting it into arbitrarily-drawn helper functions typically just adds indirection without reducing real complexity, since the function's entire job is "assemble everything correctly." It is under active development (30 commits; grew 966→1005 lines in the single day since WO-0D, as part of today's W3-A1 session-spine REST adapter work) — splitting it *now*, mid-feature, would collide with live work rather than settle it. Ratify today, but record a **shrink-trigger**: if the file crosses ~1200 lines, mandate splitting into phase-based sub-factories (e.g. `createCoreRuntimeServices` / `createChannelRuntimeServices` / `createMemoryRuntimeServices`, each returning a partial slice merged by `createRuntimeServices`) rather than growing the exemption Set's headroom indefinitely. |

## Follow-on wave plan (recommended, not executed here)

None of this is urgent — nothing here is a defect, a silent gate failure, or dead code.
If/when a future wave takes it up, in priority order:

1. **`local-library-command.ts` split** (cheap, stable, obvious seams) — the one item
   worth doing opportunistically even outside a dedicated wave.
2. **Editor+submission consolidation** (~26 files) — design one generic
   `EditorSpec`-driven engine, migrate domains incrementally; biggest line-count win,
   lowest behavioral risk since the field data doesn't change, only where it lives.
3. **`agent-workspace.ts` (797/800)** — split or trim before it forces an emergency
   exemption.
4. **`runtime/services.ts` shrink-trigger** — watch only; act if/when it crosses ~1200
   lines or W3/W4 spine work settles enough to refactor safely.
5. **`agent-workspace-snapshot.ts` / `-basic-command-editors.ts` big-function split** —
   bundle with #2 since they share the same "giant function → data table" shape.
6. **Observability-shaped subset ruling** (`context-snapshot.ts` process-supervision +
   receipt-timeline builders, `channel-triage.ts`, `-snapshot.ts` live counters,
   `renderer/agent-workspace-context-lines.ts` cockpit/status rendering) — when the
   observability layer lands on the agent (One-Platform direction), these four files'
   live-state content moves to it (fleet tree / drill-down), and any editor
   consolidation (#2) must exclude them rather than absorb them as configuration.
   Needs an explicit Wave-4/5 ruling before any consolidation touches them.

## WO-0D honored

This ruling does not re-open or contradict WO-0D's finding (0 deletions correct, all
candidates are product read-models over SDK surfaces). It layers a distinct, narrower
judgment on top: which of those legitimate files should additionally be *reshaped*
(consolidated/split) for maintainability, versus left alone. No deletions are
recommended anywhere in this document.

---
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017dUjUuzaHwTcMjMvkbs2wB
