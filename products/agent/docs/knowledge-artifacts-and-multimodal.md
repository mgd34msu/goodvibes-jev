# Knowledge, artifacts, and multimodal

GoodVibes Agent has its own Knowledge segment. It must not query or ingest through default knowledge or other product-specific knowledge spaces.

## Context layers

GoodVibes Agent uses these context layers:

- current conversation context for the active turn;
- Agent-local memory records for durable but private assistant facts and preferences;
- VIBE.md personality files, project context files, plus Agent-local routines, skills, and personas for reusable behavior profiles;
- isolated Agent Knowledge for source-backed documents, search, and semantic answers;
- artifacts for uploaded/generated files that can be referenced by chat, delegation, or explicit Agent Knowledge ingestion.

These layers are intentionally separate. VIBE.md, project context files, local memory/routines/skills/personas, and default knowledge are not automatically promoted into Agent Knowledge. Agent Knowledge records are not copied into default knowledge. Secrets are rejected or represented only by explicit secret references.

## Agent Knowledge boundary

Agent Knowledge uses only the Agent route family:

```text
GET  /api/goodvibes-agent/knowledge/status
POST /api/goodvibes-agent/knowledge/ask
POST /api/goodvibes-agent/knowledge/search
GET  /api/goodvibes-agent/knowledge/sources
GET  /api/goodvibes-agent/knowledge/nodes
GET  /api/goodvibes-agent/knowledge/issues
GET  /api/goodvibes-agent/knowledge/items/{id}
GET  /api/goodvibes-agent/knowledge/map
GET  /api/goodvibes-agent/knowledge/connectors
GET  /api/goodvibes-agent/knowledge/connectors/{id}
GET  /api/goodvibes-agent/knowledge/connectors/{id}/doctor
POST /api/goodvibes-agent/knowledge/ingest/url
POST /api/goodvibes-agent/knowledge/ingest/urls
POST /api/goodvibes-agent/knowledge/ingest/artifact
POST /api/goodvibes-agent/knowledge/ingest/bookmarks
POST /api/goodvibes-agent/knowledge/ingest/browser-history
POST /api/goodvibes-agent/knowledge/ingest/connector
POST /api/goodvibes-agent/knowledge/reindex
```

If those routes are unavailable, Agent commands fail closed with a structured error. They do not retry against the default knowledge routes or arbitrary knowledge-space selectors.

The CLI and slash-command layers reject route-selection flags such as `--space`, `--knowledge-space`, `--knowledge-space-id`, and `--include-all-spaces` because those would violate the Agent product boundary.

Successful route responses are validated before rendering. Parseable public Agent-route scope aliases are normalized. If a connected host response carries known non-Agent payload markers or unparseable default-scope text, Agent returns a `scope_contamination` error instead of treating that payload as isolated Agent Knowledge.

Agent Knowledge writes are explicit-user-action paths. Slash commands that ingest, import, review issues, reindex, or run consolidation require `--yes`; ask/search/status/list/get/map/connector paths remain read-only.

## Ask and search

Use Agent Workspace -> Knowledge -> Ask Agent Knowledge for source-backed Agent Knowledge answers. `/knowledge ask <query>` and `goodvibes-agent ask <query>` are scriptable equivalents over the same route. Default output is concise:

- answer text or a clear no-match state;
- confidence when present;
- sources, titles, and URLs when returned;
- facts, gaps, and refinement task ids only when the Agent Knowledge route returns them.

`--json` preserves the raw structured Agent route response for tooling after the scope-contamination guard accepts the payload.

The command layer does not turn search results into an answer locally and does not apply client-side filters to hide contamination. It rejects contaminated payloads; the connected host must still return Agent-owned data for the route to succeed.

Use Agent Workspace -> Knowledge -> Search Agent Knowledge for interactive search. `/knowledge search <query>` and `goodvibes-agent search <query>` query the isolated Agent Knowledge search route and render bounded results with title, id, type, score, source, URL, and snippets when available. Empty Agent stores return an explicit empty state.

Read-only inspection is available from the TUI Knowledge workspace first, with CLI equivalents for scripts:

- Source library and review queue in Agent Workspace -> Knowledge.
- `/knowledge list --kind sources|nodes|issues`
- `/knowledge get <id>`
- `/knowledge connectors`
- `/knowledge connectors <connector-id>`
- `/knowledge connectors doctor <connector-id>`
- `/knowledge map`
- `/knowledge packet <task...> [--scope <path> ...]`
- `/knowledge explain <task...> [--scope <path> ...]`

The main assistant conversation can use the read-only `agent_knowledge` tool for the same isolated status, ask, search, source/node/issue list, item lookup, map, connector list, connector detail, and connector doctor workflows.

## Ingest

Use Agent Workspace -> Knowledge for URL, URL-list, file, artifact-id, bookmark, browser-history, connector ingest, issue review, consolidation, and reindex forms. The main assistant conversation can also call the confirmed `agent_knowledge_ingest` tool for URL, file, artifact-id, URL-list, bookmark, browser-history, and connector source families. `/knowledge ingest-url <url> --yes` and `goodvibes-agent knowledge ingest-url <url> --yes` ingest URL sources into Agent Knowledge only.

