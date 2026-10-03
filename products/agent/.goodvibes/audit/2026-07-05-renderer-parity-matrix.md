# W4-R1 — Renderer / Input Parity Matrix (agent vs TUI)

**Stage 0 audit — the Wave-4 centerpiece.** Diffs every renderer/input primitive between
`goodvibes-agent` (frozen fork, all `src/renderer` + `src/input` stamped **Jun 13 00:25**) and
`goodvibes-tui` (current reference codebase, named fixes landed 2026-06-30 → 2026-07-05). Each row is
re-verified against live code (reality wins over the plan). This matrix parameterizes W4-R2/R3/R4
and feeds W4-S1.

- agent: `/home/buzzkill/Projects/goodvibes-agent` main @ `c5fa750c`
- tui: `/home/buzzkill/Projects/goodvibes-tui` main @ `736f9218`

**Verdict legend** — PORT (agent lacks a TUI correctness fix; assign a batch) · INTENTIONALLY-DIFFERENT
(deliberate — single-surface/sidebar model, fleet-lessness, agent-only table) · OBSOLETE (neither
repo should carry it — **none surfaced**).

## Totals

| Classification | Count |
|---|---|
| **PORT** | **25** |
| **INTENTIONALLY-DIFFERENT** | **8** |
| **OBSOLETE** | **0** |

**Port batch sizes:** R2 = 8 · R3 = 3 · R4 = 14.

**Disjoint-ownership invariant: HOLDS.** The only intentionally-shared file is `compositor.ts`
(R2 owns its caps/highlight region and lands **first**; R4 owns its tone-read region and rebases —
the pre-ruled serialization). `terminal-escapes.ts` is R2-owned / R3-imported (read, no write);
`terminal-bg-probe.ts` is R2-owned / R4-imported. No file is `owns_file` for two batches.

---

## PORT rows

### R2 — WIDTH-TABLE + CORRUPTION-GUARDS + NOISE-GATE (8)

| Primitive | owns_file | TUI anchor | Agent state | Commit |
|---|---|---|---|---|
| width table (cross family + stripAnsi + joinPrioritizedSegments) | `src/utils/terminal-width.ts` | terminal-width.ts:84-103 (0x2715/0x2716 width-1), :10-42 (stripAnsi), :187-212 (joinPrioritizedSegments) | terminal-width.ts:32-44 stale subset — no cross entries, no stripAnsi, no joinPrioritized; 191 vs 289 lines | b98d3b91, 0ac2eabe |
| prompt-content-width | `src/renderer/prompt-content-width.ts` (NEW) | prompt-content-width.ts:11-16 (floors at 1) | ABSENT | 68bc13c3 |
| terminal-escapes (incl. FOCUS_ENABLE ?1004h) | `src/renderer/terminal-escapes.ts` (NEW) | terminal-escapes.ts:8-21 | ABSENT (mode sequences inlined) | fa860ebd |
| term-caps (probeTermCaps/downsampleColor/wrapSynced) | `src/renderer/term-caps.ts` (NEW) | term-caps.ts (DEC-2026 sync + downsample) | ABSENT (raw truecolor always) | c6eb004c |
| terminal-bg-probe (OSC-11) | `src/renderer/terminal-bg-probe.ts` (NEW) | terminal-bg-probe.ts | ABSENT | fa860ebd |
| **DiffEngine caps-aware color** ⚠ *surfaced by this audit* | `src/renderer/diff.ts` | diff.ts:1-25 (ctor takes caps; downsamples every SGR + wrapSynced) | diff.ts:7 DiffEngine has **no caps ctor** — raw truecolor, no sync wrap | (with c6eb004c) |
| compositor DiffEngine caps wiring + hardcoded search-highlight hex | `src/renderer/compositor.ts` **(shared → R4 rebases)** | compositor.ts:74-78 (`new DiffEngine(this.caps)`), :253-263 (search highlight via `activeTheme()`) | compositor.ts:46 `new DiffEngine()` capless, :150-152 hardcoded `#ffff00`/`#000000`/`#806600`/`#ffffff`, :89 sepFg='238' | — |
| noise-gate classifier + captured-write routing | `src/core/system-message-noise.ts` (NEW) + `src/runtime/terminal-output-guard.ts` + `src/main.ts` route site | system-message-noise.ts:44-65 (classifyNoise emit/drop/foldProviderReplay), :80-87 | terminal-output-guard.ts:227-232 bare 5s debounce → `systemMessageRouter.high`; no classifier; `[Terminal] Captured N …` reaches transcript raw | 43bc4e09 |

