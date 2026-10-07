# Integrating the October 1 platform refresh

The owner asked us to inspect the newly published platform commits, integrate
them, and continue the Jev project to completion. This replaces the temporary
upstream hold. The existing Jev behavior, privacy boundaries, operator authority
and contract runner remain the destination architecture. Upstream UI changes are
the new product-parity target; we are not designing another interface.

The October 3 [autonomous Jev decision contract](autonomous-jev-decisions.md)
supersedes older runtime approval/escalation semantics, including those in
upstream UI descriptions. Preserve provisioning/login and deterministic
authority boundaries while migrating runtime decisions to Jev and outage
waiting to the one shared retry implementation. The [root status](../../README.md#status)
records unfinished admission, grant/revocation and consumer migration; source
parity alone does not prove autonomous execution.

## Exact sources

These are current source commits, not merely release tags. The SDK, daemon, TUI
and agent each contain source changes after their latest version tag.
`docs/inventory/upstream-targets.json` records their full revisions, Git trees,
comparison bases and snapshot locations.

| Repository | Comparison base | Forward target | Commits | Changed paths | Current tracked files |
| --- | --- | --- | ---: | ---: | ---: |
| goodvibes-sdk | `b4192497` (2.0.23 release) | `17eae838` | 24 | 357 | 3858 |
| goodvibes-daemon | `443e5ee4` | `254699bf` | 4 | 41 | 281 |
| goodvibes-tui | `0d69500f` | `ec057c33` | 27 | 1425 | 1573 |
| goodvibes-agent | `9e225a34` | `f05fe636` | 22 | 822 | 1650 |
| goodvibes-webui | `9856cba6` | `dadf5770` | 16 | 537 | 666 |

The SDK release is a comparison reference for the imported 2.0.23 source, not
a new claim that every current engine file is byte-identical to that release.
The engine already contains substantial Jev-specific work. The other bases are
the original product inventories. The WebUI metadata later named `5050483`
(1.13.20), while its inventory still described `9856cba` (1.13.19). Their paths
are identical, but package/schema/settings content differs. That historical
discrepancy is retained here. The applied WebUI source record and partial
workspace now use `dadf577` (2.0.0), with all 666 tracked paths accounted for;
its remaining semantic replacements and full product parity are still open.

The ecosystem index and adjacent app, Home Assistant, plugin, Codex and desktop
repositories were checked. Their latest published source changes predate this
refresh. They remain outside the five-repository port scope. No new product is
silently added because it shares the GoodVibes name.

## What changes in the implementation

### Engine and daemon

Buzz owns deliberate SDK/daemon integration, starting with the shared theme
engine, tree-glyph settings and config exports. Subsequent slices carry over
channel conversational-tool restrictions, context-window provenance and unknown
values, whole-message compaction, turn-notification ownership/deduplication,
process completion state and panel-state cleanup. Upstream worktree reliability
changes must be compared with the Jev runner's existing fixes.

Wholesale source replacement would reintroduce WRFC and semantic heuristics
already removed from Jev. Preserve the new product behavior through the current
contract runner and judgment interfaces. In particular, a conversation channel
must not regain write/edit/exec tools through a follow-up turn.

Daemon setup sources are unchanged across the new target. Existing reviewed
setup fixes can carry forward, while composition and SDK integration continue.
The applied daemon migration record now uses `254699bf`. Its reviewed ledger
accounts for seven added, seven deleted and 27 modified paths, while preserving
86 valid existing mappings and adding three mappings to already-landed wire,
version and adapted contract-lifecycle tests (89 total). The latter preserves
shutdown intent, not a legacy WRFC implementation. Real wire/streaming behavior and channel tool
authority have separate landed evidence. Five native-binary/release/compiled-hosting
acceptance items remain deferred after the emitted CLI-dispatch test was mapped; this accounting advance is not full migration.

### WebUI

Wintermute owns the port at `dadf577`. The redesigned app has four primary
places: Chat, Work, Library and Personal. It introduces a shared shell/UI kit,
settings dialog and responsive list/detail flows. Its 18 SDK import paths and
contract/presentation bridge implementations remain unchanged, so the real
application can be ported against the existing public engine exports before
the independent terminal-oriented SDK work completes.

Retarget imports, build and package tooling to the monorepo. Preserve navigation,
assets, themes, PWA and auth/connection behavior. Reconcile new and removed
inventory paths, including semantic status-tone decisions that moved to shared
helpers. Work and former approval views must render the shared autonomous
contract/gate states and waiting progress, without human semantic approval.

The real workspace, browser-safe theme/payment imports, nullable-context
rendering and pairing-lifetime repair have landed. Synthetic browser and LAN
proof cover the implemented flows. The authenticated palette caller and fixed
status catalogs now include reviewed auth-lifetime guards, while production
authority/reference installation and the dynamic-error caller remain open.
Complete contract/gate actions and connected-daemon/live-provider parity remain
separate completion work. Unknown/null context windows must stay honest, without
invented percentages or model-name-based window guesses.

### TUI

Wintermute owns the port at `ec057c33`. Preserve the new surface kit, themes,
modal host, conversation lane graph, throbber, notifications/history and
full-screen agent/process views. The first coherent milestone is a runnable
shell with startup/first-turn behavior and a contract-tree adapter where work
is shown, followed by complete actions, usage/session persistence and current
built-binary scenarios.

Removing pane state does not remove the existing panel command contract:
`IntegrationHelperService` still uses a `panelManager` adapter to serve
`panels.list/open` and `/api/panels/*` through modals. Preserve this adapter.
New upstream work-tree wiring reads WRFC roles and verdicts; project contract
units and their typed judgments instead. New output/tool inference in the
lane renderer requires explicit semantic decisions, not inherited PORT labels.

### Agent

Wintermute owns the port at `f05fe636`. Preserve the new themes/modal surfaces,
lane graph, full-screen work views, notifications, context/status controls,
isolated delegation and profile/knowledge boundaries. First-start workspace
registration defaults to decline, Escape declines, and the next complete
prompt remains available.

The latest source also fixes cancellation: every tool wrapper forwards the
execution options/AbortSignal through policy, boundary and MCP wrappers.
Verify the real tool registry reaching exec, not only an isolated wrapper.
Preserve the lane UI while replacing newly added WRFC behavior with the Jev
runner. Semantic result/tool/status guesses still need inventoried judgments.

## Source verification

Generate a snapshot from an explicit local Git commit:

```sh
bun packages/engine/scripts/upstream-source-snapshot.ts \
  --source-dir /path/to/goodvibes-webui \
  --commit dadf57700668fe4500b17b0b0b4520715ab25ef4 \
  --snapshot docs/inventory/upstream/webui.json
```

Repeat with `--check` to compare the recorded tree and every path, mode, object
type and object identity with that exact commit. This reads local Git objects;
it does not fetch, run upstream code or trust the checkout's current HEAD.
Snapshots establish source provenance, not product parity or successful live
operation. Normal CI remains independent of external clones and services.

## Completion sequence and ownership

1. THE-58 records immutable targets, corrects the historical WebUI metadata and
   verifies source content rather than file names alone.
2. THE-30 ports the new WebUI while Buzz advances THE-13/THE-18 SDK and daemon
   prerequisites. Coordinate shared manifests and exports before editing them.
3. THE-62 and THE-63 port TUI and Agent through the resulting public seams.
   Every changed/new/deleted source module gets a reasoned disposition; a
   replacement or removed test does not silently erase its behavioral contract.
4. Complete remaining engine judgments, product mappings and connected parity
   under THE-12/13/14, then genuine endpoint calibration and final proof under
   THE-15/35. The persisted failover patch remains preserved and live-gated.

Use coherent reviewed increments and exact-head CI. Keep one published PR per
owner at a time where dependencies allow. Buzz owns branch cleanup. Do not
restore SBOM, arbitrary line limits, coverage quotas, source-spelling checks or
other removed filler infrastructure. Preserve tests that catch actual behavior,
security boundaries, persistence, cancellation and compatibility failures.
