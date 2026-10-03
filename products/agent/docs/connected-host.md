# Connected host

GoodVibes Agent is the autonomous TUI harness for a connected GoodVibes daemon. The package exposes one executable:

```sh
goodvibes-agent
```

The installed command is backed by TypeScript-authored source with a Bun shebang. Package install smoke verifies the executable path:

- `goodvibes-agent --help`
- `goodvibes-agent --version`
- `goodvibes-agent status --json`
- `goodvibes-agent` launches the TUI in a real PTY

## Daemon prerequisite

Connect to a GoodVibes daemon before using daemon-backed features. Agent expects that daemon to expose public operator routes and the isolated Agent Knowledge routes:

```text
http://127.0.0.1:3421
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
POST /api/goodvibes-agent/knowledge/ingest/artifact
POST /api/goodvibes-agent/knowledge/ingest/urls
POST /api/goodvibes-agent/knowledge/ingest/bookmarks
POST /api/goodvibes-agent/knowledge/ingest/browser-history
POST /api/goodvibes-agent/knowledge/ingest/connector
POST /api/goodvibes-agent/knowledge/reindex
```

If the GoodVibes API is on a different host or port, use a one-off override when launching the TUI:

```sh
goodvibes-agent --runtime-url http://127.0.0.1:3421
```

For a persistent shell/session override, set:

```sh
export GOODVIBES_AGENT_RUNTIME_URL=http://127.0.0.1:3421
```

`GOODVIBES_AGENT_BASE_URL` is accepted as a legacy alias. These values select the connected GoodVibes API root.

If the connected host is unavailable, unauthenticated, or incompatible with Agent, the Agent TUI reports actionable diagnostics without printing token values.

Use the TUI first for those checks:

- Agent Workspace -> Home -> Host compatibility
- Agent Workspace -> Home -> Doctor diagnostics
- Agent Workspace -> Home -> Review health

`goodvibes-agent status --json`, `goodvibes-agent doctor`, and `goodvibes-agent compat` are scriptable equivalents for install checks and automation.

## Product boundary

Agent owns the user-facing autonomous harness: terminal renderer, setup, chat, profiles, VIBE.md personality, project context files, local memory/notes/routines/skills/personas, isolated Agent Knowledge calls, companion chat, visible agents, approvals, schedules, automation posture, daemon method access, channel delivery, reminders, and media workflows.

The GoodVibes daemon owns the platform capabilities. Agent exposes those capabilities through the easiest safe user path, with simple first-class tools for common tasks, dynamic operator method discovery for exact contract parity, and confirmation gates for write/admin routes.

The model can inspect this boundary with `host action:"capabilities"`. By default the report is compact: configured base URL, token posture, ownership, mode hints, capability counts, and a short `modelRoute` for the next safe Agent-owned route. Use `includeParameters:true` for full route families, allowed capabilities, blocked capabilities, and first-class Agent tool availability; those expanded rows also carry compact `modelRoute` hints.

Allowed capabilities include read-only operator briefing, explicit allowlisted approval/automation/schedule actions, isolated Agent Knowledge read/ingest, confirmed channel or notification delivery, confirmed reminder schedules, and configured media generation. Blocked capabilities include connected-host lifecycle, listener mutation, default or non-Agent knowledge fallback, hidden background Agent jobs, implicit delegated review, and arbitrary connected-host mutations.

The last of those covers creating routes or accounts *on the daemon*, and is confirmation-gated through `agent_operator_method` rather than refused outright. Signing up for a third-party service is a separate matter and is not blocked: it is authorized, and every account is written to the account register with `accounts action:"record"`.

To inspect one surface without parsing the full report, use `host action:"capability"` with `capabilityId`, `target`, or `query`; capability results return the allowed or blocked route hint. Lower-level `agent_harness` modes `connected_host`, `connected_host_capability`, and `daemon` remain compatibility routes.

The model can inspect the public operator method catalog with `host action:"methods"`. That report is generated from the GoodVibes SDK contract, not a stale hand-maintained shortlist. To inspect one method without parsing the full report, use `host action:"method"` with `methodId`, `target`, or `query`. Execute exact daemon methods with `agent_operator_method`: read-only routes can run directly; write/admin routes require `confirm:true` and `explicitUserRequest`. Lower-level `operator_methods` and `operator_method` remain compatibility routes.

