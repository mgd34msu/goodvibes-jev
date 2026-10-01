# Execution Strategy v2 — Parallelism-Maximized (target ~15 concurrent agents)

> Historical record from the July 2026 UX overhaul, kept for provenance. It describes a completed effort's internal planning and does not document current behavior; the living docs are the operator guide and architecture pages.

Supersedes the linear phase pipeline in PLAN.md for all remaining work. The agent
concurrency cap is 15 (runtime `agents.max_concurrent`). The goal is to keep
12-15 useful, NON-CONFLICTING agents in flight at all times until work is exhausted.

## Core restructure: kill the Phase 2 bottleneck

The original plan made Phase 2 (App.tsx integration) a hard serial gate blocking
Phases 3b/4/5/6. Fix: build the provider composition as a NEW module
`src/components/shell/AppShell.tsx` (composes ThemeProvider > ErrorBoundary >
ToastProvider+Viewport > CommandProvider > PeekProvider > Router, plus StatusStrip
+ AnnouncerRegion). Then App.tsx's edit shrinks to ~3 lines (`render <AppShell>`
+ adopt `useUrlState` for view switching). Building AppShell is a parallel new-file
task; only the ~3-line App.tsx wire is serial.

Consequence: Phase 3b (chat/* — new files), Phase 4 (per-view files), lint
cleanup, and test backfill all depend only on the committed Phase-1 MODULES, not
on App.tsx being wired. They can run concurrently with the App.tsx wire.

## Fill rule

Maintain a work-queue of independent units. Whenever an agent completes and
independent units remain, immediately launch the next so in-flight count stays
12-15. Never idle a slot while non-conflicting work exists. File-ownership is the
only constraint: two agents never write the same file.

## Batch 1 — Phase-1 closeout + integration prep (~8-10 concurrent)

Running/closing: toast+motion fix->review->commit, routing+peek tests->review->commit,
feedback-primitives review->commit, lint+CI commit (bundled w/ the feedback-primitives package.json).
Launch in parallel (new files, no conflicts):
- A: `src/components/shell/AppShell.tsx` (+ shell.css) — provider composition module.
- B: `src/lib/command-registry-init.ts` — register nav (view switch via useUrlState),
  theme toggle, density toggle, new-chat, open-settings commands.
- C: lint cleanup — `src/lib/**` (~1/3 of the 100 violations).
- D: lint cleanup — `src/components/**`.
- E: lint cleanup — `src/views/**` + root.
- F: test backfill — `src/lib/theme.ts` (theme resolution) via DOM harness.
- G: test backfill — `src/lib/provider-models.ts` gaps / `src/lib/ui-preferences.ts`.

## Batch 2 — Integration + features wide (target 15 concurrent)

- 1 serial: App.tsx/main.tsx wire to <AppShell> + useUrlState view switching (small).
- Phase 3b chat features (5, mostly new chat/* files; serialize edits to ChatView.tsx
  via a single owner if needed):
  - streaming caret + stop control
  - edit/resend/regenerate + response branching/versioning
  - cross-session message search
  - artifacts side-panel (reuse PeekPanel) + DataBlock overflow/scroll fix
  - composer upgrades: inline model menu, slash-commands, drag/paste attachments, optimistic send
- Phase 4 per-view (3, disjoint files): KnowledgeView, ProvidersView, AdminView —
  adopt EmptyState/ErrorState/Skeleton/ErrorBoundary, peek, loading states, pagination, a11y.
- Phase 5 cross-cutting (3, split by area): responsive breakpoints, density application,
  a11y sweep (focus mgmt + aria-live wiring using the feedback-primitive helpers).
- Test backfill (remaining, parallel): per new feature/view as it lands.

## Batch 3 — Review/fix batch + final gate

- One reviewer per completed unit, spawned as units land (parallel, not serial).
- Batch ALL resulting fixes in parallel (disjoint files).
- Phase 6: full `bun run ci` green (test + typecheck + build), coverage, finalize
  CI lint gate (remove continue-on-error once violations are zero).
- Commit each unit at 10/10 on the same branch.

## Hard rules

- Two agents never write the same file in the same wave (file-ownership map per wave).
- Shared hotspots (App.tsx, package.json) have a single owner per wave.
- Reviews/fixes are spawned as work lands, in parallel — never drain one chain serially.
- Keep 12-15 in flight until the queue is empty; only then converge on Phase 6.