The TUI workspace exposes the common confirmed ingest, issue-review, consolidation, and reindex flows. The CLI also exposes Agent-specific batch routes for scripts:

- `goodvibes-agent knowledge import-urls <path> --yes`
- `goodvibes-agent knowledge import-bookmarks <path> --yes`
- `goodvibes-agent knowledge import-browser-history --yes`
- `/knowledge review-issue <issueId> <accept|reject|resolve|reopen|edit|forget> --yes`
- `/knowledge consolidate [light|deep] --yes`
- `goodvibes-agent knowledge reindex --yes`

Connected-host ingest and read CLI routes target `/api/goodvibes-agent/knowledge/*`. Workspace and slash-command issue review, packet/explain, consolidation, and reindex flows stay inside the isolated Agent Knowledge service. None of them call default knowledge.

Do not map VIBE.md, project context files, local memory, notes, routines, skills, personas, or default knowledge documents into Agent Knowledge automatically. Durable source-backed facts can be ingested deliberately through Agent routes when the user or an explicit Agent workflow asks for it.

## Artifacts and multimodal

Artifacts are first-class runtime objects for files, images, audio, video, generated outputs, and delegation results. Agent Knowledge use of artifacts must still go through Agent-specific ingest routes when those are available.

The saved artifact browser is available from Agent Workspace -> Artifacts -> Browse artifacts and through `agent_artifacts`. It lists recent uploads, exports, generated media, source artifacts, session artifacts, comparison artifacts, sourced research reports, and exported document drafts with filters for query, kind, MIME type, purpose, and source. `agent_artifacts mode:"show"` inspects one artifact by id with redacted metadata and a bounded preview for text-like content only; binary bytes and inline base64 stay out of the transcript.

Related saved-artifact actions:

- Agent Workspace -> Artifacts -> Export saved artifact copies one reviewed artifact to a workspace file after typed confirmation, preserves exact bytes for text or binary artifacts, and refuses overwrite unless explicitly enabled.
- Agent Workspace -> Artifacts -> Export package copies selected reviewed artifact ids into a workspace package directory or ZIP archive with exact bytes under `artifacts/`, a redacted `manifest.json`, and a README.
- Agent Workspace -> Artifacts -> Attach to document draft links one reviewed saved artifact id to a document without rewriting the body.
- Promote to Knowledge and Documents & Compare -> Promote artifact to Knowledge ingest one reviewed saved artifact id through the isolated Agent Knowledge artifact route after typed confirmation.

Agent Workspace -> Voice & Media -> Generate media creates image/video artifacts through configured media providers after typed confirmation. The main conversation can perform the same confirmed action with the `agent_media_generate` tool when the user explicitly asks for generated media. Generated media output is summarized as artifact ids, MIME types, filenames, and source URLs when present; inline base64 is not printed into the transcript.

The model can use first-class tools for the common route-selection, Knowledge, document, packet preset, packet share, artifact, autonomy, research, model/provider, computer/browser, device/voice, security, media, and comparison workflows; the full tool catalog with a one-line purpose per tool is in [Tools and commands](tools-and-commands.md). `route action:"plan"` maps a plain user request to the preferred visible Agent route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without executing tools.

`agent_documents` creates, revises, reviews, comments on, suggests changes to, lists, shows, attaches saved artifacts to, inserts saved artifacts into, and exports project-scoped versioned markdown drafts as saved artifacts after explicit confirmation for writes. Exports include a reviewer appendix with comment and AI suggestion summaries plus metadata counts for open/resolved comments and proposed/accepted/rejected suggestions.

Suggested changes stay pending until the user accepts or rejects them; acceptance appends a new draft version. Artifact attachment records a reusable artifact reference and export manifest without changing the document body; text artifact insertion adds bounded markdown content to a new draft version; non-text artifact insertion adds a safe reference block without binary bytes or base64.

`agent_review_packet_presets mode:"save"` writes one confirmed local JSON artifact containing reusable document/export/comparison/judgment/route-decision/handoff/archive/related artifact ids; `mode:"list"` and `mode:"show"` inspect saved presets, flag missing or superseded saved ids, and recommend newer matching reuse routes when metadata is sufficient; `mode:"refresh"` saves one new confirmed preset artifact from those freshness recommendations while preserving the source preset and without mutating documents, model routing, handoffs, or archives. `agent_review_packet_share` validates one saved reviewer handoff archive and sends a confirmed plain-text archive reference through a configured channel target without printing or attaching ZIP bytes; exact bytes still move through explicit artifact export/package routes.

`research action:"briefing|plan|search|runner|runs|run|sources|source|bundle|reports|report_artifact"` exposes a read-only next-action queue, read-only planning, bounded public source-candidate search, browser-runner readiness, run/source inspection, reviewed-source bundles, and saved research report artifact inspection; confirmed `research action:"create_run|start_run|checkpoint|pause|resume|cancel|complete|fail|delete_run|add_source|review_source|reject_source|use_source|delete_source|report"` performs one visible research mutation or sourced report save after explicit user request.