The model can inspect service posture with `host action:"services"`. That report exposes endpoint binding, network-facing posture, issues, and redacted-log diagnostics used by status, doctor, and support bundles. Use `includeParameters:true` when reachability probes and redacted log tail are needed. To inspect one endpoint, use `host action:"service"` with `endpointId`, `target`, or `query`. The valid endpoint ids are:

| Endpoint id | Default port | What it is |
| --- | --- | --- |
| `controlPlane` | 3421 | The runtime connection, the daemon API root Agent connects to |
| `httpListener` | 3422 | The daemon's inbound events endpoint |
| `web` | 3423 | The browser companion route, the URL the connected browser cockpit opens |

The connected browser cockpit/PWA is the visible UI surface `connected-browser-cockpit`; `computer action:"browser"` inspects readiness and `computer action:"open_browser" confirm:true explicitUserRequest:"..."` opens the configured URL through the existing confirmed surface route. `ui_surface surfaceId:"connected-browser-cockpit"` remains available for detailed compatibility inspection and reports Agent workspace category coverage, mobile/PWA control routes, the Agent onboarding marker, and browser/PWA first-run evidence.

Certified SDK/daemon browser/PWA category-route records can make the cockpit `browser-native-ready` only when every Agent workspace category has schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, exact inspect/open routes, and mobile/touch evidence. Certified browser/PWA first-run records add manifest, service-worker, install, and offline evidence with redacted URLs and summaries.

Start/setup readiness can also satisfy the setup checklist from saved durable artifacts or live SDK/daemon setup read models when the connected host publishes them, and reports the gap when no receipt exists. Service lifecycle and listener changes must use setup or confirmed daemon operator methods.

For setup or host repair asks, start with `setup action:"repair"`. It is read-only and chooses the next safe route for the current setup blocker or a named target, choosing between connected-host status, a `services.status` receipt, confirmed token repair, user-run bootstrap commands, or no lifecycle action when the host is already reachable. It does not start, install, restart, write tokens, import settings, or open UI by itself.

Separately from these routes, at boot the Agent starts a host that is installed on this machine but stopped: one start through the platform service manager, a bounded wait for it to answer, and an honest receipt. A running host is never restarted, a held port is left alone, and a host that is not installed keeps this guidance.

The model can inspect live connected-host readiness with `host action:"status"`. That report uses the same status probe as the CLI: it checks the connected-host status route, verifies host compatibility, checks isolated Agent Knowledge when token and compatibility posture allow it, reports endpoint bindings and token posture without printing token values, returns actionable findings, and includes a compact `modelRoute` for follow-up diagnostics. `includeParameters:true` adds route family and capability detail. Lower-level `connected_host_status` and `daemon_status` remain compatibility routes.

The model can inspect companion pairing posture through `device action:"status"` and inspect one pairing/mobile route with `device action:"capability" capabilityId:"..."`. Lower-level `agent_harness` modes `pairing_posture` and `pairing_route` remain available for detailed compatibility. Those routes report the control-plane endpoint binding, pairing surface id, token presence/fingerprint, route catalog, and a companion device capability map for pairing, mobile command routing, browser/PWA, voice/TTS, notifications, browser/desktop control, and camera/screen/location posture without returning raw tokens or QR payloads.

Camera, screen, location, local device command, and wake-word capabilities count as ready only when certified SDK/daemon records publish permission scope, schema/version/publication/publisher/provenance/freshness-cursor/receipt evidence, and exact inspect/control routes. Pairing display, manual token display, companion connection, channel delivery, task, approval, provider/model, attachment, capture, permission repair, and device command actions remain visible user flows.

Agent Knowledge is its own product segment. Agent uses `/api/goodvibes-agent/knowledge/*` only and must not fall back to default knowledge or other product-specific knowledge routes. Agent normalizes public Agent-route scope aliases and rejects successful-looking responses that carry known non-Agent payload markers.

Normal assistant chat can use local tools, visible Agent jobs, daemon automation, shared sessions, delegation, or remote runners. GoodVibes TUI remains the vibecoding harness; Agent should choose it when that UX is best for the user rather than exposing package ownership as friction.