*Notes:* The width-table row must **preserve** the agent's local codepoint-progress guard
(terminal-width.ts:151-155). The noise-gate row **absorbs A8 papercut #3** (stdout-capture leak) —
A8 must not also touch `terminal-output-guard.ts`/`main.ts`. Port the TUI noise regexes verbatim;
adapt only the agent `[Terminal] Captured` rule. Dropped noise is **drop-from-transcript, not delete**
(count stays reachable via `/health`/activity log).

### R3 — PASTE / DELETE / FOCUS invariants (3)

| Primitive | owns_file | TUI anchor | Agent state | Commit |
|---|---|---|---|---|
| panel-paste-flood-guard (unbracketed-burst) | `src/input/panel-paste-flood-guard.ts` (NEW) + handler wiring | panel-paste-flood-guard.ts:38-39 (THRESHOLD=8/WINDOW=120ms), :64-86 | ABSENT. Paste plumbing exists (handler.ts:93/:315 pasteRegistry) but no rate guard | 90eb3a26 |
| delete-key-policy | `src/input/delete-key-policy.ts` (NEW) | delete-key-policy.ts | ABSENT | 33033717 (2026-06-11) |
| focus-tracker (OS window focus ?1004h) | `src/core/focus-tracker.ts` (NEW) + ?1004h setup/teardown | focus-tracker.ts:18-41 (honest-null fallback) | ABSENT as OS focus. Agent `indicatorFocused` (handler.ts:90, handler-feed-routes.ts:24) is **internal widget focus, a different concept**. Tokenizer parses `\x1b[I`/`\x1b[O` but nothing consumes them as OS focus | d6b44447 |

*Adaptation:* the TUI flood guard protects **panel hotkeys** via `panelFocused`; the agent has **no
panels**, so the burst instead becomes command/keybinding dispatch — the guard wires above the
composer/command dispatch. Tokenizer-level paste/focus **parsing is already at parity**
(`tokenizer.test.ts` is byte-IDENTICAL) — port only the higher-level guards. focus-tracker is
**net-new behavior**, not a parity restore; ?1004h **must** be disabled on exit. `FOCUS_ENABLE`
converges on R2's `terminal-escapes.ts`.

### R4 — TONE / THEME / LIGHT + WAITING-WORDING (14, consumes S1)

**Core (6, named by the brief):**

| Primitive | owns_file | TUI anchor | Agent state |
|---|---|---|---|
| theme system (resolve/active Theme+UiTones, light palettes) | `src/renderer/theme.ts` (NEW) | theme.ts:80-101/127-148/156-158/203-242/283-305 | ABSENT (no mode dimension) |
| theme-mode-config (display.themeMode + OSC-11) | `src/renderer/theme-mode-config.ts` (NEW) | theme-mode-config.ts:24-67 | ABSENT |
| UI_TONES tone-token table (+chrome/reasoning/…/DIFF_TONES/SPINNER_FRAMES) | `src/renderer/ui-primitives.ts` | ui-primitives.ts:65-138,149-157,160 | ui-primitives.ts:59-94 stale subset (no chrome group) |
| waiting-wording split + THINKING_PHRASES + computeStallInfo | `src/renderer/ui-factory.ts` | ui-factory.ts:554-584, :522-552, :29, :489-510 | ui-factory.ts:308-313 rotating-only; :239-240 disconnected footer token; :281-302 local phrases (identical) |
| thinking block live tone read | `src/renderer/thinking.ts` | thinking.ts:13 (`activeUiTones()`) | thinking.ts:2 static BORDERS/COLORS (illegible on light) |
| STATE_GLYPHS status-glyph map | `src/renderer/status-glyphs.ts` | status-glyphs.ts:18-23 (aliases GLYPHS.status) | status-glyphs.ts:16-21 hardcodes `○` etc. |