`models action:"status|route|local|providers|provider"` exposes read-only model route, local cookbook, provider, and subscription posture; confirmed `models action:"smoke"` performs local server smoke checks through existing confirmation gates. `computer action:"status|plan|control|browser|setup|mcp"` exposes read-only browser/PWA, browser/screenshot/desktop-control planning, repair/setup, and trusted tool discovery posture; confirmed `computer action:"open_browser"` performs the visible browser cockpit handoff through existing confirmation gates.

`device action:"status|capability|voice|provider"` exposes read-only companion/mobile, voice, and provider posture; confirmed `device action:"open_tts_provider|open_tts_voice"` performs visible TTS picker handoffs through existing confirmation gates. `security action:"status|finding|explain"` exposes redacted security posture, exact finding inspection, and read-only policy explanations for why one model action is allowed, denied, or waiting on confirmation.

The lower-level `agent_research_runs`, `agent_research_sources`, `agent_research_report`, `agent_harness mode:"route_decision"`, `agent_harness mode:"research_briefing"`, provider/model, pairing/media posture, security posture, policy explanation, and UI-surface harness modes remain available as detailed compatibility routes over the same local records, artifacts, and route contracts.

`research action:"briefing"` summarizes local run/source/report/browser posture and returns exact follow-up routes without writes. Research run state keeps plan, phase, progress, checkpoints, log tails, source ids, lifecycle controls, and no hidden background execution. `research action:"search"` runs bounded public web research and returns source candidates with exact confirmed `add_source` routes; it never writes the source queue by itself. Research sources keep credibility, score, report-ready source lines, reviewed-source bundle handoff, and review/reject/use state; they never ingest Agent Knowledge or save a report by themselves.

Research reports save one confirmed sourced markdown artifact with a source map, redacted source URLs, source-count metadata, citation coverage metadata, repair hints, optional strict body-citation enforcement, optional `visualReport:true` packet sections, direct `research action:"reports|report_artifact"` inspection, and no inline report content in the transcript.

`agent_artifacts mode:"export"` copies exact saved artifact bytes to a validated workspace path after confirmation and refuses accidental overwrite; `mode:"package"` copies selected saved artifacts into a validated workspace directory with exact bytes, redacted metadata, README, and manifest; `mode:"archive"` writes the same package payload as one ZIP file. `agent_knowledge_ingest` accepts `sourceKind:"artifact"` plus `artifactId` for reviewed saved-artifact promotion.

Blind model comparison can run from a direct prompt or a saved text artifact id, and saves a local JSON artifact with the full prompt, blinded outputs, source artifact metadata, and reveal map while keeping model identities hidden in the transcript until reveal. Saved artifacts can be reopened as blind review boards from Documents & Compare, and from there:

- rendered as side-by-side reviewer views with related document/artifact excerpts
- converted into confirmed judgment artifacts
- summarized as task/document/benchmark-filtered saved preference analytics or synthesized into cross-session preference themes
- exported as local markdown reports
- combined with related document or artifact exports into reviewer handoff artifacts
- compared through split-pane reviewer handoff diffs with section jumps and recent-handoff choices from artifact metadata
- archived as one ZIP artifact with the handoff, source comparison or judgment, related evidence bytes, matching route-decision receipt bytes, README, archive metadata, and redacted manifest
- applied to the main model route only through a separate confirmed winner-update action
- saved as apply-winner or leave-unchanged route-decision receipt artifacts

Documents & Compare shows a chronological review packet timeline across document, comment, suggestion, attachment, export, compare, judgment, route-decision receipt, packet preset, handoff, and archive events plus a read-only review packet wizard for progress, current route hints, backtracking, route-decision guidance, refreshed-preset lineage, final archive review, and the confirmed share route.

Workspace forms show inline reviewer-readiness badges before document export, reviewer handoff/archive, and route-apply actions, and packet-default hints prefill export, handoff/archive, apply, leave-unchanged, save-preset, and share fields from the latest review packet, falling back to saved preset metadata only when live evidence is missing, without bypassing confirmation.

`autonomy` adds ongoing-work route selection plus visible queue and item inspection. Lower-level `agent_harness` adds:

- workspace-action lookup/execution
- compact `modelRoute` hints in `workspace_actions`
- compatibility autonomy modes
- live research run, connected-host task, approval, automation run, and schedule records/log tails
- lower-level research/device/media mode inspection
- `document_ops`/`document_ops_lane` readiness, including review packet timeline with stale preset attention, guided packet wizard progress, refreshed-preset lineage, route-decision receipts, and packet presets/defaults/share handoff and freshness posture
- visible reviewer-readiness preflight for unresolved comments/suggestions/source evidence/comparison reveal/route decisions/handoff evidence
- `sessions`/`session` bookmark and artifact posture
- confirmed slash-command mirrors when a visible workspace route maps to a concrete command

Multimodal outputs should stay in the conversation, artifacts, local notes or memory, or explicit delegation results unless the user explicitly ingests a reviewed source through an Agent Knowledge route. They must not be inserted into default knowledge.

## Related docs

- [Tools and commands](tools-and-commands.md)
- [Getting started](getting-started.md)
- [Release and publishing](release-and-publishing.md)
