# GoodVibes WebUI — Best-in-Class UX Overhaul

> Historical record from the July 2026 UX overhaul, kept for provenance. It describes a completed effort's internal planning and does not document current behavior; the living docs are the operator guide and architecture pages.

Master execution plan. Goal: transform the operator surface into a keyboard-driven,
dark-first operator console. 8 pillars, executed in dependency-ordered phases with
maximal parallelism inside each phase.

## North Star

> A keyboard-driven, dark-first operator console where the daemon's liveness is
> always visible, chat is a world-class AI workspace, and every action is instant,
> reversible, and explained.

## Pillars

1. Command-first interaction (⌘K palette + global shortcuts + cheatsheet)
2. Daemon pulse (persistent status strip: connection, latency, active work, SSE health)
3. Chat as a world-class AI workspace (streaming, branch/edit/regen, artifacts, composer)
4. Spatial model & deep-linking (URL state, slide-over peek)
5. Visual system & theming (token system, dark mode default, density modes)
6. Motion & feedback (toast/undo, purposeful motion, reduced-motion)
7. Empty/loading/error states + onboarding + error boundary
8. Accessibility by construction (keyboard nav, aria-live, focus mgmt)

## Concurrency Strategy: Contract-First Parallelism

Hotspots `src/styles.css` and `src/App.tsx` cannot be edited by parallel agents.
Rules:

- **Only the Foundation workstream edits `src/styles.css`.**
- **Only Integration workstreams edit `src/App.tsx` / `src/main.tsx`.**
- Every other workstream creates **new, self-contained modules** under its own
  directory, styled with the shared token names in `TOKEN-CONTRACT.md`.
- Co-locate component CSS in `src/styles/components/<name>.css` (one file per
  workstream, disjoint) imported by the component; never edit a sibling's file.
- All cross-cutting names (tokens, query keys, event names, route keys) come from
  `TOKEN-CONTRACT.md`. Agents must read it before writing.

Result: 6+ agents run concurrently with zero file contention; hotspots are
serialized into Foundation (start) and Integration (after modules land).

## Phases & Workstreams

### PHASE 0 — Foundation (solo; owns styles.css)
- F1: `src/styles/tokens.css` (new) — full semantic token system per contract
  (color light+dark via `[data-theme]`, space, radius, type, elevation, motion, z, layout).
- F1: Refactor `src/styles.css` to consume tokens; add dark theme, density modes,
  `prefers-reduced-motion`, `prefers-color-scheme` bootstrap.
- F1: `src/lib/theme.ts` + `src/hooks/useTheme.ts` + `ThemeProvider` (new) — theme
  + density state, persisted via existing ui-preferences pattern. Does NOT edit App.tsx.
- Checkpoint commit: `feat(ux): design token system + dark mode foundation`

### PHASE 1 — Parallel module build (6 agents; new files only, no styles.css/App.tsx)
- Command system: `src/components/command/*`, `src/lib/commands.ts`,
  `src/hooks/useHotkeys.ts`, cheatsheet overlay, `src/styles/components/command.css`.
- Daemon pulse: `src/hooks/useDaemonHealth.ts`, `src/lib/daemon-health.ts`,
  `src/components/status/*`, `src/styles/components/status.css`.
- Toast + motion: `src/components/toast/*`, `src/lib/toast.ts`,
  `src/components/motion/*`, `src/styles/components/toast.css`.
- Routing + peek: `src/lib/router.ts`, `src/hooks/useUrlState.ts`,
  `src/components/peek/*`, `src/styles/components/peek.css`.
- Feedback primitives: `src/components/feedback/*` (ErrorBoundary, Skeleton,
  EmptyState, ErrorState, Onboarding), `src/styles/components/feedback.css`.
- Shortcut cheatsheet content + a11y helpers (folds into above as capacity allows)
  `src/lib/a11y.ts`, `src/hooks/useFocusTrap.ts`, `src/hooks/useAnnouncer.ts`.
- Checkpoint commit per merged workstream.

### PHASE 2 — Shell integration (solo; owns App.tsx + main.tsx)
- Mount ThemeProvider, ToastProvider, Router, CommandPalette, StatusStrip,
  top-level ErrorBoundary. Wire global hotkeys + URL state into view switching.
- Checkpoint commit: `feat(ux): integrate console shell (theme, palette, status, router)`

### PHASE 3 — Chat workspace
- 3a (solo): decompose `ChatView.tsx` into `src/views/chat/*` (Composer, MessageList,
  MessageItem, SessionHeader, etc.) — mechanical extraction, behavior-preserving.
- 3b (parallel, one file-set each): streaming caret + stop; edit/resend/regenerate/branch;
  cross-session search; artifacts/peek panel + DataBlock overflow; composer upgrades
  (inline model menu, slash, drag/paste attachments, optimistic send).
- Checkpoint commits per feature.

### PHASE 4 — Per-view polish (parallel; one agent per view = disjoint files)
- KnowledgeView, ProvidersView, AdminView: loading/empty/error states, peek
  integration, pagination/load-more, a11y, onboarding.
- Checkpoint commits per view.

### PHASE 5 — Cross-cutting (parallel where files differ)
- Full a11y pass, responsive/mobile breakpoints, density application across views.

### PHASE 6 — Tests & hardening
- Component/integration tests per area (tester agents), `bun run ci` green.

## Dependency Order

PHASE 0 → PHASE 1 (parallel) → PHASE 2 → PHASE 3a → PHASE 3b (parallel)
→ PHASE 4 (parallel) → PHASE 5 (parallel) → PHASE 6.

Phase 1 may start the moment Phase 0's `tokens.css` token NAMES are fixed (the
contract), even before Foundation finishes refactoring styles.css — because Phase 1
agents only reference token names, never edit styles.css.

## Validation & WRFC

- WRFC review threshold: 10/10. Runtime engine drives review/fix cycles via directives.
- Each workstream must pass `bun run typecheck` before completion.
- Commit at every phase/workstream boundary (checkpoint_frequency: per_phase).
- Final gate: `bun run ci` (test + typecheck + build) green.