**⚠ Theme-read scope expansion (8, surfaced by this audit — NOT in the brief's named files):**

| Primitive | owns_file | TUI reads | Agent state | Priority |
|---|---|---|---|---|
| markdown transcript theme | `src/renderer/markdown.ts` | 5 activeTheme/resolveTheme | 0 (static dark) | **required** (light transcript legibility) |
| tool-call theme | `src/renderer/tool-call.ts` | 3 | 0 | required |
| system-message theme | `src/renderer/system-message.ts` | ≥1 activeTheme | 0 | required |
| process-indicator theme | `src/renderer/process-indicator.ts` | ≥1 | 0 | required (transparent-bg chrome) |
| **conversation-rendering** theme (core transcript renderer) | `src/core/conversation-rendering.ts` | ≥1 activeTheme | 0 | **required — largest blast radius** |
| modal-factory / overlay-box / fullscreen-primitives theme | those 3 files | activeUiTones | 0 | **low** (opaque dark surfaces; dark no-op per theme.ts:112-123) — deferrable without breaking dark parity |

*R4 consumes S1* (TONE_TOKENS/resolveTones/STATUS_GLYPHS/THINKING_PHRASES/waitingPhrase) — do **not**
re-mint locally; grep-gate no local copies. Dark must stay byte-identical. Agent idle/info glyphs
**visibly converge** to the reference (deliberate). The waiting-wording rewrite needs
stall/approval/reconnect **signals** the agent turn loop must surface (port `computeStallInfo`) —
resolve in-brief if the signal is absent.

---

## INTENTIONALLY-DIFFERENT rows (8) — no batch ports these

| Primitive | Reason |
|---|---|
| compositor sidebar-composite path (`SidebarCompositeData` + `forceFullRedraw`) | **Single-surface model.** compositor.ts:20-36,74-129 is a coarse single-sidebar compositor; the TUI `PanelCompositeData` split-pane path is fleet machinery. Only the caps/highlight *region* is a PORT (R2). |
| `panel-composite.ts` (mid-render generation race-guard) | **Fleet multi-panel.** panel-composite.ts:45-84 monkey-patches `Panel.invalidate()` across many panels; the agent has **no `src/panels` dir** and no `PanelManager`. Pre-ruled intentional. |
| `activity-sidebar.ts` + `surface-layout.ts` | The agent's deliberate single-sidebar layout vs the TUI fleet model (fleet-tab-strip/panel-workspace-bar/layout-engine + panels/*). Agent-local engine. |
| markDirty / frame-requesting | **Fleet-lessness** (pre-ruled). Agent uses coarse `forceFullRedraw` (compositor.ts:63-64,194). |
| terminal-width.ts codepoint-progress guard (splitIdx===0, :151-155) | Agent-local hang-prevention guard; the TUI index-based wrapText doesn't need it. **Keep — R2 must not strip it.** |
| `status-token.ts` (buildStatusToken glyph+color) | **Agent-only** (TUI has none). NOT cross-repo duplication → excluded from S1. |
| `tool-labels.ts` (friendly tool-name map) | **Agent-only** (TUI has none) → excluded from S1. |
| `ansi-sanitize.ts` | Already at parity — **byte-IDENTICAL** (`diff -q` confirmed). No action. (`terminal-output-guard.ts` is also already present in the agent; only the noise-gate wiring is R2's delta.) |

## OBSOLETE rows

None surfaced. Every divergence is a PORT, an intentional divergence, or an agent-local module.

---

## W4-S1 presentation-contract candidate list

Genuinely cross-repo duplicated → **hoist** to one pure SDK `platform/presentation` subpath (TUI is
the reference; agent converges via R4):

1. **THINKING_PHRASES** — TUI ui-factory.ts:489-510 vs agent ui-factory.ts:281-302. **Verbatim-identical**
   20-phrase array. Hoist as one constant.
2. **GLYPHS** — TUI ui-primitives.ts:1-58 vs agent :1-57. frame/surface/navigation/meter identical;
   **status group DIVERGES**: agent `idle='○'(U+25CB) info='•'(U+2022)` and **no `warn` key**; TUI
   `idle='◌'(U+25CC) info='○'(U+25CB) warn='⚠'`. S1 picks ONE (TUI reference) → agent idle/info
   visibly converge.
3. **UI_TONES** — TUI ui-primitives.ts:65-138 (+ DIFF_TONES :149-157, SPINNER_FRAMES :160) vs agent
   :59-94 **stale subset** (missing the chrome group, reasoning/empty/footer/border/brand/gradient,
   DIFF_TONES, SPINNER_FRAMES). Hoist canonical shape + `resolveTones(mode)` for light.
4. **STATE_GLYPHS** — TUI status-glyphs.ts:18-23 (aliases `GLYPHS.status.*`) vs agent :16-21
   (**hardcodes** `✓/⚠/✕/○`). Same 4-state map, different mechanism → hoist the
   reconciled single definition.
5. **WAITING_WORDING** (function contract, not a literal table) — extract a typed `WaitingState` +
   pure `waitingPhrase(state, ctx)` from TUI ui-factory.ts:554-584 (+ computeStallInfo :522-552). The
   agent lacks the split (ui-factory.ts:308-313 rotating-only); both renderers call one contract.

**Explicitly EXCLUDE from S1** (agent-only, not shared): `status-token.ts`, `tool-labels.ts`.
Also agent-only: `DEFAULT_PANEL_PALETTE` (polish.ts derivation).

---

## Divergences from the brief (surfaced during re-verification)

1. **`diff.ts` (DiffEngine) needs caps wiring** — the brief's R2 owns-list named the compositor caps
   region but not `diff.ts`; the agent `DiffEngine` has no caps constructor at all, so the
   caps-aware color downsampling + DEC-2026 sync wrap must port into `diff.ts` too. **Appended to R2**
   (render-path, same batch). This is a high-risk row (byte-level differ).
2. **R4 theme scope is materially larger than the brief's named files.** The light-mode system reads
   live theme in `markdown.ts`, `tool-call.ts`, `system-message.ts`, `process-indicator.ts`, and
   `src/core/conversation-rendering.ts` (all static in the agent) — required for light-mode
   *transcript* completeness, plus `modal-factory/overlay-box/fullscreen-primitives` (low priority,
   opaque surfaces). The brief named only ui-primitives/ui-factory/thinking/status-glyphs/theme/
   theme-mode-config/compositor. R4's real blast radius is ~13 files. Recorded as PORT/R4 rows; the
   opaque-surface trio is deferrable without breaking dark parity.
3. **`delete-key-policy.ts` provenance** — its TUI commit (33033717, 2026-06-11) *predates* the
   agent's Jun 13 file stamp, yet the file is absent in the agent. PORT stands; the file simply never
   reached the fork.
4. **Agent "focus" is internal `indicatorFocused`, not OS `?1004h`** — the focus-tracker port is
   net-new behavior, not a parity restore.

## Five highest-risk ports

1. **`compositor.ts` caps wiring (R2)** — changes `DiffEngine` construction on the every-frame render
   hot path; a wrong caps object regresses all rendering. Plus the R2→R4 shared-file serialization.
2. **`diff.ts` caps-aware color downsampling (R2, newly surfaced)** — the DiffEngine is the byte-level
   differ; `downsampleColor`/`wrapSynced` change every emitted escape. A bug corrupts all output.
3. **R4 light-mode theme-read expansion (`conversation-rendering` / `markdown` / `tool-call` /
   `system-message`)** — broad transcript blast radius; static→live conversion must be memoized;
   missing one leaves light mode half-painted / illegible.
4. **focus-tracker + ?1004h teardown (R3)** — must disable ?1004h on exit or the user's shell inherits
   focus-reporting garbage; `FOCUS_ENABLE` is shared with R2.
5. **noise-gate classifier specificity (R2)** — an over-broad classifier swallows real agent lifecycle
   messages; port the TUI regexes verbatim, adapt only the `[Terminal] Captured` rule, and keep
   drop-not-delete honesty.
